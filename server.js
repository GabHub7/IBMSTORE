'use strict';
require('dotenv').config();

const express = require('express');
const expressLayouts = require('express-ejs-layouts');
const cookieParser = require('cookie-parser');
const multer = require('multer');
const path = require('path');
const crypto = require('crypto');

const db = require('./lib/db');
const auth = require('./lib/auth');
const pakasir = require('./lib/pakasir');
const {
  toCleanString, toArray, generateInvoiceId, generateOrderId,
  getPricingOptions, applyPricingOptions, parsePricingOptionsInput,
  normalizeProduct, normalizeSettings, uuidv4
} = require('./lib/helpers');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('layout', 'layout');
app.set('trust proxy', 1);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(expressLayouts);
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = ['image/jpeg','image/jpg','image/png','image/gif','image/webp'].includes(file.mimetype);
    cb(ok ? null : new Error('Hanya file gambar yang diizinkan'), ok);
  }
});

const qrRateLimit = new Map();
const reviewRateLimit = new Map();
const checkPaymentRateLimit = new Map();
const QR_RATE_WINDOW = 60000, QR_RATE_LIMIT = 30;
const REVIEW_RATE_LIMIT = 5, REVIEW_RATE_WINDOW = 60000;
const CHECK_COOLDOWN = 5000;

function checkQrLimit(ip) {
  const now = Date.now();
  const rec = (qrRateLimit.get(ip) || []).filter(t => t > now - QR_RATE_WINDOW);
  if (rec.length >= QR_RATE_LIMIT) return false;
  rec.push(now); qrRateLimit.set(ip, rec); return true;
}
function checkReviewLimit(ip) {
  const now = Date.now();
  const rec = (reviewRateLimit.get(ip) || []).filter(t => t > now - REVIEW_RATE_WINDOW);
  if (rec.length >= REVIEW_RATE_LIMIT) return false;
  rec.push(now); reviewRateLimit.set(ip, rec); return true;
}
function checkPaymentLimit(key) {
  const last = checkPaymentRateLimit.get(key);
  if (last && Date.now() - last < CHECK_COOLDOWN) return Math.ceil((CHECK_COOLDOWN - (Date.now() - last)) / 1000);
  checkPaymentRateLimit.set(key, Date.now()); return 0;
}

app.use(auth.authMiddleware);

app.use(async (req, res, next) => {
  try {
    const raw = await db.getSettings();
    res.locals.settings = normalizeSettings(raw);
  } catch {
    res.locals.settings = normalizeSettings({});
  }
  res.locals.currentPath = req.path;
  res.locals.maintenanceMode = false;
  next();
});

// HOME
app.get('/', async (req, res) => {
  try {
    const settings = res.locals.settings;
    const products = await db.getActiveProducts();
    const banners = (settings.banners || []).filter(b => b.active);
    const productsWithReviews = await Promise.all(products.map(async p => {
      const { reviews, stats: reviewStats } = await db.getReviewsWithStats(p.id, 10);
      return { ...normalizeProduct(p), reviewStats, reviews };
    }));
    res.render('pages/home', { products: productsWithReviews, banners, settings });
  } catch (e) {
    console.error('[HOME]', e.message);
    res.render('pages/home', { products: [], banners: [], settings: res.locals.settings });
  }
});

// AUTH
app.get('/admin-login', (req, res) => {
  if (auth.isAdminReq(req)) return res.redirect('/admin');
  res.render('pages/admin-login', { error: null });
});
app.post('/admin-login', async (req, res) => {
  const { username, password } = req.body;
  const creds = res.locals.settings.adminCredentials || {};
  if (username === creds.username && auth.checkPassword(password, creds.password)) {
    auth.setAuthCookie(res, auth.signAdminToken());
    return res.redirect('/admin');
  }
  res.render('pages/admin-login', { error: 'Username atau password salah' });
});
app.get('/logout', (req, res) => { auth.clearAuthCookie(res); res.redirect('/'); });

// BUY
app.get('/buy/:id', async (req, res) => {
  try {
    const product = normalizeProduct(await db.getProductById(req.params.id));
    if (!product || product.status !== 'active') return res.redirect('/');
    const { reviews: productReviews, stats: reviewStats } = await db.getReviewsWithStats(product.id);
    res.render('pages/buy', { product, settings: res.locals.settings, error: null, reviewStats, productReviews });
  } catch { res.redirect('/'); }
});

app.post('/buy/:id', async (req, res) => {
  const { duration, voucher, paymentMethod } = req.body;
  const settings = res.locals.settings;
  let product;
  try { product = normalizeProduct(await db.getProductById(req.params.id)); } catch { return res.redirect('/'); }
  if (!product || product.status !== 'active') return res.redirect('/');

  const renderErr = async (error) => {
    const { reviews: productReviews, stats: reviewStats } = await db.getReviewsWithStats(product.id);
    return res.render('pages/buy', { product, settings, error, reviewStats, productReviews });
  };

  if (!duration || !paymentMethod) return renderErr('Data pembayaran tidak valid.');

  const selectedDays = parseInt(duration, 10);
  const ip = req.ip || 'guest';
  const txKey = `${ip}:${product.id}:${selectedDays}`;

  if (await db.hasPendingTransaction(txKey)) return renderErr('Anda sudah punya transaksi pending untuk produk ini.');

  const pricingOptions = getPricingOptions(product);
  const selectedOption = pricingOptions.find(o => o.days === selectedDays) || pricingOptions[0] || { days: 1, price: 0 };
  const price = selectedOption?.price || 0;
  const durationLabel = `${selectedOption?.days || 1} Hari`;

  let discount = 0, voucherData = null;
  if (voucher) {
    const v = (settings.vouchers || []).find(v => v.code === voucher.toUpperCase() && v.active);
    if (v) {
      const limitVal = v.limitValue !== undefined ? v.limitValue : (v.minPurchase || 0);
      const limitOk = (v.limitType || 'minimum') === 'maximum' ? price <= limitVal : price >= limitVal;
      if (limitOk) {
        discount = v.discountType === 'nominal' ? Math.min(v.discountValue || 0, price) : Math.round(price * ((v.discountValue !== undefined ? v.discountValue : (v.discountPercent || 0)) / 100));
        voucherData = v;
      }
    }
  }
  const finalPrice = price - discount;

  if ((await db.getAvailableKeyCount(product.id, selectedDays)) <= 0) return renderErr('Stok untuk durasi ini sudah habis.');

  if (finalPrice > 0 && paymentMethod === 'qris') {
    if (!checkQrLimit(ip)) return renderErr('Terlalu banyak request. Tunggu sebentar.');
    const pak = settings.pakasir || {};
    if (!pak.apiKey || !pak.project) return renderErr('Pembayaran QRIS belum dikonfigurasi admin.');
    try {
      const orderId = generateOrderId();
      const invoiceId = generateInvoiceId();
      const { paymentNumber, totalPayment } = await pakasir.createPayment({ apiKey: pak.apiKey, project: pak.project, orderId, amount: finalPrice });
      const tx = await db.insertTransaction({
        id: uuidv4(), transactionKey: txKey, productId: product.id, productName: product.name,
        productImage: product.image, duration: durationLabel, selectedDays, price: finalPrice,
        originalPrice: price, discount, voucherCode: voucher || null, voucherData, key: '',
        invoiceId, status: 'pending', paymentMethod: 'qris', paymentRef: orderId,
        paymentQr: paymentNumber, totalPayment, createdAt: new Date().toISOString(),
        expiredAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(), checkCount: 0
      });
      return res.render('pages/buy-success', { transaction: tx, product, settings, pendingPayment: true, paymentQr: paymentNumber, totalPayment });
    } catch (e) {
      console.error('[BUY QRIS]', e.message);
      return renderErr('Gagal membuat pembayaran QRIS. Coba lagi.');
    }
  }

  try {
    const keyResult = await db.allocateKey(product.id, selectedDays);
    if (!keyResult.success) return renderErr(keyResult.error || 'Stok habis.');
    const invoiceId = generateInvoiceId();
    const tx = await db.insertTransaction({
      id: uuidv4(), transactionKey: txKey, productId: product.id, productName: product.name,
      productImage: product.image, duration: durationLabel, selectedDays, price: finalPrice,
      originalPrice: price, discount, voucherCode: voucher || null, voucherData,
      key: keyResult.key, invoiceId, status: 'completed',
      paymentMethod: finalPrice > 0 ? 'manual' : 'free',
      createdAt: new Date().toISOString(), paidAt: new Date().toISOString()
    });
    await db.confirmKey(product.id, keyResult.key).catch(() => {});
    await db.incrementSold(product.id).catch(() => {});
    return res.render('pages/buy-success', { transaction: tx, product, settings });
  } catch (e) {
    console.error('[BUY FREE]', e.message);
    return res.redirect('/');
  }
});

// PAYMENT CHECK
app.post('/check-payment/:refId', async (req, res) => {
  const wait = checkPaymentLimit(req.params.refId);
  if (wait > 0) return res.json({ success: false, status: 'rate_limited', message: `Tunggu ${wait} detik.` });
  try {
    const result = await performPaymentCheck(req.params.refId, res.locals.settings);
    res.json(result);
  } catch (e) {
    res.json({ success: false, status: 'api_error', message: e.message });
  }
});

async function performPaymentCheck(refId, settings) {
  const tx = await db.getTransactionByRef(refId);
  if (!tx) return { success: false, status: 'not_found', message: 'Transaksi tidak ditemukan' };
  if (tx.status === 'completed' || tx.status === 'success') return { success: true, status: 'completed', key: tx.key, invoiceId: tx.invoiceId };
  if (tx.status === 'expired' || tx.status === 'cancelled') return { success: false, status: tx.status, message: `Pembayaran ${tx.status}` };
  if (tx.expiredAt && new Date(tx.expiredAt) < new Date()) {
    await db.updateTransaction(tx.id, { status: 'expired' });
    if (tx.key) await db.releaseKey(tx.productId, tx.key).catch(() => {});
    return { success: false, status: 'expired', message: 'Pembayaran kadaluarsa' };
  }
  const pak = settings.pakasir || {};
  if (!pak.apiKey || !pak.project) return { success: false, status: 'not_configured', message: 'Pembayaran belum dikonfigurasi.' };
  const status = await pakasir.checkStatus({ apiKey: pak.apiKey, project: pak.project, orderId: refId, amount: tx.totalPayment || tx.price });
  if (pakasir.isExpired(status)) {
    await db.updateTransaction(tx.id, { status: 'expired' });
    if (tx.key) await db.releaseKey(tx.productId, tx.key).catch(() => {});
    return { success: false, status: 'expired', message: 'Pembayaran kadaluarsa' };
  }
  if (pakasir.isSuccess(status)) {
    let key = tx.key;
    if (!key) {
      const kr = await db.allocateKey(tx.productId, tx.selectedDays);
      if (!kr.success) {
        // Stok habis saat payment sukses — tandai perlu review manual
        await db.updateTransaction(tx.id, { status: 'pending', lastCheckAt: new Date().toISOString(), checkCount: (tx.checkCount || 0) + 1 });
        return { success: false, status: 'out_of_stock', message: 'Pembayaran diterima tapi stok habis. Hubungi admin.' };
      }
      key = kr.key;
    }
    await db.updateTransaction(tx.id, { status: 'success', key, paidAt: new Date().toISOString() });
    await db.confirmKey(tx.productId, key).catch(() => {});
    await db.incrementSold(tx.productId).catch(() => {});
    return { success: true, status: 'success', key, invoiceId: tx.invoiceId };
  }
  await db.updateTransaction(tx.id, { lastCheckAt: new Date().toISOString(), checkCount: (tx.checkCount || 0) + 1 });
  return { success: false, status: 'pending', message: 'Menunggu pembayaran...', invoiceId: tx.invoiceId };
}

app.post('/cancel-payment/:refId', async (req, res) => {
  try {
    const tx = await db.getTransactionByRef(req.params.refId);
    if (!tx) return res.json({ success: false, message: 'Transaksi tidak ditemukan' });
    if (tx.status !== 'pending') return res.json({ success: false, message: 'Hanya pending yang bisa dibatalkan' });
    await db.updateTransaction(tx.id, { status: 'cancelled' });
    if (tx.key) await db.releaseKey(tx.productId, tx.key).catch(() => {});
    return res.json({ success: true, message: 'Pembayaran berhasil dibatalkan' });
  } catch (e) { return res.json({ success: false, message: e.message }); }
});

// WEBHOOK
app.post('/api/pakasir/webhook', async (req, res) => {
  const settings = res.locals.settings;
  if (!settings.pakasir?.webhookEnabled) return res.json({ received: true, processed: false });
  const { order_id, status, payment_status } = req.body;
  if (!order_id) return res.status(400).json({ error: 'order_id required' });
  try {
    const tx = await db.getTransactionByRef(order_id);
    if (!tx) return res.json({ received: true, processed: false, reason: 'not_found' });
    if (tx.status !== 'pending') return res.json({ received: true, processed: true, reason: 'already_processed' });
    const sl = (status || payment_status || '').toLowerCase();
    if (pakasir.isSuccess(sl)) {
      let key = tx.key;
      if (!key) {
        const kr = await db.allocateKey(tx.productId, tx.selectedDays);
        if (!kr.success) {
          await db.updateTransaction(tx.id, { lastCheckAt: new Date().toISOString() });
          return res.json({ received: true, processed: false, reason: 'out_of_stock' });
        }
        key = kr.key;
      }
      await db.updateTransaction(tx.id, { status: 'success', key, paidAt: new Date().toISOString() });
      await db.confirmKey(tx.productId, key).catch(() => {});
      await db.incrementSold(tx.productId).catch(() => {});
      return res.json({ received: true, processed: true, status: 'success', key });
    }
    if (pakasir.isExpired(sl)) {
      await db.updateTransaction(tx.id, { status: 'expired' });
      if (tx.key) await db.releaseKey(tx.productId, tx.key).catch(() => {});
      return res.json({ received: true, processed: true, status: 'expired' });
    }
    return res.json({ received: true, processed: false, reason: 'pending' });
  } catch (e) { return res.status(500).json({ error: e.message }); }
});

// INVOICE
app.get('/invoice', async (req, res) => {
  const q = (req.query.q || '').trim();
  const settings = res.locals.settings;
  if (!q) return res.render('pages/invoice', { transactions: [], searchQuery: '', isSpecific: false, pendingCount: 0, pendingRefs: [], settings });
  try {
    const all = await db.getTransactionByInvoice(q);
    const pendingRefs = all.filter(t => t.status === 'pending').map(t => t.paymentRef).filter(Boolean);
    res.render('pages/invoice', { transactions: all, searchQuery: q, isSpecific: true, pendingCount: pendingRefs.length, pendingRefs, settings });
  } catch { res.render('pages/invoice', { transactions: [], searchQuery: q, isSpecific: true, pendingCount: 0, pendingRefs: [], settings }); }
});
app.get('/invoice/:id', (req, res) => res.redirect('/invoice?q=' + encodeURIComponent(req.params.id)));

app.get('/api/invoice-history', async (req, res) => {
  const ids = req.query.ids ? req.query.ids.split(',') : [];
  if (!ids.length) return res.json({ invoices: [] });
  try {
    const results = (await Promise.all(ids.map(id => db.getTransactionByInvoice(id)))).flat();
    res.json({ invoices: results.map(t => ({ invoiceId: t.invoiceId, productName: t.productName, duration: t.duration, key: (t.status === 'completed' || t.status === 'success') ? t.key : null, status: t.status, paidAt: t.paidAt || null, createdAt: t.createdAt })) });
  } catch { res.json({ invoices: [] }); }
});

// STATIC
app.get('/cara-beli', (req, res) => res.render('pages/cara-beli', { settings: res.locals.settings }));
app.get('/faq', (req, res) => res.render('pages/faq', { settings: res.locals.settings }));
app.get('/syarat-ketentuan', (req, res) => res.render('pages/syarat-ketentuan', { settings: res.locals.settings }));
app.get('/maintenance', (req, res) => { res.locals.layout = false; res.render('pages/maintenance', { isAdmin: false }); });

// API
app.get('/api/products', async (req, res) => { res.json(await db.getProducts().catch(() => [])); });
app.get('/api/vouchers/validate/:code', (req, res) => {
  const v = (res.locals.settings.vouchers || []).find(v => v.code === req.params.code.toUpperCase() && v.active);
  if (v) res.json({ valid: true, discountType: v.discountType || 'persen', discountValue: v.discountValue !== undefined ? v.discountValue : (v.discountPercent || 0), limitType: v.limitType || 'minimum', limitValue: v.limitValue !== undefined ? v.limitValue : (v.minPurchase || 0) });
  else res.json({ valid: false });
});
app.get('/api/reviews/:productId', async (req, res) => {
  try { res.json({ reviews: await db.getReviewsByProduct(req.params.productId), stats: await db.getReviewStats(req.params.productId) }); }
  catch { res.json({ reviews: [], stats: {} }); }
});
app.post('/api/reviews', async (req, res) => {
  const ip = req.ip || 'unknown';
  if (!checkReviewLimit(ip)) return res.status(429).json({ error: 'Terlalu banyak review. Tunggu 1 menit.' });
  const { productId, rating, comment } = req.body;
  if (!rating || rating < 1 || rating > 5) return res.status(400).json({ error: 'Rating harus 1-5' });
  if (!comment || !comment.trim()) return res.status(400).json({ error: 'Komentar tidak boleh kosong' });
  if (comment.trim().length > 500) return res.status(400).json({ error: 'Komentar maks 500 karakter' });
  try {
    const review = { id: uuidv4(), productId, guestId: ip, username: 'Guest', rating: parseInt(rating), comment: comment.trim(), createdAt: new Date().toISOString() };
    await db.insertReview(review);
    res.json({ success: true, review, stats: await db.getReviewStats(productId) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/reviews/:id', auth.requireAdmin, async (req, res) => {
  try { await db.deleteReview(req.params.id); res.json({ success: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// QR
app.get('/qr/:code', async (req, res) => {
  const QRCode = require('qrcode');
  let code; try { code = decodeURIComponent(req.params.code); } catch { code = req.params.code; }
  if (!code) return res.status(400).send('Invalid');
  try {
    const buf = await QRCode.toBuffer(code, { type: 'png', width: 300, margin: 2, errorCorrectionLevel: 'M' });
    res.setHeader('Content-Type', 'image/png'); res.setHeader('Cache-Control', 'public, max-age=300'); res.send(buf);
  } catch { res.status(500).send('QR error'); }
});

// ADMIN
app.get('/admin', auth.requireAdmin, async (req, res) => {
  try {
    const [products, transactions] = await Promise.all([db.getProducts(), db.getTransactions()]);
    let categorySuccess = null;
    if (req.query.success === 'added' && req.query.label) categorySuccess = `Kategori "${decodeURIComponent(req.query.label)}" berhasil ditambahkan!`;
    else if (req.query.success === 'deleted') categorySuccess = 'Kategori berhasil dihapus.';
    res.render('pages/admin', { products: products.map(normalizeProduct), transactions, settings: res.locals.settings, users: [], user: res.locals.user, error: null, broadcastSuccess: null, categorySuccess, maintenanceMode: false });
  } catch (e) { console.error('[ADMIN]', e.message); res.redirect('/'); }
});

app.post('/admin/products', auth.requireAdmin, upload.single('image'), async (req, res) => {
  try {
    const { name, category, description, status, keys, pricingDays, pricingPrices, newCategory } = req.body;
    const settings = res.locals.settings;
    let finalCategory = toCleanString(category);
    if (category === '__new__' && newCategory) {
      const slug = toCleanString(newCategory).toLowerCase().replace(/\s+/g,'-').replace(/[^a-z0-9-]/g,'');
      if (slug && !(settings.categories||[]).includes(slug)) { settings.categories = [...(settings.categories||[]), slug]; await db.saveSettings(settings); }
      finalCategory = slug || finalCategory;
    }
    let imageUrl = '/images/placeholder.jpg';
    if (req.file) { const fn = `${Date.now()}-${uuidv4()}${path.extname(req.file.originalname)}`; imageUrl = await db.uploadImage(req.file.buffer, fn, req.file.mimetype); }
    const np = { id: uuidv4(), name: toCleanString(name), category: finalCategory, description: description||'', image: imageUrl, status: status==='active'?'active':'inactive', keys: keys?keys.split('\n').map(k=>k.trim()).filter(k=>k):[], reservedKeys:[], sold:0, createdAt: new Date().toISOString() };
    applyPricingOptions(np, parsePricingOptionsInput(pricingDays, pricingPrices));
    await db.insertProduct(np);
    res.redirect('/admin');
  } catch (e) { console.error('[ADMIN ADD PROD]', e.message); res.redirect('/admin'); }
});

app.post('/admin/products/:id', auth.requireAdmin, upload.single('image'), async (req, res) => {
  try {
    const { name, category, description, status, keys, pricingDays, pricingPrices, newCategory } = req.body;
    const settings = res.locals.settings;
    let finalCategory = toCleanString(category);
    if (category === '__new__' && newCategory) {
      const slug = toCleanString(newCategory).toLowerCase().replace(/\s+/g,'-').replace(/[^a-z0-9-]/g,'');
      if (slug && !(settings.categories||[]).includes(slug)) { settings.categories = [...(settings.categories||[]), slug]; await db.saveSettings(settings); finalCategory = slug; }
    }
    const existing = await db.getProductById(req.params.id);
    if (!existing) return res.redirect('/admin');
    const updates = { name: toCleanString(name), category: finalCategory, description: description||'', status: status==='active'?'active':'inactive', keys: keys?keys.split('\n').map(k=>k.trim()).filter(k=>k):[], reservedKeys: existing.reservedKeys||[] };
    applyPricingOptions(updates, parsePricingOptionsInput(pricingDays, pricingPrices));
    if (req.file) { const fn = `${Date.now()}-${uuidv4()}${path.extname(req.file.originalname)}`; updates.image = await db.uploadImage(req.file.buffer, fn, req.file.mimetype); await db.deleteImage(existing.image); }
    await db.updateProduct(req.params.id, updates);
    res.redirect('/admin');
  } catch (e) { console.error('[ADMIN EDIT PROD]', e.message); res.redirect('/admin'); }
});

app.post('/admin/products/:id/toggle', auth.requireAdmin, async (req, res) => {
  try { const p = await db.getProductById(req.params.id); if (p) await db.updateProduct(req.params.id, { status: p.status==='active'?'inactive':'active' }); res.redirect('/admin'); } catch { res.redirect('/admin'); }
});
app.post('/admin/products/:id/delete', auth.requireAdmin, async (req, res) => {
  try { const p = await db.getProductById(req.params.id); if (p) await db.deleteImage(p.image); await db.deleteProduct(req.params.id); res.redirect('/admin'); } catch { res.redirect('/admin'); }
});

app.post('/admin/transactions/:id/status', auth.requireAdmin, async (req, res) => {
  try {
    const { status } = req.body;
    const tx = await db.getTransactionById(req.params.id);
    if (!tx) return res.redirect('/admin');
    const updates = { status };
    if (status === 'completed' || status === 'success') {
      let key = tx.key;
      if (!key) {
        const kr = await db.allocateKey(tx.productId, tx.selectedDays);
        if (!kr.success) return res.redirect('/admin?error=out_of_stock');
        key = kr.key;
      }
      updates.key = key; updates.paidAt = new Date().toISOString(); updates.status = 'success';
      await db.incrementSold(tx.productId).catch(() => {});
    } else if (status === 'cancelled' || status === 'expired') {
      if (tx.key) await db.releaseKey(tx.productId, tx.key).catch(() => {});
    }
    await db.updateTransaction(tx.id, updates);
    res.redirect('/admin');
  } catch { res.redirect('/admin'); }
});

app.post('/admin/settings', auth.requireAdmin, async (req, res) => {
  try {
    const { whatsapp, telegram, email, siteName, gamePanelName, section, about, faq, marqueeText } = req.body;
    const s = res.locals.settings;
    if (section==='about') s.about = toCleanString(about||'');
    else if (section==='faq') s.faq = toCleanString(faq||'');
    else if (section==='marquee') s.marqueeText = toCleanString(marqueeText||'');
    else { s.contact = { whatsapp: whatsapp!==undefined?toCleanString(whatsapp):s.contact.whatsapp, telegram: telegram!==undefined?toCleanString(telegram):s.contact.telegram, email: email!==undefined?toCleanString(email):s.contact.email }; s.siteName = toCleanString(siteName,'IBM STORE')||'IBM STORE'; s.gamePanelName = toCleanString(gamePanelName,'IBM STORE')||'IBM STORE'; }
    await db.saveSettings(s);
    res.redirect('/admin');
  } catch { res.redirect('/admin'); }
});

app.post('/admin/pakasir', auth.requireAdmin, async (req, res) => {
  try {
    const { apiKey, project, mode, autoCheckEnabled, webhookEnabled } = req.body;
    const s = res.locals.settings;
    s.pakasir = { apiKey: toCleanString(apiKey), project: toCleanString(project), mode: mode==='sandbox'?'sandbox':'production', autoCheckEnabled: autoCheckEnabled==='true'||autoCheckEnabled===true, webhookEnabled: webhookEnabled==='true'||webhookEnabled===true };
    await db.saveSettings(s);
    res.redirect('/admin');
  } catch { res.redirect('/admin'); }
});

app.post('/admin/vouchers', auth.requireAdmin, async (req, res) => {
  try {
    const { code, discountType, discountValue, limitType, limitValue, active } = req.body;
    const s = res.locals.settings;
    if (!s.vouchers) s.vouchers = [];
    const vd = { code: code.toUpperCase(), discountType: discountType||'persen', discountValue: parseInt(discountValue)||0, limitType: limitType||'minimum', limitValue: parseInt(limitValue)||0, active: true };
    const idx = s.vouchers.findIndex(v => v.code===vd.code);
    if (idx!==-1) { vd.active=active==='true'; s.vouchers[idx]=vd; } else s.vouchers.push(vd);
    await db.saveSettings(s);
    res.redirect('/admin');
  } catch { res.redirect('/admin'); }
});
app.post('/admin/vouchers/:code/delete', auth.requireAdmin, async (req, res) => {
  try { const s=res.locals.settings; s.vouchers=(s.vouchers||[]).filter(v=>v.code!==req.params.code); await db.saveSettings(s); res.redirect('/admin'); } catch { res.redirect('/admin'); }
});

app.post('/admin/categories', auth.requireAdmin, async (req, res) => {
  try {
    const { categoryName, categoryLabel } = req.body;
    const s = res.locals.settings;
    const slug = (categoryName?.trim()||categoryLabel||'').toLowerCase().replace(/\s+/g,'-').replace(/[^a-z0-9-]/g,'').replace(/-+/g,'-').replace(/^-|-$/g,'');
    if (!slug) return res.redirect('/admin?tab=categories&error=slug_empty');
    if (['freefire','mlbb','pubg'].includes(slug)) return res.redirect('/admin?tab=categories&error=default_cat');
    if (!s.categories) s.categories=[];
    if (!s.categoryLabels) s.categoryLabels={};
    if (s.categories.includes(slug)) return res.redirect('/admin?tab=categories&error=duplicate');
    s.categories.push(slug);
    const label = categoryLabel?.trim()||(slug.charAt(0).toUpperCase()+slug.slice(1).replace(/-/g,' '));
    s.categoryLabels[slug]=label;
    await db.saveSettings(s);
    res.redirect('/admin?tab=categories&success=added&label='+encodeURIComponent(label));
  } catch { res.redirect('/admin'); }
});
app.post('/admin/categories/:slug/delete', auth.requireAdmin, async (req, res) => {
  try { const s=res.locals.settings; if (['freefire','mlbb','pubg'].includes(req.params.slug)) return res.redirect('/admin?tab=categories'); s.categories=(s.categories||[]).filter(c=>c!==req.params.slug); if(s.categoryLabels?.[req.params.slug]) delete s.categoryLabels[req.params.slug]; await db.saveSettings(s); res.redirect('/admin?tab=categories&success=deleted'); } catch { res.redirect('/admin'); }
});

async function saveLinksSettings(req, res, field) {
  try {
    const { linkId, linkTitle, linkUrl, siteName, gamePanelName, whatsapp, telegram, email } = req.body;
    const s = res.locals.settings;
    const titles=toArray(linkTitle), urls=toArray(linkUrl), ids=toArray(linkId);
    s[field] = titles.map((t,i) => ({ id: parseInt(ids[i],10)||i+1, title: toCleanString(t||''), url: toCleanString(urls[i]||'') })).filter(l=>l.url);
    if(siteName!==undefined) s.siteName=toCleanString(siteName,'IBM STORE')||'IBM STORE';
    if(gamePanelName!==undefined) s.gamePanelName=toCleanString(gamePanelName,'IBM STORE')||'IBM STORE';
    s.contact = { whatsapp:toCleanString(whatsapp||''), telegram:toCleanString(telegram||''), email:toCleanString(email||'') };
    await db.saveSettings(s);
    res.redirect('/admin');
  } catch { res.redirect('/admin'); }
}
app.post('/admin/telegram-links', auth.requireAdmin, (req,res) => saveLinksSettings(req,res,'telegramLinks'));
app.post('/admin/whatsapp-links', auth.requireAdmin, (req,res) => saveLinksSettings(req,res,'whatsappLinks'));

app.post('/admin/footer-links', auth.requireAdmin, async (req, res) => {
  try {
    const { siteName, gamePanelName, whatsapp, telegram, email, footerLinksData } = req.body;
    const s = res.locals.settings;
    if (footerLinksData) { try { s.footerLinks=JSON.parse(footerLinksData); } catch {} }
    if(siteName!==undefined) s.siteName=toCleanString(siteName,'IBM STORE')||'IBM STORE';
    if(gamePanelName!==undefined) s.gamePanelName=toCleanString(gamePanelName,'IBM STORE')||'IBM STORE';
    s.contact={whatsapp:toCleanString(whatsapp||''),telegram:toCleanString(telegram||''),email:toCleanString(email||'')};
    await db.saveSettings(s);
    res.redirect('/admin');
  } catch { res.redirect('/admin'); }
});

app.post('/admin/banners', auth.requireAdmin, upload.single('bannerImage'), async (req, res) => {
  try {
    const { bannerId, bannerTitle, bannerSubtitle, bannerActive, existingImage } = req.body;
    const s = res.locals.settings;
    if (!s.banners) s.banners=[];
    const id = bannerId || uuidv4();
    let image = existingImage || '';
    if (req.file) { const fn=`banner-${Date.now()}-${uuidv4()}${path.extname(req.file.originalname)}`; image=await db.uploadImage(req.file.buffer,fn,req.file.mimetype); }
    const bd = { id, image, title:toCleanString(bannerTitle||''), subtitle:toCleanString(bannerSubtitle||''), active:bannerActive==='true' };
    const idx=s.banners.findIndex(b=>b.id===id);
    if(idx!==-1) s.banners[idx]=bd; else s.banners.push(bd);
    await db.saveSettings(s);
    res.redirect('/admin');
  } catch (e) { console.error('[ADMIN BANNER]',e.message); res.redirect('/admin'); }
});
app.post('/admin/banners/:id/delete', auth.requireAdmin, async (req, res) => {
  try { const s=res.locals.settings; const b=(s.banners||[]).find(b=>b.id===req.params.id); if(b?.image) await db.deleteImage(b.image); s.banners=(s.banners||[]).filter(b=>b.id!==req.params.id); await db.saveSettings(s); res.redirect('/admin'); } catch { res.redirect('/admin'); }
});

app.post('/admin/change-password', auth.requireAdmin, async (req, res) => {
  try {
    const { currentPassword, newPassword, confirmPassword } = req.body;
    const s = res.locals.settings;
    const creds = s.adminCredentials || {};
    if (!auth.checkPassword(currentPassword, creds.password)) return res.redirect('/admin?tab=security&error=wrong_password');
    if (newPassword !== confirmPassword) return res.redirect('/admin?tab=security&error=password_mismatch');
    if (newPassword.length < 6) return res.redirect('/admin?tab=security&error=password_too_short');
    s.adminCredentials = { username: creds.username, password: auth.hashPassword(newPassword) };
    await db.saveSettings(s);
    auth.clearAuthCookie(res);
    res.redirect('/admin-login');
  } catch { res.redirect('/admin'); }
});

app.post('/admin/broadcast', auth.requireAdmin, async (req, res) => {
  const [products, transactions] = await Promise.all([db.getProducts(), db.getTransactions()]);
  res.render('pages/admin', { products:products.map(normalizeProduct), transactions, settings:res.locals.settings, users:[], user:res.locals.user, error:null, broadcastSuccess:'Broadcast berhasil', categorySuccess:null, maintenanceMode:false });
});

app.post('/admin/maintenance', auth.requireAdmin, (req, res) => res.redirect('/admin'));

app.use((req, res) => {
  if (!res.headersSent && !req.path.startsWith('/api')) res.redirect('/');
});

if (require.main === module) {
  app.listen(PORT, () => console.log(`[IBM STORE] http://localhost:${PORT}`));
}
module.exports = app;

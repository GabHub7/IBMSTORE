'use strict';
const { createClient } = require('@supabase/supabase-js');

// ─── Client (service_role — server only, never expose to browser) ───────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { auth: { persistSession: false } }
);

// ─── Helper ──────────────────────────────────────────────────────────────────
function check(result, label) {
  if (result.error) {
    const msg = result.error.message || JSON.stringify(result.error);
    console.error(`[DB:${label}]`, msg);
    throw new Error(`DB error (${label}): ${msg}`);
  }
  return result.data;
}

// ─── SETTINGS ────────────────────────────────────────────────────────────────
async function getSettings() {
  try {
    const { data, error } = await supabase
      .from('settings').select('value').eq('key', 'site').single();
    if (error) {
      console.error('[DB:getSettings]', error.message);
      return {};
    }
    return data ? data.value : {};
  } catch (e) {
    console.error('[DB:getSettings] unexpected:', e.message);
    return {};
  }
}

async function saveSettings(obj) {
  check(
    await supabase.from('settings').upsert(
      { key: 'site', value: obj, updated_at: new Date().toISOString() },
      { onConflict: 'key' }
    ),
    'saveSettings'
  );
}

// ─── PRODUCTS ────────────────────────────────────────────────────────────────
async function getProducts() {
  const rows = check(
    await supabase.from('products').select('*').order('created_at', { ascending: false }),
    'getProducts'
  );
  return (rows || []).map(dbRowToProduct);
}

async function getActiveProducts() {
  const rows = check(
    await supabase.from('products').select('*')
      .eq('status', 'active').order('created_at', { ascending: false }),
    'getActiveProducts'
  );
  return (rows || []).map(dbRowToProduct);
}

async function getProductById(id) {
  const { data, error } = await supabase
    .from('products').select('*').eq('id', id).maybeSingle();
  if (error) throw new Error(`DB error (getProductById): ${error.message}`);
  return data ? dbRowToProduct(data) : null;
}

async function insertProduct(p) {
  const result = check(
    await supabase.from('products').insert(productToDbRow(p)).select().single(),
    'insertProduct'
  );
  return dbRowToProduct(result);
}

async function updateProduct(id, fields) {
  const row = productToDbRow(fields);
  // strip undefined
  const clean = Object.fromEntries(Object.entries(row).filter(([, v]) => v !== undefined));
  check(await supabase.from('products').update(clean).eq('id', id), 'updateProduct');
}

async function deleteProduct(id) {
  check(await supabase.from('products').delete().eq('id', id), 'deleteProduct');
}

// ─── KEY MANAGEMENT — semua via PostgreSQL RPC (atomic, no race condition) ───

// Alokasi key: SELECT FOR UPDATE di PostgreSQL mencegah oversell
async function allocateKey(productId, selectedDays) {
  const { data, error } = await supabase.rpc('allocate_key', {
    p_product_id: productId,
    p_days: selectedDays
  });
  if (error) {
    console.error('[DB:allocateKey]', error.message);
    return { success: false, error: error.message };
  }
  // data = { success: true, key: '...' } or { success: false, error: '...' }
  return data;
}

// Konfirmasi key setelah transaksi sukses (hapus dari reserved)
async function confirmKey(productId, key) {
  const { error } = await supabase.rpc('confirm_key', {
    p_product_id: productId,
    p_key: key
  });
  if (error) console.error('[DB:confirmKey]', error.message);
}

// Kembalikan key ke stok (transaksi expired/cancelled)
async function releaseKey(productId, key) {
  if (!key || !productId) return;
  const { error } = await supabase.rpc('release_key', {
    p_product_id: productId,
    p_key: key
  });
  if (error) console.error('[DB:releaseKey]', error.message);
}

// Hitung stok tersedia untuk durasi tertentu
async function getAvailableKeyCount(productId, selectedDays) {
  const { data, error } = await supabase.rpc('get_available_stock', {
    p_product_id: productId,
    p_days: selectedDays
  });
  if (error) {
    console.error('[DB:getAvailableKeyCount]', error.message);
    return 0;
  }
  return typeof data === 'number' ? data : 0;
}

// Increment sold atomically
async function incrementSold(productId) {
  const { error } = await supabase.rpc('increment_sold', { pid: productId });
  if (error) console.error('[DB:incrementSold]', error.message);
}

// ─── TRANSACTIONS ────────────────────────────────────────────────────────────
async function getTransactions() {
  const rows = check(
    await supabase.from('transactions').select('*')
      .order('created_at', { ascending: false }).limit(500),
    'getTransactions'
  );
  return (rows || []).map(dbRowToTransaction);
}

async function getTransactionByRef(paymentRef) {
  const { data, error } = await supabase
    .from('transactions').select('*').eq('payment_ref', paymentRef).maybeSingle();
  if (error) throw new Error(`DB error (getTransactionByRef): ${error.message}`);
  return data ? dbRowToTransaction(data) : null;
}

async function getTransactionById(id) {
  const { data, error } = await supabase
    .from('transactions').select('*').eq('id', id).maybeSingle();
  if (error) throw new Error(`DB error (getTransactionById): ${error.message}`);
  return data ? dbRowToTransaction(data) : null;
}

async function getTransactionByInvoice(invoiceId) {
  const { data, error } = await supabase
    .from('transactions').select('*')
    .ilike('invoice_id', `%${invoiceId}%`)
    .order('created_at', { ascending: false });
  if (error) throw new Error(`DB error (getTransactionByInvoice): ${error.message}`);
  return (data || []).map(dbRowToTransaction);
}

async function getPendingTransactions() {
  const rows = check(
    await supabase.from('transactions').select('*')
      .eq('status', 'pending').not('payment_ref', 'is', null),
    'getPendingTransactions'
  );
  return (rows || []).map(dbRowToTransaction);
}

async function insertTransaction(t) {
  const result = check(
    await supabase.from('transactions').insert(transactionToDbRow(t)).select().single(),
    'insertTransaction'
  );
  return dbRowToTransaction(result);
}

async function updateTransaction(id, fields) {
  const row = transactionToDbRow(fields);
  const clean = Object.fromEntries(Object.entries(row).filter(([, v]) => v !== undefined));
  if (Object.keys(clean).length === 0) return;
  check(await supabase.from('transactions').update(clean).eq('id', id), 'updateTransaction');
}

async function hasPendingTransaction(txKey) {
  const { data, error } = await supabase
    .from('transactions').select('id')
    .eq('transaction_key', txKey).eq('status', 'pending').maybeSingle();
  if (error) return false; // fail open — jangan block user kalau DB error
  return !!data;
}

// ─── REVIEWS ─────────────────────────────────────────────────────────────────
async function getReviewsByProduct(productId) {
  const { data, error } = await supabase
    .from('reviews').select('*').eq('product_id', productId)
    .order('created_at', { ascending: false });
  if (error) return [];
  return (data || []).map(dbRowToReview);
}

async function insertReview(r) {
  check(
    await supabase.from('reviews').insert({
      id: r.id, product_id: r.productId, guest_id: r.guestId || null,
      username: r.username || 'Guest', rating: r.rating,
      comment: r.comment, created_at: r.createdAt || new Date().toISOString()
    }),
    'insertReview'
  );
}

async function deleteReview(id) {
  check(await supabase.from('reviews').delete().eq('id', id), 'deleteReview');
}

function computeReviewStats(reviews) {
  const total = reviews.length;
  const avgRating = total > 0
    ? (reviews.reduce((s, r) => s + r.rating, 0) / total).toFixed(1)
    : 0;
  const distribution = { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 };
  reviews.forEach(r => { if (distribution[r.rating] !== undefined) distribution[r.rating]++; });
  return { total, avgRating, distribution };
}

async function getReviewStats(productId) {
  const reviews = await getReviewsByProduct(productId);
  return computeReviewStats(reviews);
}

// Fetch reviews dan stats sekaligus — hindari double query
async function getReviewsWithStats(productId, limit) {
  const reviews = await getReviewsByProduct(productId);
  const stats = computeReviewStats(reviews);
  return { reviews: limit ? reviews.slice(0, limit) : reviews, stats };
}

// ─── STORAGE ─────────────────────────────────────────────────────────────────
async function uploadImage(buffer, filename, mimetype) {
  const { data, error } = await supabase.storage
    .from('store-images')
    .upload(`products/${filename}`, buffer, { contentType: mimetype, upsert: true });

  if (error) {
    console.error('[STORAGE:upload]', error.message);
    throw new Error('Gagal upload gambar: ' + error.message);
  }

  const { data: urlData } = supabase.storage
    .from('store-images')
    .getPublicUrl(`products/${filename}`);

  return urlData.publicUrl;
}

async function deleteImage(imageUrl) {
  if (!imageUrl || imageUrl.startsWith('/images/')) return;
  try {
    const match = imageUrl.match(/store-images\/(.+)$/);
    if (match) {
      const { error } = await supabase.storage
        .from('store-images').remove([match[1]]);
      if (error) console.error('[STORAGE:delete]', error.message);
    }
  } catch (e) {
    console.error('[STORAGE:delete] unexpected:', e.message);
  }
}

// ─── ROW MAPPERS ─────────────────────────────────────────────────────────────
function dbRowToProduct(r) {
  return {
    id: r.id, name: r.name, category: r.category,
    description: r.description || '',
    image: r.image || '/images/logo-ibm.jpg',
    status: r.status,
    pricingOptions: r.pricing_options || [],
    price1day: r.price_1day || 0,
    price3day: r.price_3day || 0,
    price7day: r.price_7day || 0,
    customPrices: r.custom_prices || {},
    customDays: r.custom_days || [],
    keys: r.keys || [],
    reservedKeys: r.reserved_keys || [],
    sold: r.sold || 0,
    createdAt: r.created_at
  };
}

function productToDbRow(p) {
  const r = {};
  if (p.id          !== undefined) r.id             = p.id;
  if (p.name        !== undefined) r.name           = p.name;
  if (p.category    !== undefined) r.category       = p.category;
  if (p.description !== undefined) r.description    = p.description;
  if (p.image       !== undefined) r.image          = p.image;
  if (p.status      !== undefined) r.status         = p.status;
  if (p.pricingOptions !== undefined) r.pricing_options = p.pricingOptions;
  if (p.price1day   !== undefined) r.price_1day     = p.price1day;
  if (p.price3day   !== undefined) r.price_3day     = p.price3day;
  if (p.price7day   !== undefined) r.price_7day     = p.price7day;
  if (p.customPrices!== undefined) r.custom_prices  = p.customPrices;
  if (p.customDays  !== undefined) r.custom_days    = p.customDays;
  if (p.keys        !== undefined) r.keys           = p.keys;
  if (p.reservedKeys!== undefined) r.reserved_keys  = p.reservedKeys;
  if (p.sold        !== undefined) r.sold           = p.sold;
  if (p.createdAt   !== undefined) r.created_at     = p.createdAt;
  return r;
}

function dbRowToTransaction(r) {
  return {
    id: r.id, transactionKey: r.transaction_key,
    productId: r.product_id, productName: r.product_name,
    productImage: r.product_image, duration: r.duration,
    selectedDays: r.selected_days, price: r.price,
    originalPrice: r.original_price, discount: r.discount,
    voucherCode: r.voucher_code, voucherData: r.voucher_data,
    key: r.key || '', invoiceId: r.invoice_id, status: r.status,
    paymentMethod: r.payment_method, paymentRef: r.payment_ref,
    paymentQr: r.payment_qr, totalPayment: r.total_payment,
    lastCheckAt: r.last_check_at, checkCount: r.check_count || 0,
    createdAt: r.created_at, expiredAt: r.expired_at, paidAt: r.paid_at
  };
}

function transactionToDbRow(t) {
  const r = {};
  if (t.id             !== undefined) r.id              = t.id;
  if (t.transactionKey !== undefined) r.transaction_key = t.transactionKey;
  if (t.productId      !== undefined) r.product_id      = t.productId;
  if (t.productName    !== undefined) r.product_name    = t.productName;
  if (t.productImage   !== undefined) r.product_image   = t.productImage;
  if (t.duration       !== undefined) r.duration        = t.duration;
  if (t.selectedDays   !== undefined) r.selected_days   = t.selectedDays;
  if (t.price          !== undefined) r.price           = t.price;
  if (t.originalPrice  !== undefined) r.original_price  = t.originalPrice;
  if (t.discount       !== undefined) r.discount        = t.discount;
  if (t.voucherCode    !== undefined) r.voucher_code    = t.voucherCode;
  if (t.voucherData    !== undefined) r.voucher_data    = t.voucherData;
  if (t.key            !== undefined) r.key             = t.key;
  if (t.invoiceId      !== undefined) r.invoice_id      = t.invoiceId;
  if (t.status         !== undefined) r.status          = t.status;
  if (t.paymentMethod  !== undefined) r.payment_method  = t.paymentMethod;
  if (t.paymentRef     !== undefined) r.payment_ref     = t.paymentRef;
  if (t.paymentQr      !== undefined) r.payment_qr      = t.paymentQr;
  if (t.totalPayment   !== undefined) r.total_payment   = t.totalPayment;
  if (t.lastCheckAt    !== undefined) r.last_check_at   = t.lastCheckAt;
  if (t.checkCount     !== undefined) r.check_count     = t.checkCount;
  if (t.createdAt      !== undefined) r.created_at      = t.createdAt;
  if (t.expiredAt      !== undefined) r.expired_at      = t.expiredAt;
  if (t.paidAt         !== undefined) r.paid_at         = t.paidAt;
  return r;
}

function dbRowToReview(r) {
  return {
    id: r.id, productId: r.product_id, guestId: r.guest_id,
    username: r.username, rating: r.rating,
    comment: r.comment, createdAt: r.created_at
  };
}

module.exports = {
  supabase,
  getSettings, saveSettings,
  getProducts, getActiveProducts, getProductById,
  insertProduct, updateProduct, deleteProduct,
  allocateKey, confirmKey, releaseKey,
  getAvailableKeyCount, incrementSold,
  getTransactions, getTransactionByRef, getTransactionById,
  getTransactionByInvoice, getPendingTransactions,
  insertTransaction, updateTransaction, hasPendingTransaction,
  getReviewsByProduct, insertReview, deleteReview, getReviewStats, getReviewsWithStats,
  uploadImage, deleteImage
};

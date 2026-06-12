'use strict';
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');

const toCleanString = (value, fallback = '') => {
  if (typeof value !== 'string') return fallback;
  return value.trim();
};

const toArray = (value) => {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null) return [];
  return [value];
};

const generateInvoiceId = () => {
  return `INV-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).substr(2, 4).toUpperCase()}`;
};

const generateOrderId = () => {
  return `GS-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
};

const defaultPricingOptions = [
  { days: 1, price: 0 },
  { days: 3, price: 0 },
  { days: 7, price: 0 }
];

const getPricingOptions = (product = {}) => {
  const sourceOptions = Array.isArray(product.pricingOptions) && product.pricingOptions.length > 0
    ? product.pricingOptions
    : [
        { days: 1, price: product.price1day },
        { days: 3, price: product.price3day },
        { days: 7, price: product.price7day },
        ...Object.entries(product.customPrices || {}).map(([days, price]) => ({ days, price }))
      ];

  const pricingMap = new Map();
  sourceOptions.forEach((option) => {
    const days = parseInt(option?.days, 10);
    const rawPrice = parseInt(option?.price, 10);
    if (!Number.isFinite(days) || days <= 0) return;
    pricingMap.set(days, {
      days,
      price: Number.isFinite(rawPrice) && rawPrice >= 0 ? rawPrice : 0
    });
  });

  if (pricingMap.size === 0) {
    defaultPricingOptions.forEach(o => pricingMap.set(o.days, { ...o }));
  }

  return Array.from(pricingMap.values()).sort((a, b) => a.days - b.days);
};

const applyPricingOptions = (product, pricingOptions) => {
  const normalizedOptions = getPricingOptions({ pricingOptions });
  const customPrices = {};
  normalizedOptions.forEach((option) => {
    if (![1, 3, 7].includes(option.days)) {
      customPrices[option.days] = option.price;
    }
  });
  product.pricingOptions = normalizedOptions;
  product.price1day = normalizedOptions.find(o => o.days === 1)?.price ?? 0;
  product.price3day = normalizedOptions.find(o => o.days === 3)?.price ?? 0;
  product.price7day = normalizedOptions.find(o => o.days === 7)?.price ?? 0;
  product.customDays = Object.keys(customPrices).map(Number).sort((a, b) => a - b);
  product.customPrices = customPrices;
  return product;
};

const parsePricingOptionsInput = (daysInput, pricesInput) => {
  const dayList = toArray(daysInput);
  const priceList = toArray(pricesInput);
  const pricingOptions = dayList.map((days, index) => ({
    days, price: priceList[index]
  }));
  return getPricingOptions({ pricingOptions });
};

const normalizeProduct = (product = {}) => {
  const p = { ...product };
  applyPricingOptions(p, getPricingOptions(product));
  p.description = typeof p.description === 'string' ? p.description : '';
  p.image = toCleanString(p.image, '/images/placeholder.jpg') || '/images/placeholder.jpg';
  p.keys = Array.isArray(p.keys) ? p.keys : [];
  p.reservedKeys = p.reservedKeys || [];
  return p;
};

const DEFAULT_SETTINGS = {
  siteName: 'IBM STORE',
  gamePanelName: 'IBM STORE',
  about: '',
  faq: '',
  marqueeText: 'IBM STORE | Mod Menu Premium Free Fire & MLBB | Fast response 24 jam!',
  contact: { whatsapp: '', telegram: '', email: '' },
  banners: [],
  vouchers: [],
  categories: [],
  categoryLabels: {},
  telegramLinks: [],
  whatsappLinks: [{ id: 1, title: 'Channel IBM STORE', url: 'https://whatsapp.com/channel/0029VbC1qQg1SWt30jW22m0W' }],
  footerLinks: [
    { section: 'INFORMASI', links: [
      { id: 1, title: 'CARA BELI', url: '/cara-beli' },
      { id: 2, title: 'BANTUAN / FAQ', url: '/faq' },
      { id: 3, title: 'SYARAT KETENTUAN', url: '/syarat-ketentuan' }
    ]},
    { section: 'LAYANAN', links: [
      { id: 4, title: 'PRODUK POPULER', url: '/' },
      { id: 5, title: 'CEK INVOICE', url: '/invoice' }
    ]}
  ],
  pakasir: { apiKey: '', project: '', mode: 'production', autoCheckEnabled: true, webhookEnabled: true },
  adminCredentials: { username: 'admin', password: '$2a$10$xLRsRDpPJJKBqxIDlJIVR.Dk7xHQVNJMiF6oGsPeJX1v0E8IlDMPe' }
};

const normalizeSettings = (raw = {}) => {
  const s = { ...DEFAULT_SETTINGS, ...raw };
  s.siteName = toCleanString(s.siteName, 'IBM STORE') || 'IBM STORE';
  s.gamePanelName = toCleanString(s.gamePanelName, 'IBM STORE') || 'IBM STORE';
  s.contact = {
    whatsapp: toCleanString(s.contact?.whatsapp, ''),
    telegram: toCleanString(s.contact?.telegram, ''),
    email: toCleanString(s.contact?.email, '')
  };
  s.banners = Array.isArray(s.banners) ? s.banners : [];
  s.vouchers = Array.isArray(s.vouchers) ? s.vouchers : [];
  s.categories = Array.isArray(s.categories) ? s.categories : [];
  s.categoryLabels = (s.categoryLabels && typeof s.categoryLabels === 'object' && !Array.isArray(s.categoryLabels)) ? s.categoryLabels : {};
  s.telegramLinks = Array.isArray(s.telegramLinks) ? s.telegramLinks : [];
  s.whatsappLinks = Array.isArray(s.whatsappLinks) ? s.whatsappLinks : [];
  s.footerLinks = Array.isArray(s.footerLinks) ? s.footerLinks : DEFAULT_SETTINGS.footerLinks;
  s.pakasir = { ...DEFAULT_SETTINGS.pakasir, ...(s.pakasir || {}) };
  // Validasi adminCredentials — harus punya username dan password hash yang valid
  if (!s.adminCredentials || !s.adminCredentials.username || !s.adminCredentials.password ||
      typeof s.adminCredentials.password !== 'string' || !s.adminCredentials.password.startsWith('$2')) {
    s.adminCredentials = DEFAULT_SETTINGS.adminCredentials;
  }
  return s;
};

module.exports = {
  toCleanString, toArray, generateInvoiceId, generateOrderId,
  getPricingOptions, applyPricingOptions, parsePricingOptionsInput,
  normalizeProduct, normalizeSettings, uuidv4, crypto
};

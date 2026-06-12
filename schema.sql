-- =============================================
-- IBM STORE — Supabase Schema (FINAL)
-- Jalankan SELURUH file ini di SQL Editor
-- Aman dijalankan berulang kali (idempotent)
-- =============================================

-- ─── 1. TABLES ───────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS products (
  id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  name          TEXT NOT NULL,
  category      TEXT NOT NULL DEFAULT 'freefire',
  description   TEXT DEFAULT '',
  image         TEXT DEFAULT '/images/logo-ibm.jpg',
  status        TEXT NOT NULL DEFAULT 'inactive'
                  CHECK (status IN ('active','inactive')),
  pricing_options JSONB   DEFAULT '[]',
  price_1day    INTEGER DEFAULT 0,
  price_3day    INTEGER DEFAULT 0,
  price_7day    INTEGER DEFAULT 0,
  custom_prices JSONB   DEFAULT '{}',
  custom_days   JSONB   DEFAULT '[]',
  keys          TEXT[]  DEFAULT '{}',
  reserved_keys TEXT[]  DEFAULT '{}',
  sold          INTEGER DEFAULT 0,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS transactions (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  transaction_key TEXT,
  product_id      TEXT REFERENCES products(id) ON DELETE SET NULL,
  product_name    TEXT,
  product_image   TEXT,
  duration        TEXT,
  selected_days   INTEGER DEFAULT 1,
  price           INTEGER DEFAULT 0,
  original_price  INTEGER DEFAULT 0,
  discount        INTEGER DEFAULT 0,
  voucher_code    TEXT,
  voucher_data    JSONB,
  key             TEXT DEFAULT '',
  invoice_id      TEXT UNIQUE,
  status          TEXT DEFAULT 'pending'
                    CHECK (status IN ('pending','completed','success','expired','cancelled')),
  payment_method  TEXT DEFAULT 'qris',
  payment_ref     TEXT,
  payment_qr      TEXT,
  total_payment   INTEGER DEFAULT 0,
  last_check_at   TIMESTAMPTZ,
  check_count     INTEGER DEFAULT 0,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  expired_at      TIMESTAMPTZ,
  paid_at         TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS reviews (
  id         TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  product_id TEXT REFERENCES products(id) ON DELETE CASCADE,
  guest_id   TEXT,
  username   TEXT DEFAULT 'Guest',
  rating     INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment    TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ─── 2. INDEXES ──────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_tx_payment_ref   ON transactions(payment_ref);
CREATE INDEX IF NOT EXISTS idx_tx_invoice_id    ON transactions(invoice_id);
CREATE INDEX IF NOT EXISTS idx_tx_status        ON transactions(status);
CREATE INDEX IF NOT EXISTS idx_tx_key           ON transactions(transaction_key);
CREATE INDEX IF NOT EXISTS idx_reviews_prod     ON reviews(product_id);
CREATE INDEX IF NOT EXISTS idx_products_status  ON products(status);
CREATE INDEX IF NOT EXISTS idx_products_cat     ON products(category);

-- ─── 3. FUNCTIONS ────────────────────────────────────────────────────────────

-- increment_sold: atomic, tidak bisa race condition
CREATE OR REPLACE FUNCTION increment_sold(pid TEXT)
RETURNS void
LANGUAGE SQL
SECURITY DEFINER
AS $$
  UPDATE products SET sold = sold + 1 WHERE id = pid;
$$;

-- allocate_key: ATOMIC key allocation pakai SELECT FOR UPDATE
-- Mencegah oversell / race condition saat banyak user beli bersamaan
CREATE OR REPLACE FUNCTION allocate_key(p_product_id TEXT, p_days INTEGER)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_product   RECORD;
  v_keys      TEXT[];
  v_reserved  TEXT[];
  v_key_src   TEXT;
  v_key_out   TEXT;
  v_new_keys  TEXT[];
  v_new_res   TEXT[];
  i           INTEGER;
BEGIN
  -- Lock baris product agar tidak ada concurrent allocation
  SELECT keys, reserved_keys
  INTO v_product
  FROM products
  WHERE id = p_product_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Produk tidak ditemukan');
  END IF;

  v_keys     := COALESCE(v_product.keys, '{}');
  v_reserved := COALESCE(v_product.reserved_keys, '{}');

  v_key_src := NULL;
  v_key_out := NULL;

  -- Cari keyed key (format "KEY:days") sesuai durasi
  FOR i IN 1..COALESCE(array_length(v_keys, 1), 0) LOOP
    IF v_keys[i] ~ (':' || p_days::text || '$') THEN
      v_key_src := v_keys[i];
      v_key_out := split_part(v_keys[i], ':', 1);
      EXIT;
    END IF;
  END LOOP;

  -- Kalau tidak ada keyed, ambil unkeyed
  IF v_key_src IS NULL THEN
    FOR i IN 1..COALESCE(array_length(v_keys, 1), 0) LOOP
      IF v_keys[i] NOT LIKE '%:%' THEN
        v_key_src := v_keys[i];
        v_key_out := v_keys[i];
        EXIT;
      END IF;
    END LOOP;
  END IF;

  IF v_key_src IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Stok key habis');
  END IF;

  -- Hapus key dari array keys
  v_new_keys := '{}';
  FOR i IN 1..COALESCE(array_length(v_keys, 1), 0) LOOP
    IF v_keys[i] <> v_key_src THEN
      v_new_keys := array_append(v_new_keys, v_keys[i]);
    END IF;
  END LOOP;

  -- Tambah ke reserved
  v_new_res := array_append(v_reserved, v_key_out);

  -- Update atomically
  UPDATE products
  SET keys = v_new_keys, reserved_keys = v_new_res
  WHERE id = p_product_id;

  RETURN jsonb_build_object('success', true, 'key', v_key_out);
END;
$$;

-- confirm_key: hapus dari reserved setelah transaksi sukses
CREATE OR REPLACE FUNCTION confirm_key(p_product_id TEXT, p_key TEXT)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_reserved TEXT[];
  v_new_res  TEXT[];
  i          INTEGER;
BEGIN
  SELECT reserved_keys INTO v_reserved
  FROM products WHERE id = p_product_id FOR UPDATE;

  IF NOT FOUND THEN RETURN; END IF;

  v_new_res := '{}';
  FOR i IN 1..COALESCE(array_length(v_reserved, 1), 0) LOOP
    IF v_reserved[i] <> p_key THEN
      v_new_res := array_append(v_new_res, v_reserved[i]);
    END IF;
  END LOOP;

  UPDATE products SET reserved_keys = v_new_res WHERE id = p_product_id;
END;
$$;

-- release_key: kembalikan key ke stok (transaksi expired/cancelled)
CREATE OR REPLACE FUNCTION release_key(p_product_id TEXT, p_key TEXT)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_keys     TEXT[];
  v_reserved TEXT[];
  v_new_res  TEXT[];
  i          INTEGER;
BEGIN
  SELECT keys, reserved_keys INTO v_keys, v_reserved
  FROM products WHERE id = p_product_id FOR UPDATE;

  IF NOT FOUND THEN RETURN; END IF;

  -- Hapus dari reserved
  v_new_res := '{}';
  FOR i IN 1..COALESCE(array_length(v_reserved, 1), 0) LOOP
    IF v_reserved[i] <> p_key THEN
      v_new_res := array_append(v_new_res, v_reserved[i]);
    END IF;
  END LOOP;

  -- Kembalikan ke keys (kalau belum ada)
  IF NOT (p_key = ANY(COALESCE(v_keys, '{}'))) THEN
    v_keys := array_append(COALESCE(v_keys, '{}'), p_key);
  END IF;

  UPDATE products
  SET keys = v_keys, reserved_keys = v_new_res
  WHERE id = p_product_id;
END;
$$;

-- get_available_stock: hitung stok tersedia untuk durasi tertentu
CREATE OR REPLACE FUNCTION get_available_stock(p_product_id TEXT, p_days INTEGER)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_keys     TEXT[];
  v_reserved TEXT[];
  v_keyed    INTEGER := 0;
  v_unkeyed  INTEGER := 0;
  v_res_cnt  INTEGER := 0;
  i          INTEGER;
BEGIN
  SELECT keys, reserved_keys INTO v_keys, v_reserved
  FROM products WHERE id = p_product_id;

  IF NOT FOUND THEN RETURN 0; END IF;

  v_keys     := COALESCE(v_keys, '{}');
  v_reserved := COALESCE(v_reserved, '{}');

  -- Hitung keyed & unkeyed
  FOR i IN 1..COALESCE(array_length(v_keys, 1), 0) LOOP
    IF v_keys[i] ~ (':' || p_days::text || '$') THEN
      v_keyed := v_keyed + 1;
    ELSIF v_keys[i] NOT LIKE '%:%' THEN
      v_unkeyed := v_unkeyed + 1;
    END IF;
  END LOOP;

  -- Hitung reserved
  v_res_cnt := COALESCE(array_length(v_reserved, 1), 0);

  RETURN GREATEST(0, CASE WHEN v_keyed > 0 THEN v_keyed ELSE v_unkeyed END - v_res_cnt);
END;
$$;

-- ─── 4. RLS POLICIES ─────────────────────────────────────────────────────────

ALTER TABLE products     ENABLE ROW LEVEL SECURITY;
ALTER TABLE transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE settings     ENABLE ROW LEVEL SECURITY;
ALTER TABLE reviews      ENABLE ROW LEVEL SECURITY;

-- Drop semua policy lama dulu (safe re-run)
DO $$ BEGIN
  DROP POLICY IF EXISTS "public_read_active_products"  ON products;
  DROP POLICY IF EXISTS "service_role_all_products"    ON products;
  DROP POLICY IF EXISTS "public_read_settings"         ON settings;
  DROP POLICY IF EXISTS "service_role_all_settings"    ON settings;
  DROP POLICY IF EXISTS "public_read_reviews"          ON reviews;
  DROP POLICY IF EXISTS "public_insert_reviews"        ON reviews;
  DROP POLICY IF EXISTS "service_role_all_reviews"     ON reviews;
  DROP POLICY IF EXISTS "service_role_all_transactions" ON transactions;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

CREATE POLICY "public_read_active_products"   ON products     FOR SELECT USING (status = 'active');
CREATE POLICY "service_role_all_products"     ON products     FOR ALL    USING (auth.role() = 'service_role');
CREATE POLICY "public_read_settings"          ON settings     FOR SELECT USING (true);
CREATE POLICY "service_role_all_settings"     ON settings     FOR ALL    USING (auth.role() = 'service_role');
CREATE POLICY "public_read_reviews"           ON reviews      FOR SELECT USING (true);
CREATE POLICY "public_insert_reviews"         ON reviews      FOR INSERT WITH CHECK (true);
CREATE POLICY "service_role_all_reviews"      ON reviews      FOR ALL    USING (auth.role() = 'service_role');
CREATE POLICY "service_role_all_transactions" ON transactions FOR ALL    USING (auth.role() = 'service_role');

-- ─── 5. STORAGE ──────────────────────────────────────────────────────────────

INSERT INTO storage.buckets (id, name, public)
VALUES ('store-images', 'store-images', true)
ON CONFLICT (id) DO UPDATE SET public = true;

DO $$ BEGIN
  DROP POLICY IF EXISTS "public_read_images"        ON storage.objects;
  DROP POLICY IF EXISTS "service_role_upload_images" ON storage.objects;
  DROP POLICY IF EXISTS "service_role_delete_images" ON storage.objects;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

CREATE POLICY "public_read_images"         ON storage.objects FOR SELECT USING (bucket_id = 'store-images');
CREATE POLICY "service_role_upload_images" ON storage.objects FOR INSERT WITH CHECK (bucket_id = 'store-images');
CREATE POLICY "service_role_delete_images" ON storage.objects FOR DELETE USING (bucket_id = 'store-images');

-- ─── 6. SETTINGS AWAL (UPSERT) ───────────────────────────────────────────────
-- Username: admin | Password: admin123

INSERT INTO settings (key, value, updated_at) VALUES (
  'site',
  jsonb_build_object(
    'siteName',      'IBM STORE',
    'gamePanelName', 'IBM STORE',
    'about',         'IBM STORE adalah platform jual beli mod menu & panel game terpercaya. Fast response 24 jam.',
    'faq',           'Q: Bagaimana cara membeli?' || chr(10) || 'A: Pilih produk, pilih durasi, bayar via QRIS, key dikirim otomatis.' || chr(10) || chr(10) || 'Q: Apakah aman?' || chr(10) || 'A: Ya, kami menggunakan sistem anti-banned.',
    'marqueeText',   'Selamat Datang di IBM STORE | Top 1 VIP Mods Terbaik | Fast Response 24 Jam | Proses Instan',
    'contact',       jsonb_build_object('whatsapp','','telegram','','email',''),
    'banners',       '[]'::jsonb,
    'vouchers',      '[]'::jsonb,
    'categories',    '[]'::jsonb,
    'categoryLabels','{}' ::jsonb,
    'telegramLinks', '[]'::jsonb,
    'whatsappLinks', '[{"id":1,"title":"Channel IBM STORE","url":"https://whatsapp.com/channel/0029VbC1qQg1SWt30jW22m0W"}]'::jsonb,
    'footerLinks',   '[]'::jsonb,
    'pakasir',       jsonb_build_object('apiKey','','project','','mode','production','autoCheckEnabled',true,'webhookEnabled',true),
    'adminCredentials', jsonb_build_object(
      'username', 'admin',
      'password', '$2a$10$xLRsRDpPJJKBqxIDlJIVR.Dk7xHQVNJMiF6oGsPeJX1v0E8IlDMPe'
    )
  ),
  NOW()
)
ON CONFLICT (key) DO UPDATE
  SET value      = EXCLUDED.value,
      updated_at = NOW();

-- ─── 7. VERIFIKASI ───────────────────────────────────────────────────────────
-- Jalankan query ini untuk memastikan semua OK:

SELECT
  (SELECT COUNT(*) FROM products)     AS total_products,
  (SELECT COUNT(*) FROM transactions) AS total_transactions,
  (SELECT COUNT(*) FROM settings)     AS total_settings,
  (SELECT value->'adminCredentials'->'username' FROM settings WHERE key='site') AS admin_username;

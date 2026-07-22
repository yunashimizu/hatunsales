-- Patch para que el backend pueda trabajar con las tablas reales usadas por TypeORM
-- Ejecutar con: psql -h localhost -U postgres -d hatunsales_db -f db/patch_schema.sql

CREATE TABLE IF NOT EXISTS inventarios (
  id_inventario SERIAL PRIMARY KEY,
  id_producto INTEGER,
  stock INTEGER DEFAULT 0,
  stock_minimo INTEGER DEFAULT 0,
  creado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS stock_sucursal (
  id_stock SERIAL PRIMARY KEY,
  id_producto INTEGER NOT NULL,
  id_sucursal INTEGER NOT NULL,
  stock INTEGER DEFAULT 0,
  stock_comprometido INTEGER DEFAULT 0,
  actualizado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS proformas (
  id_proforma SERIAL PRIMARY KEY,
  id_empresa INTEGER,
  id_cliente INTEGER,
  serie VARCHAR(20),
  numero INTEGER,
  total_gravada NUMERIC(12,2) DEFAULT 0,
  total_igv NUMERIC(12,2) DEFAULT 0,
  total NUMERIC(12,2) DEFAULT 0,
  creado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS proformas_items (
  id_item SERIAL PRIMARY KEY,
  id_proforma INTEGER NOT NULL,
  id_producto INTEGER NOT NULL,
  cantidad INTEGER DEFAULT 1,
  precio_unitario NUMERIC(12,2) DEFAULT 0,
  subtotal NUMERIC(12,2) DEFAULT 0
);

CREATE TABLE IF NOT EXISTS guias_remision_items (
  id_item SERIAL PRIMARY KEY,
  id_guia INTEGER NOT NULL,
  id_producto INTEGER NOT NULL,
  cantidad INTEGER DEFAULT 1,
  unidad_medida VARCHAR(50)
);

ALTER TABLE productos
  ADD COLUMN IF NOT EXISTS descripcion TEXT,
  ADD COLUMN IF NOT EXISTS sku VARCHAR(100),
  ADD COLUMN IF NOT EXISTS unidad_medida VARCHAR(50),
  ADD COLUMN IF NOT EXISTS stock_minimo INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS creado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE productos_imagenes
  ADD COLUMN IF NOT EXISTS thumb_url TEXT,
  ADD COLUMN IF NOT EXISTS is_primary BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS mime VARCHAR(100),
  ADD COLUMN IF NOT EXISTS size INTEGER,
  ADD COLUMN IF NOT EXISTS width INTEGER,
  ADD COLUMN IF NOT EXISTS height INTEGER,
  ADD COLUMN IF NOT EXISTS descripcion TEXT,
  ADD COLUMN IF NOT EXISTS creado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE guias_remision
  ADD COLUMN IF NOT EXISTS id_empresa INTEGER,
  ADD COLUMN IF NOT EXISTS id_cliente INTEGER,
  ADD COLUMN IF NOT EXISTS direccion_origen TEXT,
  ADD COLUMN IF NOT EXISTS direccion_destino TEXT,
  ADD COLUMN IF NOT EXISTS motivo_traslado TEXT,
  ADD COLUMN IF NOT EXISTS peso_total TEXT,
  ADD COLUMN IF NOT EXISTS creado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE sucursales
  ADD COLUMN IF NOT EXISTS creado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP;

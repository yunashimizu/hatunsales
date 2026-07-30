-- Fase 4: rastreo de salidas de stock por venta + estado de venta (PostgreSQL, idempotente)
ALTER TABLE ventas ADD COLUMN IF NOT EXISTS estado VARCHAR(20) DEFAULT 'activa';

CREATE TABLE IF NOT EXISTS venta_stock_salida (
  id SERIAL PRIMARY KEY,
  id_venta INTEGER NOT NULL REFERENCES ventas(id_venta) ON DELETE CASCADE,
  id_producto INTEGER NOT NULL,
  id_almacen INTEGER NOT NULL,
  cantidad NUMERIC(12, 3) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_venta_stock_salida_venta ON venta_stock_salida (id_venta);

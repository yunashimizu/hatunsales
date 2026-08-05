-- Cotizaciones (proformas) v1 — idempotente
-- Amplía proformas para flujo comercial sin SUNAT.

ALTER TABLE proformas
  ALTER COLUMN id_cliente DROP NOT NULL;

ALTER TABLE proformas
  ALTER COLUMN id_empresa DROP NOT NULL;

ALTER TABLE proformas
  ADD COLUMN IF NOT EXISTS codigo VARCHAR(32),
  ADD COLUMN IF NOT EXISTS estado VARCHAR(20) DEFAULT 'borrador',
  ADD COLUMN IF NOT EXISTS observaciones TEXT,
  ADD COLUMN IF NOT EXISTS valida_hasta DATE,
  ADD COLUMN IF NOT EXISTS id_almacen INTEGER,
  ADD COLUMN IF NOT EXISTS cliente_nombre_snapshot VARCHAR(250),
  ADD COLUMN IF NOT EXISTS telefono_envio VARCHAR(32),
  ADD COLUMN IF NOT EXISTS id_venta INTEGER,
  ADD COLUMN IF NOT EXISTS enviada_wa_en TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS uq_proformas_codigo
  ON proformas (codigo)
  WHERE codigo IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_proformas_estado ON proformas (estado);
CREATE INDEX IF NOT EXISTS idx_proformas_creado ON proformas (creado_en DESC);

ALTER TABLE proformas_items
  ADD COLUMN IF NOT EXISTS descripcion_snapshot VARCHAR(250),
  ADD COLUMN IF NOT EXISTS sku_snapshot VARCHAR(80);

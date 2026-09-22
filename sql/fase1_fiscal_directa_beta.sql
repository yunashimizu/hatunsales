-- Fase 1: base fiscal segura para SUNAT Direct.
-- La migración debe ser idempotente y no activa el envío real.

CREATE TABLE IF NOT EXISTS fiscal_envios (
  id_envio SERIAL PRIMARY KEY,
  id_comprobante INTEGER NULL,
  id_guia INTEGER NULL,
  tipo_documento VARCHAR(10) NULL,
  ambiente VARCHAR(20) NOT NULL DEFAULT 'beta',
  proveedor VARCHAR(30) NOT NULL DEFAULT 'none',
  operacion VARCHAR(30) NOT NULL DEFAULT 'emitir',
  intento INTEGER NOT NULL DEFAULT 0,
  estado VARCHAR(40) NOT NULL DEFAULT 'PENDIENTE',
  nombre_archivo VARCHAR(255) NULL,
  sunat_ticket VARCHAR(255) NULL,
  codigo_sunat VARCHAR(50) NULL,
  mensaje_sunat TEXT NULL,
  observaciones TEXT NULL,
  respuesta_json JSONB NULL,
  fecha_envio TIMESTAMPTZ NULL,
  fecha_respuesta TIMESTAMPTZ NULL,
  ultimo_error TEXT NULL,
  creado_en TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  actualizado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS fiscal_artifacts (
  id_artifact SERIAL PRIMARY KEY,
  id_envio INTEGER NOT NULL REFERENCES fiscal_envios(id_envio) ON DELETE CASCADE,
  tipo_artifacto VARCHAR(40) NOT NULL,
  storage_key VARCHAR(255) NOT NULL,
  mime VARCHAR(80) NULL,
  hash VARCHAR(128) NULL,
  size BIGINT NULL,
  creado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_fiscal_envios_comprobante ON fiscal_envios(id_comprobante);
CREATE INDEX IF NOT EXISTS idx_fiscal_envios_guia ON fiscal_envios(id_guia);
CREATE INDEX IF NOT EXISTS idx_fiscal_envios_estado ON fiscal_envios(estado);
CREATE INDEX IF NOT EXISTS idx_fiscal_envios_tipo_serie_numero ON fiscal_envios(tipo_documento, ambiente, sunat_ticket);
CREATE INDEX IF NOT EXISTS idx_fiscal_envios_ticket ON fiscal_envios(sunat_ticket);
CREATE INDEX IF NOT EXISTS idx_fiscal_artifacts_envio ON fiscal_artifacts(id_envio);

-- Nota: no se activa SUNAT automáticamente ni se habilita el envío real en esta fase.

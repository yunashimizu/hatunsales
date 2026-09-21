-- =============================================================================
-- GRE REMITENTE DIRECTA · FASE 1
-- =============================================================================
-- Preparación idempotente para emitir GRE Remitente desde el SEE del
-- contribuyente. Este script NO se ejecuta automáticamente desde Nest.
-- Revisar y ejecutar en Railway cuando SUNAT haya habilitado el certificado,
-- la serie y las credenciales del contribuyente.

BEGIN;

ALTER TABLE guias_remision
  ADD COLUMN IF NOT EXISTS id_comprobante INTEGER,
  ADD COLUMN IF NOT EXISTS id_almacen_origen INTEGER,
  ADD COLUMN IF NOT EXISTS id_usuario INTEGER,
  ADD COLUMN IF NOT EXISTS tipo_guia VARCHAR(20) DEFAULT 'remitente',
  ADD COLUMN IF NOT EXISTS sunat_tipo_documento VARCHAR(2),
  ADD COLUMN IF NOT EXISTS serie VARCHAR(4),
  ADD COLUMN IF NOT EXISTS numero INTEGER,
  ADD COLUMN IF NOT EXISTS estado VARCHAR(30) DEFAULT 'borrador',
  ADD COLUMN IF NOT EXISTS fecha_emision DATE,
  ADD COLUMN IF NOT EXISTS fecha_inicio_traslado DATE,
  ADD COLUMN IF NOT EXISTS motivo_traslado_codigo VARCHAR(4),
  ADD COLUMN IF NOT EXISTS modalidad_traslado VARCHAR(2),
  ADD COLUMN IF NOT EXISTS origen_ubigeo VARCHAR(6),
  ADD COLUMN IF NOT EXISTS destino_ubigeo VARCHAR(6),
  ADD COLUMN IF NOT EXISTS peso_bruto_total NUMERIC(12,3),
  ADD COLUMN IF NOT EXISTS unidad_peso VARCHAR(3) DEFAULT 'KGM',
  ADD COLUMN IF NOT EXISTS numero_bultos NUMERIC(12,3),
  ADD COLUMN IF NOT EXISTS destinatario_tipo_doc VARCHAR(2),
  ADD COLUMN IF NOT EXISTS destinatario_numero_doc VARCHAR(20),
  ADD COLUMN IF NOT EXISTS destinatario_denominacion VARCHAR(250),
  ADD COLUMN IF NOT EXISTS destinatario_direccion TEXT,
  ADD COLUMN IF NOT EXISTS placa_principal VARCHAR(20),
  ADD COLUMN IF NOT EXISTS marca_vehiculo VARCHAR(120),
  ADD COLUMN IF NOT EXISTS conductor_nombre VARCHAR(250),
  ADD COLUMN IF NOT EXISTS conductor_tipo_doc VARCHAR(2),
  ADD COLUMN IF NOT EXISTS conductor_numero_doc VARCHAR(20),
  ADD COLUMN IF NOT EXISTS conductor_licencia VARCHAR(30),
  ADD COLUMN IF NOT EXISTS transportista_ruc VARCHAR(20),
  ADD COLUMN IF NOT EXISTS transportista_denominacion VARCHAR(250),
  ADD COLUMN IF NOT EXISTS observaciones TEXT,
  ADD COLUMN IF NOT EXISTS clave_idempotencia VARCHAR(100),
  ADD COLUMN IF NOT EXISTS error_mensaje TEXT,
  ADD COLUMN IF NOT EXISTS sunat_description TEXT,
  ADD COLUMN IF NOT EXISTS sunat_responsecode VARCHAR(30),
  ADD COLUMN IF NOT EXISTS sunat_ticket VARCHAR(100),
  ADD COLUMN IF NOT EXISTS cadena_qr TEXT,
  ADD COLUMN IF NOT EXISTS codigo_hash VARCHAR(300),
  ADD COLUMN IF NOT EXISTS enlace_pdf TEXT,
  ADD COLUMN IF NOT EXISTS enlace_xml TEXT,
  ADD COLUMN IF NOT EXISTS enlace_cdr TEXT,
  ADD COLUMN IF NOT EXISTS xml_storage_key VARCHAR(255),
  ADD COLUMN IF NOT EXISTS zip_storage_key VARCHAR(255),
  ADD COLUMN IF NOT EXISTS cdr_storage_key VARCHAR(255),
  ADD COLUMN IF NOT EXISTS pdf_storage_key VARCHAR(255),
  ADD COLUMN IF NOT EXISTS payload_sunat JSONB,
  ADD COLUMN IF NOT EXISTS respuesta_sunat JSONB;

ALTER TABLE guias_remision_items
  ADD COLUMN IF NOT EXISTS id_venta_detalle INTEGER,
  ADD COLUMN IF NOT EXISTS codigo VARCHAR(100),
  ADD COLUMN IF NOT EXISTS descripcion TEXT,
  ADD COLUMN IF NOT EXISTS orden INTEGER DEFAULT 1,
  ALTER COLUMN cantidad TYPE NUMERIC(12,3) USING cantidad::numeric;

UPDATE guias_remision
   SET estado = 'legacy'
 WHERE estado = 'borrador'
   AND NOT EXISTS (
     SELECT 1 FROM guias_remision_items i WHERE i.id_guia = guias_remision.id_guia
   );

CREATE INDEX IF NOT EXISTS idx_guias_remision_venta
  ON guias_remision (id_venta);

CREATE INDEX IF NOT EXISTS idx_guias_remision_estado
  ON guias_remision (estado);

CREATE INDEX IF NOT EXISTS idx_guias_remision_fecha
  ON guias_remision (fecha_emision DESC NULLS LAST, id_guia DESC);

CREATE UNIQUE INDEX IF NOT EXISTS uq_guias_remision_serie_numero
  ON guias_remision (serie, numero)
  WHERE serie IS NOT NULL AND numero IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_guias_remision_idempotencia
  ON guias_remision (clave_idempotencia)
  WHERE clave_idempotencia IS NOT NULL AND clave_idempotencia <> '';

CREATE INDEX IF NOT EXISTS idx_guias_remision_usuario
  ON guias_remision (id_usuario);

CREATE INDEX IF NOT EXISTS idx_guias_remision_comprobante
  ON guias_remision (id_comprobante);

CREATE INDEX IF NOT EXISTS idx_guias_remision_items_producto
  ON guias_remision_items (id_producto);

CREATE TABLE IF NOT EXISTS guias_remision_envios (
  id_envio BIGSERIAL PRIMARY KEY,
  id_guia INTEGER NOT NULL REFERENCES guias_remision(id_guia) ON DELETE CASCADE,
  intento INTEGER NOT NULL,
  estado VARCHAR(30) NOT NULL,
  codigo_sunat VARCHAR(30),
  mensaje TEXT,
  xml_storage_key VARCHAR(255),
  cdr_storage_key VARCHAR(255),
  respuesta JSONB,
  iniciado_en TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  terminado_en TIMESTAMPTZ,
  tiempo_respuesta_ms INTEGER,
  id_usuario INTEGER,
  creado_en TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_guias_remision_envio_intento UNIQUE (id_guia, intento),
  CONSTRAINT ck_guias_remision_envio_intento CHECK (intento > 0)
);

CREATE INDEX IF NOT EXISTS idx_guias_remision_envios_guia
  ON guias_remision_envios (id_guia, creado_en DESC);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'guias_remision_id_venta_fkey'
  ) THEN
    ALTER TABLE guias_remision
      ADD CONSTRAINT guias_remision_id_venta_fkey
      FOREIGN KEY (id_venta) REFERENCES ventas(id_venta) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'guias_remision_id_usuario_fkey'
  ) THEN
    ALTER TABLE guias_remision
      ADD CONSTRAINT guias_remision_id_usuario_fkey
      FOREIGN KEY (id_usuario) REFERENCES usuarios(id_usuario) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'guias_remision_envios_id_usuario_fkey'
  ) THEN
    ALTER TABLE guias_remision_envios
      ADD CONSTRAINT guias_remision_envios_id_usuario_fkey
      FOREIGN KEY (id_usuario) REFERENCES usuarios(id_usuario) NOT VALID;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'guias_remision_datos_basicos_ck'
  ) THEN
    ALTER TABLE guias_remision
      ADD CONSTRAINT guias_remision_datos_basicos_ck
      CHECK (
        estado IN ('legacy', 'borrador', 'pendiente', 'enviado', 'aceptado', 'rechazado', 'anulado')
        AND (peso_bruto_total IS NULL OR peso_bruto_total >= 0)
        AND (numero_bultos IS NULL OR numero_bultos >= 0)
      ) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'guias_remision_item_cantidad_ck'
  ) THEN
    ALTER TABLE guias_remision_items
      ADD CONSTRAINT guias_remision_item_cantidad_ck
      CHECK (cantidad > 0) NOT VALID;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'guias_remision_id_comprobante_fkey'
  ) THEN
    ALTER TABLE guias_remision
      ADD CONSTRAINT guias_remision_id_comprobante_fkey
      FOREIGN KEY (id_comprobante) REFERENCES comprobantes(id_comprobante);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'guias_remision_id_almacen_fkey'
  ) THEN
    ALTER TABLE guias_remision
      ADD CONSTRAINT guias_remision_id_almacen_fkey
      FOREIGN KEY (id_almacen_origen) REFERENCES almacenes(id_almacen);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'guias_remision_items_id_guia_fkey'
  ) THEN
    ALTER TABLE guias_remision_items
      ADD CONSTRAINT guias_remision_items_id_guia_fkey
      FOREIGN KEY (id_guia) REFERENCES guias_remision(id_guia) ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'guias_remision_items_id_producto_fkey'
  ) THEN
    ALTER TABLE guias_remision_items
      ADD CONSTRAINT guias_remision_items_id_producto_fkey
      FOREIGN KEY (id_producto) REFERENCES productos(id_producto);
  END IF;
END $$;

COMMIT;

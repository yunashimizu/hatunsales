-- =============================================================================
-- FASE 9 · SUNAT directo (SEE - Del Contribuyente)
-- PostgreSQL · idempotente · aditivo (no borra ni reescribe datos)
-- =============================================================================
-- Qué agrega:
--   1) tipos_comprobante: ids 7 (NOTA DE CREDITO) y 8 (NOTA DE DEBITO). Hoy la FK
--      comprobantes_id_tipo_fkey impide guardar notas. Además corrige los nombres
--      de 1 y 2, que están invertidos (el código y los datos usan 1 = factura FFF1
--      y 2 = boleta BBB1; ninguna vista, función ni consulta lee `nombre`:
--      verificado con grep y pg_catalog el 2026-10-07).
--   2) comprobantes: columnas fiscales (proveedor, ambiente, estado SUNAT, plazo,
--      forma de pago, nota) con CHECK/FK NOT VALID e índices parciales.
--   3) productos.codigo_sunat (UNSPSC, 8 dígitos).
--   4) fiscal_envios: cola, reintentos y tickets (columnas + índices únicos parciales).
--   5) fiscal_artifacts: el XML firmado, el ZIP y el CDR se guardan en la BD
--      (el disco de Railway es efímero).
--   6) fiscal_resumen_lineas: líneas de resúmenes diarios (RC) y bajas (RA).
--   7) fiscal_certificados: certificado .pfx y su contraseña cifrados (AES-256-GCM
--      con FISCAL_SECRET_KEY, que vive solo en Railway) + parte pública en claro.
--   8) fiscal_secretos (clave SOL y credenciales API de la GRE, cifradas) y
--      fiscal_auditoria (bitácora sin secretos).
--   9) configuraciones: valores por defecto de las claves fiscal_* (sin pisar nada),
--      incluida la GRE remitente (serie T001, correlativo inicial y punto de partida).
--
-- La API NO ejecuta este script (cero DDL en tiempo de ejecución): al arrancar
-- solo lee el catálogo. Mientras falte, SUNAT directo queda como «migración
-- pendiente» en el panel y Nubefact sigue funcionando exactamente igual.
--
-- Cómo ejecutarlo (en horario de poca venta; tarda menos de un segundo):
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f sql/fase9_sunat_directo.sql
--   o DBeaver sobre la conexión de Railway en modo auto-commit.
-- No lleva BEGIN/COMMIT global: cada bloque es atómico y se puede repetir. Si un
-- bloque falla por lock_timeout (había una transacción larga), vuelva a correrlo.
-- Requiere PostgreSQL 11+ (columnas con DEFAULT sin reescribir la tabla).
-- =============================================================================

-- No quedarse esperando detrás de transacciones largas (y no bloquear a las cajas).
SET lock_timeout = '5s';
SET statement_timeout = '120s';


-- 1) Tipos de comprobante ------------------------------------------------------
INSERT INTO tipos_comprobante (id_tipo, nombre)
SELECT v.id_tipo, v.nombre
  FROM (VALUES (7, 'NOTA DE CREDITO'), (8, 'NOTA DE DEBITO')) AS v(id_tipo, nombre)
 WHERE NOT EXISTS (SELECT 1 FROM tipos_comprobante t WHERE t.id_tipo = v.id_tipo);

-- Solo si están exactamente invertidos (1 = BOLETA y 2 = FACTURA); una sola sentencia.
UPDATE tipos_comprobante t
   SET nombre = CASE t.id_tipo WHEN 1 THEN 'FACTURA' ELSE 'BOLETA' END
 WHERE t.id_tipo IN (1, 2)
   AND EXISTS (SELECT 1 FROM tipos_comprobante WHERE id_tipo = 1 AND upper(nombre) = 'BOLETA')
   AND EXISTS (SELECT 1 FROM tipos_comprobante WHERE id_tipo = 2 AND upper(nombre) = 'FACTURA');

-- La secuencia no debe volver a entregar 7 u 8.
SELECT setval(pg_get_serial_sequence('tipos_comprobante', 'id_tipo'),
              GREATEST((SELECT COALESCE(MAX(id_tipo), 1) FROM tipos_comprobante), 8))
 WHERE pg_get_serial_sequence('tipos_comprobante', 'id_tipo') IS NOT NULL;


-- 2) comprobantes: columnas fiscales (sin tomar locks si ya existen) -----------
DO $$
DECLARE
  c record;
BEGIN
  FOR c IN
    SELECT *
      FROM (VALUES
        -- Con DEFAULT: las filas actuales y las que inserte el flujo de Nubefact quedan como 'nubefact'.
        ('proveedor_fiscal',          'VARCHAR(20) DEFAULT ''nubefact'''),
        ('ambiente_fiscal',           'VARCHAR(12)'),
        ('estado_sunat',              'VARCHAR(30)'),
        ('emitido_en',                'TIMESTAMPTZ'),
        ('fecha_limite_envio',        'DATE'),
        ('sunat_observaciones',       'JSONB'),
        ('forma_pago',                'VARCHAR(10)'),
        ('cuotas',                    'JSONB'),
        ('doc_modificado_tipo',       'VARCHAR(2)'),
        ('doc_modificado_serie',      'VARCHAR(4)'),
        ('doc_modificado_numero',     'INTEGER'),
        ('id_comprobante_modificado', 'INTEGER'),
        ('nota_motivo',               'VARCHAR(2)'),
        ('nota_sustento',             'VARCHAR(250)'),
        ('id_envio_ultimo',           'INTEGER')
      ) AS t(columna, tipo)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema = current_schema()
                      AND table_name = 'comprobantes'
                      AND column_name = c.columna) THEN
      EXECUTE format('ALTER TABLE comprobantes ADD COLUMN %I %s', c.columna, c.tipo);
    END IF;
  END LOOP;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'comprobantes'::regclass AND conname = 'comprobantes_estado_sunat_ck') THEN
    ALTER TABLE comprobantes ADD CONSTRAINT comprobantes_estado_sunat_ck CHECK (
      estado_sunat IS NULL OR estado_sunat IN (
        'NO_ENVIADO', 'POR_RESUMIR', 'ENVIANDO', 'PENDIENTE_REENVIO', 'TICKET_PENDIENTE',
        'ACEPTADO', 'ACEPTADO_OBS', 'RECHAZADO', 'EXCEPCION', 'ERROR_CONFIG',
        'BAJA_PENDIENTE', 'ANULADO')) NOT VALID;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'comprobantes'::regclass AND conname = 'comprobantes_proveedor_fiscal_ck') THEN
    ALTER TABLE comprobantes ADD CONSTRAINT comprobantes_proveedor_fiscal_ck
      CHECK (proveedor_fiscal IS NULL OR proveedor_fiscal IN ('nubefact', 'sunat_directo')) NOT VALID;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'comprobantes'::regclass AND conname = 'comprobantes_ambiente_fiscal_ck') THEN
    ALTER TABLE comprobantes ADD CONSTRAINT comprobantes_ambiente_fiscal_ck
      CHECK (ambiente_fiscal IS NULL OR ambiente_fiscal IN ('beta', 'produccion')) NOT VALID;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'comprobantes'::regclass AND conname = 'comprobantes_forma_pago_ck') THEN
    ALTER TABLE comprobantes ADD CONSTRAINT comprobantes_forma_pago_ck
      CHECK (forma_pago IS NULL OR forma_pago IN ('Contado', 'Credito')) NOT VALID;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'comprobantes'::regclass AND conname = 'comprobantes_id_comprobante_modificado_fkey') THEN
    ALTER TABLE comprobantes ADD CONSTRAINT comprobantes_id_comprobante_modificado_fkey
      FOREIGN KEY (id_comprobante_modificado) REFERENCES comprobantes (id_comprobante) NOT VALID;
  END IF;

  IF to_regclass(format('%I.%I', current_schema(), 'ix_comprobantes_estado_sunat')) IS NULL THEN
    EXECUTE 'CREATE INDEX ix_comprobantes_estado_sunat ON comprobantes (estado_sunat, fecha_limite_envio)
             WHERE estado_sunat IS NOT NULL';
  END IF;

  IF to_regclass(format('%I.%I', current_schema(), 'ix_comprobantes_modificado')) IS NULL THEN
    EXECUTE 'CREATE INDEX ix_comprobantes_modificado ON comprobantes (id_comprobante_modificado)
             WHERE id_comprobante_modificado IS NOT NULL';
  END IF;
END $$;

-- Por si la columna existía de antes sin DEFAULT (no-op en una corrida normal).
UPDATE comprobantes SET proveedor_fiscal = 'nubefact' WHERE proveedor_fiscal IS NULL;


-- 3) productos: código de producto SUNAT (UNSPSC, 8 dígitos) --------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = current_schema()
                    AND table_name = 'productos' AND column_name = 'codigo_sunat') THEN
    ALTER TABLE productos ADD COLUMN codigo_sunat VARCHAR(8);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'productos'::regclass AND conname = 'productos_codigo_sunat_ck') THEN
    ALTER TABLE productos ADD CONSTRAINT productos_codigo_sunat_ck
      CHECK (codigo_sunat IS NULL OR codigo_sunat ~ '^[0-9]{8}$') NOT VALID;
  END IF;
END $$;


-- 4) fiscal_envios: cola, reintentos y tickets -----------------------------------
DO $$
DECLARE
  c record;
BEGIN
  FOR c IN
    SELECT *
      FROM (VALUES
        ('identificador',      'VARCHAR(40)'),
        ('fecha_referencia',   'DATE'),
        ('proximo_intento_en', 'TIMESTAMPTZ'),
        ('bloqueado_hasta',    'TIMESTAMPTZ'),
        ('hash_xml',           'VARCHAR(100)'),
        ('tiempo_ms',          'INTEGER'),
        ('id_usuario',         'INTEGER')
      ) AS t(columna, tipo)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema = current_schema()
                      AND table_name = 'fiscal_envios'
                      AND column_name = c.columna) THEN
      EXECUTE format('ALTER TABLE fiscal_envios ADD COLUMN %I %s', c.columna, c.tipo);
    END IF;
  END LOOP;

  -- Los envíos de prueba antiguos guardan id_comprobante NULL: la FK los admite.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'fiscal_envios'::regclass AND conname = 'fiscal_envios_id_comprobante_fkey') THEN
    ALTER TABLE fiscal_envios ADD CONSTRAINT fiscal_envios_id_comprobante_fkey
      FOREIGN KEY (id_comprobante) REFERENCES comprobantes (id_comprobante) NOT VALID;
  END IF;

  -- Un solo envío en curso por comprobante y operación (idempotencia entre instancias).
  IF to_regclass(format('%I.%I', current_schema(), 'uq_fiscal_envio_en_curso')) IS NULL THEN
    EXECUTE 'CREATE UNIQUE INDEX uq_fiscal_envio_en_curso ON fiscal_envios (id_comprobante, operacion)
             WHERE id_comprobante IS NOT NULL
               AND estado IN (''ENVIANDO'', ''PENDIENTE_REENVIO'', ''TICKET_PENDIENTE'')';
  END IF;

  -- El mismo resumen/baja (RC-/RA-) no se registra dos veces como vigente.
  IF to_regclass(format('%I.%I', current_schema(), 'uq_fiscal_envio_identificador')) IS NULL THEN
    EXECUTE 'CREATE UNIQUE INDEX uq_fiscal_envio_identificador ON fiscal_envios (ambiente, identificador)
             WHERE identificador IS NOT NULL
               AND estado IN (''ENVIANDO'', ''TICKET_PENDIENTE'', ''ACEPTADO'', ''ACEPTADO_OBS'', ''ACEPTADO_CON_OBSERVACIONES'')';
  END IF;

  IF to_regclass(format('%I.%I', current_schema(), 'ix_fiscal_envios_cola')) IS NULL THEN
    EXECUTE 'CREATE INDEX ix_fiscal_envios_cola ON fiscal_envios (estado, proximo_intento_en)
             WHERE estado IN (''PENDIENTE_REENVIO'', ''TICKET_PENDIENTE'')';
  END IF;
END $$;


-- 5) fiscal_artifacts: contenido en la BD (sobrevive al disco efímero de Railway)
DO $$
DECLARE
  c record;
BEGIN
  FOR c IN
    SELECT *
      FROM (VALUES
        ('contenido',      'BYTEA'),
        ('nombre',         'VARCHAR(200)'),
        ('id_comprobante', 'INTEGER')
      ) AS t(columna, tipo)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema = current_schema()
                      AND table_name = 'fiscal_artifacts'
                      AND column_name = c.columna) THEN
      EXECUTE format('ALTER TABLE fiscal_artifacts ADD COLUMN %I %s', c.columna, c.tipo);
    END IF;
  END LOOP;

  -- storage_key es NOT NULL desde fase1: los artefactos guardados en la BD usan 'bd'.
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = current_schema()
                AND table_name = 'fiscal_artifacts'
                AND column_name = 'storage_key'
                AND column_default IS NULL) THEN
    ALTER TABLE fiscal_artifacts ALTER COLUMN storage_key SET DEFAULT 'bd';
  END IF;

  IF to_regclass(format('%I.%I', current_schema(), 'ix_fiscal_artifacts_comprobante')) IS NULL THEN
    EXECUTE 'CREATE INDEX ix_fiscal_artifacts_comprobante
               ON fiscal_artifacts (id_comprobante, tipo_artifacto, creado_en DESC)
             WHERE id_comprobante IS NOT NULL';
  END IF;
END $$;


-- 6) Líneas de resúmenes diarios (RC) y comunicaciones de baja (RA) --------------
CREATE TABLE IF NOT EXISTS fiscal_resumen_lineas (
  id_linea       SERIAL PRIMARY KEY,
  id_envio       INTEGER NOT NULL REFERENCES fiscal_envios (id_envio) ON DELETE CASCADE,
  id_comprobante INTEGER NOT NULL REFERENCES comprobantes (id_comprobante),
  linea          INTEGER NOT NULL,
  condicion      SMALLINT NOT NULL CHECK (condicion IN (1, 2, 3)),
  estado         VARCHAR(30),
  creado_en      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_fiscal_resumen_linea UNIQUE (id_envio, id_comprobante)
);
CREATE INDEX IF NOT EXISTS ix_fiscal_resumen_lineas_comprobante ON fiscal_resumen_lineas (id_comprobante);


-- 7) Certificados digitales cifrados (AES-256-GCM con FISCAL_SECRET_KEY) ---------
-- pfx_cifrado y clave_cifrada: formato 0x01 | IV(12) | TAG(16) | CIPHERTEXT, con
-- AAD atado al ambiente y a la huella. certificado_pem es la parte PÚBLICA.
-- Al reemplazar o eliminar, la fila queda como historial y se vacían los secretos.
CREATE TABLE IF NOT EXISTS fiscal_certificados (
  id_certificado  SERIAL PRIMARY KEY,
  ambiente        VARCHAR(12) NOT NULL CHECK (ambiente IN ('beta', 'produccion')),
  activo          BOOLEAN NOT NULL DEFAULT TRUE,
  pfx_cifrado     BYTEA NOT NULL,
  clave_cifrada   BYTEA NOT NULL,
  version_clave   SMALLINT NOT NULL DEFAULT 1,
  nombre_archivo  VARCHAR(200),
  titular         VARCHAR(300),
  ruc             VARCHAR(11),
  numero_serie    VARCHAR(80),
  emisor          VARCHAR(300),
  vigente_desde   TIMESTAMPTZ NOT NULL,
  vigente_hasta   TIMESTAMPTZ NOT NULL,
  huella_sha256   CHAR(64) NOT NULL,
  bits_clave      INTEGER,
  autofirmado     BOOLEAN NOT NULL DEFAULT FALSE,
  certificado_pem TEXT,
  subido_por      INTEGER,
  subido_en       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  eliminado_por   INTEGER,
  eliminado_en    TIMESTAMPTZ
);
-- Si la tabla ya existía de una versión previa del diseño.
ALTER TABLE fiscal_certificados ADD COLUMN IF NOT EXISTS certificado_pem TEXT;
-- Un solo certificado vigente por ambiente.
CREATE UNIQUE INDEX IF NOT EXISTS uq_fiscal_certificado_activo
  ON fiscal_certificados (ambiente) WHERE activo AND eliminado_en IS NULL;


-- 8) Secretos y auditoría fiscal ------------------------------------------------
-- fiscal_secretos.clave: 'sol_clave' (clave del usuario secundario SOL),
-- 'gre_client_id' y 'gre_client_secret' (SOL › Credenciales de API SUNAT, para la
-- GRE). valor_cifrado = 0x01 | IV | TAG | CIPHERTEXT con AAD 'secreto:<clave>'.
CREATE TABLE IF NOT EXISTS fiscal_secretos (
  clave           VARCHAR(60) PRIMARY KEY,
  valor_cifrado   BYTEA NOT NULL,
  version_clave   SMALLINT NOT NULL DEFAULT 1,
  actualizado_por INTEGER,
  actualizado_en  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Nunca guarda secretos: solo quién, qué, cuándo y desde dónde.
CREATE TABLE IF NOT EXISTS fiscal_auditoria (
  id_auditoria BIGSERIAL PRIMARY KEY,
  creado_en    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  id_usuario   INTEGER,
  accion       VARCHAR(60) NOT NULL,
  entidad      VARCHAR(40),
  id_entidad   VARCHAR(40),
  detalle      JSONB,
  ip           VARCHAR(45)
);
CREATE INDEX IF NOT EXISTS ix_fiscal_auditoria_fecha ON fiscal_auditoria (creado_en DESC);


-- 9) Configuración por defecto (no pisa valores existentes; no depende de fase8) --
-- Los datos del emisor (distrito, provincia, departamento) se derivan en la API de
-- emisor_ubicacion ('LURIN - LIMA - LIMA') hasta que se carguen desde el panel; el
-- ubigeo NO tiene valor por defecto (Lurín es 150119: confírmelo en la Ficha RUC).
-- GRE remitente: fiscal_gre_activa='false' deja las guías como hoy (solo en el
-- sistema). El punto de partida vacío = el domicilio fiscal del emisor.
INSERT INTO configuraciones (clave, valor)
SELECT v.clave, v.valor
  FROM (VALUES
    ('fiscal_proveedor',            'nubefact'),
    ('fiscal_ambiente',             'beta'),
    ('fiscal_boletas_modo',         'individual'),
    ('fiscal_envio_en_linea',       'true'),
    ('fiscal_tareas_activas',       'true'),
    ('fiscal_serie_factura',        'F001'),
    ('fiscal_serie_boleta',         'B001'),
    ('fiscal_serie_nc_factura',     'FC01'),
    ('fiscal_serie_nc_boleta',      'BC01'),
    ('fiscal_serie_nd_factura',     'FD01'),
    ('fiscal_serie_nd_boleta',      'BD01'),
    ('fiscal_serie_gre_remitente',  'T001'),
    ('fiscal_sol_usuario',          ''),
    ('fiscal_codigo_producto_defecto', ''),
    ('fiscal_confirmacion_no_ose',  ''),
    ('fiscal_beta_correlativo',     '0'),
    ('fiscal_aplicar_reglas_2027',  'auto'),
    ('fiscal_gre_activa',           'false'),
    ('fiscal_gre_correlativo_inicial', '1'),
    ('fiscal_gre_partida_ubigeo',   ''),
    ('fiscal_gre_partida_direccion', ''),
    ('fiscal_gre_partida_codigo_establecimiento', '')
  ) AS v(clave, valor)
 WHERE NOT EXISTS (SELECT 1 FROM configuraciones c WHERE c.clave = v.clave);


-- Verificación ----------------------------------------------------------------
-- Debe devolver una fila con todo en true (y tipos = '1,2,3,7,8').
SELECT
  (SELECT string_agg(id_tipo::text, ',' ORDER BY id_tipo) FROM tipos_comprobante)           AS tipos,
  (SELECT nombre FROM tipos_comprobante WHERE id_tipo = 1)                                   AS tipo_1,
  EXISTS (SELECT 1 FROM information_schema.columns
           WHERE table_schema = current_schema() AND table_name = 'comprobantes'
             AND column_name = 'estado_sunat')                                               AS comprobantes_ok,
  EXISTS (SELECT 1 FROM information_schema.columns
           WHERE table_schema = current_schema() AND table_name = 'productos'
             AND column_name = 'codigo_sunat')                                               AS productos_ok,
  EXISTS (SELECT 1 FROM information_schema.columns
           WHERE table_schema = current_schema() AND table_name = 'fiscal_artifacts'
             AND column_name = 'contenido')                                                  AS artefactos_ok,
  to_regclass(format('%I.%I', current_schema(), 'fiscal_certificados')) IS NOT NULL           AS certificados_ok,
  to_regclass(format('%I.%I', current_schema(), 'fiscal_secretos')) IS NOT NULL               AS secretos_ok,
  to_regclass(format('%I.%I', current_schema(), 'fiscal_auditoria')) IS NOT NULL              AS auditoria_ok,
  to_regclass(format('%I.%I', current_schema(), 'fiscal_resumen_lineas')) IS NOT NULL         AS resumenes_ok,
  (SELECT count(*) FROM configuraciones WHERE clave LIKE 'fiscal\_%')                        AS claves_fiscales;

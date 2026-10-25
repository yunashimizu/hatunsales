-- =============================================================================
-- FASE 12 · Emisión directa v2 (factura, boleta y notas en BETA y PRODUCCIÓN)
-- PostgreSQL · idempotente · aditivo (no borra ni reescribe datos)
-- =============================================================================
-- Qué agrega (PLAN V3, D2, D3, D9, D10, D14 y D15):
--   1) comprobantes.hora_emision TIME(0) NULL: hora de emisión de Lima que viaja en
--      el XML (la representación impresa la muestra). Sin esta columna la API emite
--      igual y simplemente no la guarda.
--   2) Resincroniza UNA vez las secuencias de comprobantes y comprobante_items con su
--      MAX: la reserva de número ya no lo hace en cada venta (camino caliente). Solo
--      avanza, nunca devuelve un id ya entregado.
--   3) Índices de consulta: fiscal_envios (ambiente, estado, id_envio DESC) para el
--      panel y la tarea de reintentos; fiscal_artifacts (id_envio, tipo_artifacto,
--      id_artifact DESC) para las descargas y el reenvío del mismo ZIP.
--   4) uq_comprobantes_venta_principal (D10): una venta tiene a lo sumo UNA factura o
--      boleta vigente. Solo se crea si NO hay duplicados; si los hay, avisa (NOTICE)
--      y deja la consulta para encontrarlos. Mientras falte, lo protege la aplicación.
--   5) Triggers de conservación (D9): no se puede borrar un comprobante que ya tiene
--      un envío o un estado SUNAT distinto de NO_ENVIADO (los históricos también se
--      conservan), ni borrar/truncar fiscal_envios o fiscal_artifacts (evidencia del
--      envío: XML firmado, ZIP y CDR). Para anular se usa anulado = true o una nota de
--      crédito, nunca DELETE.
--   6) configuraciones: claves nuevas de la emisión directa (vacías: el panel las llena).
--      fiscal_cpe_correlativo_inicial queda vacía a propósito: el checklist exige que el
--      administrador la revise y la guarde.
--
-- Orden: DESPUÉS de sql/fase9_sunat_directo.sql y sql/guia_remision_directa_v1.sql
-- (usa columnas de la fase 9: id_envio_ultimo, estado_sunat). Es independiente de
-- fase13 (GRE) y fase14 (notas de crédito).
--
-- Cómo ejecutarlo (en horario de poca venta; tarda menos de un segundo):
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f sql/fase12_emision_directa_v2.sql
--   o DBeaver sobre la conexión de Railway en modo auto-commit.
-- No lleva BEGIN/COMMIT global: cada bloque es atómico y se puede repetir. Si un
-- bloque falla por lock_timeout (había una transacción larga), vuelva a correrlo.
-- La API lo detecta sola (consulta el catálogo): no hace falta reiniciarla.
-- Requiere PostgreSQL 11+ (CREATE TRIGGER … EXECUTE FUNCTION).
-- =============================================================================

-- No quedarse esperando detrás de transacciones largas (y no bloquear a las cajas).
SET lock_timeout = '5s';
SET statement_timeout = '120s';


-- 1) comprobantes.hora_emision -------------------------------------------------
DO $$
BEGIN
  IF to_regclass(format('%I.%I', current_schema(), 'comprobantes')) IS NULL THEN
    RAISE NOTICE 'fase12: no existe la tabla comprobantes; se omite hora_emision.';
  ELSIF NOT EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_schema = current_schema()
                       AND table_name = 'comprobantes'
                       AND column_name = 'hora_emision') THEN
    ALTER TABLE comprobantes ADD COLUMN hora_emision TIME(0) NULL;
  END IF;
END $$;


-- 2) Secuencias de comprobantes y comprobante_items (solo hacia adelante) --------
DO $$
DECLARE
  t record;
  secuencia text;
  maximo bigint;
  ultimo bigint;
  llamado boolean;
BEGIN
  FOR t IN
    SELECT *
      FROM (VALUES ('comprobantes', 'id_comprobante'),
                   ('comprobante_items', 'id_item')) AS v(tabla, columna)
  LOOP
    IF to_regclass(format('%I.%I', current_schema(), t.tabla)) IS NULL THEN
      RAISE NOTICE 'fase12: no existe la tabla %; no se resincroniza.', t.tabla;
      CONTINUE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema = current_schema()
                      AND table_name = t.tabla AND column_name = t.columna) THEN
      RAISE NOTICE 'fase12: %.% no existe; no se resincroniza.', t.tabla, t.columna;
      CONTINUE;
    END IF;
    secuencia := pg_get_serial_sequence(format('%I.%I', current_schema(), t.tabla), t.columna);
    IF secuencia IS NULL THEN
      RAISE NOTICE 'fase12: %.% no usa una secuencia; no se resincroniza.', t.tabla, t.columna;
      CONTINUE;
    END IF;
    EXECUTE format('SELECT COALESCE(MAX(%I), 0) FROM %I.%I', t.columna, current_schema(), t.tabla) INTO maximo;
    EXECUTE format('SELECT last_value, is_called FROM %s', secuencia) INTO ultimo, llamado;
    IF maximo > ultimo OR (maximo = ultimo AND maximo > 0 AND NOT llamado) THEN
      PERFORM setval(secuencia, maximo, true);
      RAISE NOTICE 'fase12: la secuencia de % entregará desde % (estaba en %).', t.tabla, maximo + 1, ultimo;
    END IF;
  END LOOP;
END $$;


-- 3) Índices de fiscal_envios y fiscal_artifacts --------------------------------
DO $$
BEGIN
  IF to_regclass(format('%I.%I', current_schema(), 'fiscal_envios')) IS NOT NULL
     AND to_regclass(format('%I.%I', current_schema(), 'ix_fiscal_envios_ambiente_estado')) IS NULL THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS ix_fiscal_envios_ambiente_estado
               ON fiscal_envios (ambiente, estado, id_envio DESC)';
  END IF;

  IF to_regclass(format('%I.%I', current_schema(), 'fiscal_artifacts')) IS NOT NULL
     AND to_regclass(format('%I.%I', current_schema(), 'ix_fiscal_artifacts_envio_tipo')) IS NULL THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS ix_fiscal_artifacts_envio_tipo
               ON fiscal_artifacts (id_envio, tipo_artifacto, id_artifact DESC)';
  END IF;
END $$;


-- 4) Una sola factura o boleta vigente por venta (D10) --------------------------
-- Si hay duplicados NO se crea: revíselos con esta consulta, anule (anulado = true)
-- o emita la nota de crédito que corresponda y vuelva a correr el script:
--   SELECT id_venta, array_agg(id_comprobante ORDER BY id_comprobante) AS comprobantes,
--          array_agg(serie || '-' || numero ORDER BY id_comprobante) AS numeros
--     FROM comprobantes
--    WHERE id_tipo IN (1, 2) AND id_venta IS NOT NULL
--      AND COALESCE(anulado, false) = false AND COALESCE(estado, '') <> 'error'
--    GROUP BY id_venta
--   HAVING count(*) > 1;
DO $$
DECLARE
  duplicadas integer;
BEGIN
  IF to_regclass(format('%I.%I', current_schema(), 'comprobantes')) IS NULL THEN
    RAISE NOTICE 'fase12: no existe la tabla comprobantes; se omite uq_comprobantes_venta_principal.';
    RETURN;
  END IF;
  IF to_regclass(format('%I.%I', current_schema(), 'uq_comprobantes_venta_principal')) IS NOT NULL THEN
    RETURN;
  END IF;

  SELECT count(*) INTO duplicadas
    FROM (SELECT id_venta
            FROM comprobantes
           WHERE id_tipo IN (1, 2) AND id_venta IS NOT NULL
             AND COALESCE(anulado, false) = false AND COALESCE(estado, '') <> 'error'
           GROUP BY id_venta
          HAVING count(*) > 1) AS d;

  IF duplicadas > 0 THEN
    RAISE NOTICE 'fase12: % venta(s) tienen más de una factura o boleta vigente; NO se creó uq_comprobantes_venta_principal. Revíselas con la consulta del paso 4 y vuelva a ejecutar el script.', duplicadas;
  ELSE
    EXECUTE 'CREATE UNIQUE INDEX uq_comprobantes_venta_principal
               ON comprobantes (id_venta)
            WHERE id_tipo IN (1, 2) AND id_venta IS NOT NULL
              AND COALESCE(anulado, false) = false AND COALESCE(estado, '''') <> ''error''';
  END IF;
END $$;


-- 5) Triggers de conservación (D9) ----------------------------------------------
CREATE OR REPLACE FUNCTION fiscal_impedir_borrado_comprobante() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.id_envio_ultimo IS NOT NULL OR OLD.estado_sunat IS DISTINCT FROM 'NO_ENVIADO' THEN
    RAISE EXCEPTION 'No se puede borrar el comprobante % (%-%): ya tiene un envío o un estado ante SUNAT. Anúlelo (anulado = true) o emita una nota de crédito.',
      OLD.id_comprobante, OLD.serie, OLD.numero
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN OLD;
END $$;

CREATE OR REPLACE FUNCTION fiscal_impedir_borrado_evidencia() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'La tabla % guarda la evidencia de los envíos a SUNAT (XML firmado, ZIP y CDR): no se borra ni se trunca.', TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END $$;

DO $$
BEGIN
  IF to_regclass(format('%I.%I', current_schema(), 'comprobantes')) IS NOT NULL
     AND EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = current_schema() AND table_name = 'comprobantes'
                    AND column_name = 'id_envio_ultimo')
     AND EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = current_schema() AND table_name = 'comprobantes'
                    AND column_name = 'estado_sunat')
     AND NOT EXISTS (SELECT 1 FROM pg_trigger
                      WHERE tgrelid = format('%I.%I', current_schema(), 'comprobantes')::regclass
                        AND tgname = 'tr_comprobantes_conservar') THEN
    CREATE TRIGGER tr_comprobantes_conservar
      BEFORE DELETE ON comprobantes
      FOR EACH ROW EXECUTE FUNCTION fiscal_impedir_borrado_comprobante();
  END IF;

  IF to_regclass(format('%I.%I', current_schema(), 'fiscal_envios')) IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger
                    WHERE tgrelid = format('%I.%I', current_schema(), 'fiscal_envios')::regclass
                      AND tgname = 'tr_fiscal_envios_conservar') THEN
      CREATE TRIGGER tr_fiscal_envios_conservar
        BEFORE DELETE ON fiscal_envios
        FOR EACH ROW EXECUTE FUNCTION fiscal_impedir_borrado_evidencia();
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_trigger
                    WHERE tgrelid = format('%I.%I', current_schema(), 'fiscal_envios')::regclass
                      AND tgname = 'tr_fiscal_envios_sin_truncate') THEN
      CREATE TRIGGER tr_fiscal_envios_sin_truncate
        BEFORE TRUNCATE ON fiscal_envios
        FOR EACH STATEMENT EXECUTE FUNCTION fiscal_impedir_borrado_evidencia();
    END IF;
  END IF;

  IF to_regclass(format('%I.%I', current_schema(), 'fiscal_artifacts')) IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger
                    WHERE tgrelid = format('%I.%I', current_schema(), 'fiscal_artifacts')::regclass
                      AND tgname = 'tr_fiscal_artifacts_conservar') THEN
      CREATE TRIGGER tr_fiscal_artifacts_conservar
        BEFORE DELETE ON fiscal_artifacts
        FOR EACH ROW EXECUTE FUNCTION fiscal_impedir_borrado_evidencia();
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_trigger
                    WHERE tgrelid = format('%I.%I', current_schema(), 'fiscal_artifacts')::regclass
                      AND tgname = 'tr_fiscal_artifacts_sin_truncate') THEN
      CREATE TRIGGER tr_fiscal_artifacts_sin_truncate
        BEFORE TRUNCATE ON fiscal_artifacts
        FOR EACH STATEMENT EXECUTE FUNCTION fiscal_impedir_borrado_evidencia();
    END IF;
  END IF;
END $$;


-- 6) Claves nuevas de configuraciones (no pisa valores existentes; sin ON CONFLICT) --
-- fiscal_beta_pos_directo     'true' = el POS emite comprobantes de prueba en SUNAT BETA.
-- fiscal_cpe_correlativo_inicial  JSON {"F001": 1, ...}: primer número libre por serie (vacío = sin revisar).
-- fiscal_cert_ruc_confirmado_produccion  'true' = el admin confirmó que el certificado sin RUC legible es del emisor.
-- fiscal_confirma_*           'true' = declaraciones del checklist de activación (D1.4).
-- fiscal_emision_bloqueada_*  JSON {codigo, motivo, fecha} cuando SUNAT rechazó la credencial o el certificado.
INSERT INTO configuraciones (clave, valor)
SELECT v.clave, v.valor
  FROM (VALUES
    ('fiscal_beta_pos_directo',                 'false'),
    ('fiscal_cpe_correlativo_inicial',          ''),
    ('fiscal_cert_ruc_confirmado_produccion',   ''),
    ('fiscal_confirma_emisor_electronico_sol',  ''),
    ('fiscal_confirma_certificado_en_sol',      ''),
    ('fiscal_confirma_usuario_sol_secundario',  ''),
    ('fiscal_confirma_ruc_habido',              ''),
    ('fiscal_emision_bloqueada_beta',           ''),
    ('fiscal_emision_bloqueada_produccion',     '')
  ) AS v(clave, valor)
 WHERE NOT EXISTS (SELECT 1 FROM configuraciones c WHERE c.clave = v.clave);


-- Verificación ----------------------------------------------------------------
-- Debe devolver una fila con todo en true (venta_principal puede quedar en false si
-- el paso 4 avisó duplicados; resuélvalos y vuelva a correr el script).
SELECT
  EXISTS (SELECT 1 FROM information_schema.columns
           WHERE table_schema = current_schema() AND table_name = 'comprobantes'
             AND column_name = 'hora_emision')                                              AS hora_emision_ok,
  to_regclass(format('%I.%I', current_schema(), 'ix_fiscal_envios_ambiente_estado')) IS NOT NULL AS indice_envios_ok,
  to_regclass(format('%I.%I', current_schema(), 'ix_fiscal_artifacts_envio_tipo')) IS NOT NULL   AS indice_artefactos_ok,
  to_regclass(format('%I.%I', current_schema(), 'uq_comprobantes_venta_principal')) IS NOT NULL  AS venta_principal_ok,
  (SELECT count(*) FROM pg_trigger
    WHERE tgname IN ('tr_comprobantes_conservar', 'tr_fiscal_envios_conservar', 'tr_fiscal_envios_sin_truncate',
                     'tr_fiscal_artifacts_conservar', 'tr_fiscal_artifacts_sin_truncate')) = 5      AS triggers_ok,
  (SELECT count(*) FROM configuraciones
    WHERE clave IN ('fiscal_beta_pos_directo', 'fiscal_cpe_correlativo_inicial', 'fiscal_cert_ruc_confirmado_produccion',
                    'fiscal_confirma_emisor_electronico_sol', 'fiscal_confirma_certificado_en_sol',
                    'fiscal_confirma_usuario_sol_secundario', 'fiscal_confirma_ruc_habido',
                    'fiscal_emision_bloqueada_beta', 'fiscal_emision_bloqueada_produccion')) >= 9 AS claves_ok,
  (SELECT COALESCE(MAX(id_comprobante), 0) FROM comprobantes)                               AS max_id_comprobante;

-- La secuencia debe ir por delante del máximo (si no, la próxima reserva chocaría):
--   SELECT pg_sequence_last_value(pg_get_serial_sequence('comprobantes', 'id_comprobante')::regclass) AS ultimo_id_entregado,
--          (SELECT MAX(id_comprobante) FROM comprobantes) AS maximo;
-- Prueba de los triggers (dentro de una transacción que se revierte):
--   BEGIN; DELETE FROM fiscal_artifacts; ROLLBACK;            -- debe fallar si hay filas
--   BEGIN; TRUNCATE fiscal_envios CASCADE; ROLLBACK;          -- debe fallar siempre

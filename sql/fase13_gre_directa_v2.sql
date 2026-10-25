-- =============================================================================
-- FASE 13 · Guía de Remisión Electrónica remitente v2 (API REST de SUNAT)
-- PostgreSQL · idempotente · aditivo (no borra ni reescribe datos)
-- =============================================================================
-- Qué agrega (PLAN V3, D10, D11 y D15):
--   1) uq_fiscal_envio_gre_en_curso: un solo envío ABIERTO (ENVIANDO, TICKET_PENDIENTE o
--      PENDIENTE_REENVIO) por guía y operación: dos procesos o dos instancias nunca registran
--      a la vez dos envíos de la misma guía. Solo se crea si no hay duplicados (si los hay,
--      avisa con NOTICE y deja la consulta para revisarlos). Mientras falte, la aplicación lo
--      verifica dentro de la transacción de la emisión (bloquea la fila del envío abierto).
--   2) ix_guias_remision_items_guia: guias_remision_items (id_guia), para leer los bienes de
--      una guía y sumar lo que ya llevan las guías de una venta (tope por producto). Se omite
--      si ya existe otro índice que empiece por id_guia.
--   3) ix_fiscal_envios_guia_reciente: fiscal_envios (id_guia, id_envio DESC), para el último
--      envío de cada guía (listado, detalle, descargas y consulta del ticket). Se omite si ya
--      existe otro índice que empiece por id_guia (producción ya tiene idx_fiscal_envios_guia).
-- No agrega columnas: los datos del formulario que no tienen columna propia (descripción del
-- motivo, códigos de establecimiento, registro MTC, tarjeta de circulación, nombres y apellidos
-- del conductor) van en guias_remision.payload_sunat.
--
-- Orden: DESPUÉS de sql/fase9_sunat_directo.sql y sql/guia_remision_directa_v1.sql (usa
-- fiscal_envios.id_guia y las columnas de la GRE). Es independiente de fase12 y fase14.
--
-- Cómo ejecutarlo (tarda menos de un segundo):
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f sql/fase13_gre_directa_v2.sql
--   o DBeaver sobre la conexión de Railway en modo auto-commit.
-- No lleva BEGIN/COMMIT global: cada bloque es atómico y se puede repetir. Si un bloque falla
-- por lock_timeout (había una transacción larga), vuelva a correrlo. La API funciona igual sin
-- este script (la verificación en la transacción protege del doble envío).
-- =============================================================================

-- No quedarse esperando detrás de transacciones largas (y no bloquear a las cajas).
SET lock_timeout = '5s';
SET statement_timeout = '120s';


-- 1) Un solo envío abierto por guía (anti doble envío) ----------------------------
-- Si el paso avisa duplicados NO crea el índice: revíselos con esta consulta, deje abierto
-- solo el último envío de cada guía (los demás a ERROR_CONFIG) y vuelva a correr el script:
--   SELECT id_guia, operacion,
--          array_agg(id_envio ORDER BY id_envio) AS envios,
--          array_agg(estado ORDER BY id_envio)   AS estados
--     FROM fiscal_envios
--    WHERE id_guia IS NOT NULL AND estado IN ('ENVIANDO', 'TICKET_PENDIENTE', 'PENDIENTE_REENVIO')
--    GROUP BY id_guia, operacion
--   HAVING count(*) > 1;
DO $$
DECLARE
  duplicadas integer;
BEGIN
  IF to_regclass(format('%I.%I', current_schema(), 'fiscal_envios')) IS NULL
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_schema = current_schema()
                       AND table_name = 'fiscal_envios'
                       AND column_name = 'id_guia') THEN
    RAISE NOTICE 'fase13: no existe fiscal_envios.id_guia (aplique antes sql/fase9_sunat_directo.sql); se omite uq_fiscal_envio_gre_en_curso.';
    RETURN;
  END IF;
  IF to_regclass(format('%I.%I', current_schema(), 'uq_fiscal_envio_gre_en_curso')) IS NOT NULL THEN
    RETURN;
  END IF;

  SELECT count(*) INTO duplicadas
    FROM (SELECT id_guia, operacion
            FROM fiscal_envios
           WHERE id_guia IS NOT NULL
             AND estado IN ('ENVIANDO', 'TICKET_PENDIENTE', 'PENDIENTE_REENVIO')
           GROUP BY id_guia, operacion
          HAVING count(*) > 1) AS d;

  IF duplicadas > 0 THEN
    RAISE NOTICE 'fase13: % guía(s) tienen más de un envío abierto; NO se creó uq_fiscal_envio_gre_en_curso. Revíselas con la consulta del paso 1 y vuelva a ejecutar el script.', duplicadas;
  ELSE
    EXECUTE 'CREATE UNIQUE INDEX uq_fiscal_envio_gre_en_curso
               ON fiscal_envios (id_guia, operacion)
            WHERE id_guia IS NOT NULL
              AND estado IN (''ENVIANDO'', ''TICKET_PENDIENTE'', ''PENDIENTE_REENVIO'')';
  END IF;
END $$;


-- 2) guias_remision_items (id_guia) -------------------------------------------------
DO $$
BEGIN
  IF to_regclass(format('%I.%I', current_schema(), 'guias_remision_items')) IS NULL THEN
    RAISE NOTICE 'fase13: no existe la tabla guias_remision_items; se omite ix_guias_remision_items_guia.';
    RETURN;
  END IF;
  -- Cualquier índice que empiece por id_guia (con este u otro nombre) ya sirve.
  IF to_regclass(format('%I.%I', current_schema(), 'ix_guias_remision_items_guia')) IS NOT NULL
     OR EXISTS (SELECT 1
                  FROM pg_index i
                  JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
                 WHERE i.indrelid = format('%I.%I', current_schema(), 'guias_remision_items')::regclass
                   AND a.attname = 'id_guia') THEN
    RETURN;
  END IF;
  EXECUTE 'CREATE INDEX ix_guias_remision_items_guia ON guias_remision_items (id_guia)';
END $$;


-- 3) fiscal_envios (id_guia, id_envio DESC) -----------------------------------------
DO $$
BEGIN
  IF to_regclass(format('%I.%I', current_schema(), 'fiscal_envios')) IS NULL
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_schema = current_schema()
                       AND table_name = 'fiscal_envios'
                       AND column_name = 'id_guia') THEN
    RAISE NOTICE 'fase13: no existe fiscal_envios.id_guia; se omite ix_fiscal_envios_guia_reciente.';
    RETURN;
  END IF;
  -- Cualquier índice que empiece por id_guia ya sirve: cada guía tiene unos pocos envíos.
  IF to_regclass(format('%I.%I', current_schema(), 'ix_fiscal_envios_guia_reciente')) IS NOT NULL
     OR EXISTS (SELECT 1
                  FROM pg_index i
                  JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
                 WHERE i.indrelid = format('%I.%I', current_schema(), 'fiscal_envios')::regclass
                   AND a.attname = 'id_guia') THEN
    RETURN;
  END IF;
  EXECUTE 'CREATE INDEX ix_fiscal_envios_guia_reciente
             ON fiscal_envios (id_guia, id_envio DESC)
          WHERE id_guia IS NOT NULL';
END $$;


-- Verificación ----------------------------------------------------------------------
-- Debe devolver una fila con todo en true (envio_en_curso_ok puede quedar en false si el
-- paso 1 avisó duplicados; resuélvalos y vuelva a correr el script).
SELECT
  to_regclass(format('%I.%I', current_schema(), 'uq_fiscal_envio_gre_en_curso')) IS NOT NULL AS envio_en_curso_ok,
  EXISTS (SELECT 1
            FROM pg_index i
            JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
           WHERE i.indrelid = to_regclass(format('%I.%I', current_schema(), 'guias_remision_items'))
             AND a.attname = 'id_guia')                                                   AS items_guia_ok,
  EXISTS (SELECT 1
            FROM pg_index i
            JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
           WHERE i.indrelid = to_regclass(format('%I.%I', current_schema(), 'fiscal_envios'))
             AND a.attname = 'id_guia')                                                   AS envios_guia_ok;

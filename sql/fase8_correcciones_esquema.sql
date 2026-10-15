-- =============================================================================
-- FASE 8 · Correcciones de esquema (PostgreSQL, idempotente, no borra datos)
-- =============================================================================
-- Diagnóstico del 2026-10-06 contra la BD de Railway (en modo solo lectura):
-- TODOS los scripts de sql/, db/patch_schema.sql y doc/*.sql ya están
-- aplicados. Lo que el código usa y la base todavía no tiene es solo esto:
--
-- 1) movimientos_inventario.tipo es el enum tipo_movimiento_inv con los
--    valores (entrada, salida, ajuste). No existe 'transferencia', así que
--    TODA transferencia entre almacenes fallaba con
--    "invalid input value for enum tipo_movimiento_inv".
--    (Desde esta versión la API también lo agrega sola al arrancar.)
--
-- 2) configuraciones no tiene índice único en `clave`. El guardado de datos
--    del emisor / series usaba ON CONFLICT (clave) y fallaba siempre.
--    (La API ya no depende de él, pero el índice impide claves duplicadas y
--    permite correr sql/series_fiscales_config_v1.sql.)
--
-- 3) Opcional: validar los CHECK / FK de guías que se crearon NOT VALID en
--    guia_remision_directa_v1.sql (hoy solo protegen filas nuevas).
--
-- Cómo ejecutarlo: DBeaver sobre la conexión de Railway (auto-commit), o
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f sql/fase8_correcciones_esquema.sql
-- Se puede correr varias veces.
-- =============================================================================

-- 1) Tipo de movimiento 'transferencia' ------------------------------------
-- (Va suelto, fuera de BEGIN/COMMIT: en PostgreSQL < 12 ADD VALUE no se
--  permite dentro de una transacción.)
ALTER TYPE tipo_movimiento_inv ADD VALUE IF NOT EXISTS 'transferencia';


-- 2) Clave única en configuraciones ----------------------------------------
DO $$
DECLARE
  v_duplicadas text;
BEGIN
  SELECT string_agg(clave, ', ')
    INTO v_duplicadas
    FROM (SELECT clave FROM configuraciones GROUP BY clave HAVING COUNT(*) > 1) d;

  IF v_duplicadas IS NOT NULL THEN
    RAISE WARNING 'configuraciones tiene claves repetidas (%). Deje una fila por clave y vuelva a correr el script.', v_duplicadas;
  ELSE
    CREATE UNIQUE INDEX IF NOT EXISTS uq_configuraciones_clave ON configuraciones (clave);
  END IF;
END $$;


-- 3) Validar constraints NOT VALID de guías (opcional, no bloquea lecturas) --
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT conrelid::regclass AS tabla, conname
      FROM pg_constraint
     WHERE NOT convalidated
       AND conname IN (
         'guias_remision_id_usuario_fkey',
         'guias_remision_datos_basicos_ck',
         'guias_remision_item_cantidad_ck',
         'guias_remision_envios_id_usuario_fkey'
       )
  LOOP
    BEGIN
      EXECUTE format('ALTER TABLE %s VALIDATE CONSTRAINT %I', r.tabla, r.conname);
      RAISE NOTICE 'Constraint % validado', r.conname;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'No se pudo validar % (%). Queda NOT VALID: protege solo filas nuevas.', r.conname, SQLERRM;
    END;
  END LOOP;
END $$;


-- Verificación ---------------------------------------------------------------
-- Debe listar: entrada, salida, ajuste, transferencia
SELECT e.enumlabel AS tipo_movimiento
  FROM pg_enum e
  JOIN pg_type t ON t.oid = e.enumtypid
 WHERE t.typname = 'tipo_movimiento_inv'
 ORDER BY e.enumsortorder;

-- Debe aparecer uq_configuraciones_clave
SELECT indexname FROM pg_indexes WHERE tablename = 'configuraciones' ORDER BY indexname;

-- convalidated = true en los cuatro (si alguno queda false, ver el WARNING)
SELECT conname, convalidated
  FROM pg_constraint
 WHERE conname IN (
   'guias_remision_id_usuario_fkey',
   'guias_remision_datos_basicos_ck',
   'guias_remision_item_cantidad_ck',
   'guias_remision_envios_id_usuario_fkey'
 )
 ORDER BY conname;

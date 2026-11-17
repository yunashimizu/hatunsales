-- =============================================================================
-- FASE 18 · Concurrencia entre locales e índices que faltan
-- PostgreSQL 12+ · idempotente · aditivo (solo crea índices y lee: no toca datos)
-- =============================================================================
-- Propósito (doc/PLAN_CONCURRENCIA_SEGURIDAD_VELOCIDAD.md, §2 A10; auditoría del 2026-11-09):
--   1) Índices de velocidad (V4, V5):
--      * ix_comprobante_correos_comprobante  comprobante_correos (id_comprobante): la tarea de
--        correos (cada 30 s) busca por comprobante con NOT EXISTS y los índices parciales de
--        fase17 no le sirven; hoy recorre la tabla entera.
--      * ix_comprobante_items_producto  comprobante_items (id_producto): reportes por producto.
--      * ix_recepcion_items_recepcion, ix_recepcion_observaciones_recepcion y
--        ix_recepcion_adjuntos_observacion: el detalle de una recepción. Esas tres tablas las
--        crea la API la primera vez que se usa Recepción, así que sus índices van solo si la
--        tabla ya existe (ver el bloque 1b).
--   2) Diagnóstico, SOLO LECTURA: DNI repetidos en clientes, RUC repetidos en empresas y
--      aperturas de caja con más de un cierre. Devuelve filas para revisarlas; no cambia nada.
--   3) Red de seguridad, COMENTADA: índices únicos para clientes (dni), empresas (ruc) y
--      cierres_caja (id_apertura). Actívela solo cuando el diagnóstico salga VACÍO (con
--      duplicados, el CREATE UNIQUE INDEX falla y deja un índice INVALID).
--
-- La API ya no crea fichas duplicadas ni cierra dos veces aunque este script no se corra
-- (candado consultivo por DNI/RUC al guardar; el cierre bloquea la fila de la apertura con
-- FOR UPDATE y comprueba que no tenga cierre); los únicos son una red adicional.
-- cierres_caja ya tiene ix_cierres_caja_apertura (fase11, no único): uq_cierres_caja_apertura
-- lo vuelve redundante; puede borrarse después a mano, este script no lo toca.
--
-- Orden: DESPUÉS de fase15, fase16 y fase17 (fase17 crea comprobante_correos).
--
-- Cómo ejecutarlo (con los datos de hoy tarda menos de un segundo y no bloquea las ventas):
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f sql/fase18_concurrencia_e_indices.sql
--   o DBeaver en modo auto-commit con "Ejecutar script" (sentencia por sentencia).
-- NO use -1 / --single-transaction ni lo pegue como un solo bloque en una consola web:
-- CREATE INDEX CONCURRENTLY no puede ir dentro de una transacción ("cannot run inside a
-- transaction block").
-- CONCURRENTLY construye el índice sin bloquear lecturas ni escrituras, pero espera a que
-- terminen las transacciones ya abiertas (como mucho lock_timeout = 5 s). Si una sentencia
-- falla por eso, el índice puede quedar INVALID (existe pero no se usa y IF NOT EXISTS ya no
-- lo reconstruye): vuelva a correr el script y el aviso del final le dará el DROP exacto
-- para ejecutarlo a mano antes de una tercera pasada.
--
-- Sin este script la API funciona igual: los índices no cambian ningún resultado.
--
-- Verificación posterior (filas con indisvalid = true; las de recepción solo si la tabla existe):
--   SELECT c.relname AS indice, i.indisvalid
--     FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
--    WHERE c.relname IN ('ix_comprobante_correos_comprobante', 'ix_comprobante_items_producto',
--                        'ix_recepcion_items_recepcion', 'ix_recepcion_observaciones_recepcion',
--                        'ix_recepcion_adjuntos_observacion');
-- =============================================================================

SET lock_timeout = '5s';
SET statement_timeout = '15min';


-- 1a) Índices de velocidad en tablas que siempre existen ------------------------------
CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_comprobante_correos_comprobante
  ON comprobante_correos (id_comprobante);

CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_comprobante_items_producto
  ON comprobante_items (id_producto);


-- 1b) Recepción: solo si la tabla existe -----------------------------------------------
-- CREATE INDEX CONCURRENTLY no puede ir dentro de un bloque DO (el DO es una transacción) y
-- SQL plano no tiene IF. Por eso estos tres van SIN CONCURRENTLY dentro del DO: son tablas
-- pequeñas (decenas o cientos de filas), el índice se construye en milisegundos y el candado
-- que toma (SHARE, bloquea escrituras en ESA tabla, no en ventas ni inventario) dura lo mismo.
DO $$
BEGIN
  IF to_regclass(format('%I.%I', current_schema(), 'recepcion_items')) IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS ix_recepcion_items_recepcion ON recepcion_items (id_recepcion);
  ELSE
    RAISE NOTICE 'recepcion_items no existe todavía (se crea al usar Recepción): sin índice por ahora.';
  END IF;

  IF to_regclass(format('%I.%I', current_schema(), 'recepcion_observaciones')) IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS ix_recepcion_observaciones_recepcion ON recepcion_observaciones (id_recepcion);
  ELSE
    RAISE NOTICE 'recepcion_observaciones no existe todavía: sin índice por ahora.';
  END IF;

  IF to_regclass(format('%I.%I', current_schema(), 'recepcion_adjuntos')) IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS ix_recepcion_adjuntos_observacion ON recepcion_adjuntos (id_observacion);
  ELSE
    RAISE NOTICE 'recepcion_adjuntos no existe todavía: sin índice por ahora.';
  END IF;
END $$;


-- 2) Diagnóstico (solo lectura) --------------------------------------------------------
-- Cada consulta debe salir VACÍA antes de activar el bloque 3. Si sale algo, junte las fichas
-- repetidas a mano (ventas, cuentas por cobrar y comprobantes apuntan a una de ellas).

-- 2.1) DNI con más de una ficha en clientes
SELECT dni, COUNT(*) AS fichas, array_agg(id_cliente ORDER BY id_cliente) AS ids_cliente
  FROM clientes
 WHERE dni IS NOT NULL
 GROUP BY dni
HAVING COUNT(*) > 1
 ORDER BY fichas DESC, dni;

-- 2.2) RUC con más de una ficha en empresas
SELECT ruc, COUNT(*) AS fichas, array_agg(id_empresa ORDER BY id_empresa) AS ids_empresa
  FROM empresas
 WHERE ruc IS NOT NULL AND ruc <> ''
 GROUP BY ruc
HAVING COUNT(*) > 1
 ORDER BY fichas DESC, ruc;

-- 2.3) Aperturas de caja con más de un cierre
SELECT id_apertura, COUNT(*) AS cierres, array_agg(id_cierre ORDER BY id_cierre) AS ids_cierre
  FROM cierres_caja
 WHERE id_apertura IS NOT NULL
 GROUP BY id_apertura
HAVING COUNT(*) > 1
 ORDER BY id_apertura;


-- 3) Red de seguridad (COMENTADA: actívela solo con el diagnóstico vacío) ---------------
-- Quite los dos guiones de las tres sentencias y vuelva a correr el script. Si alguna falla
-- por duplicados, revise el diagnóstico: el índice queda INVALID y el aviso final da el DROP.
--
-- CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS uq_clientes_dni
--   ON clientes (dni)
--   WHERE dni IS NOT NULL;
--
-- CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS uq_empresas_ruc
--   ON empresas (ruc)
--   WHERE ruc IS NOT NULL AND ruc <> '';
--
-- CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS uq_cierres_caja_apertura
--   ON cierres_caja (id_apertura)
--   WHERE id_apertura IS NOT NULL;


-- Resumen --------------------------------------------------------------------------
-- Un CONCURRENTLY que falla deja el índice INVALID: PostgreSQL lo mantiene en cada
-- escritura pero nunca lo usa para leer. Este script no borra nada: da el DROP exacto.
-- Los de recepción se informan solo si su tabla existe; los únicos del bloque 3, solo si existen.
DO $$
DECLARE
  v_nombre text;
  v_tabla text;
  v_valido boolean;
  v_opcional boolean;
BEGIN
  FOR v_nombre, v_tabla, v_opcional IN
    SELECT * FROM (VALUES
      ('ix_comprobante_correos_comprobante', 'comprobante_correos', FALSE),
      ('ix_comprobante_items_producto', 'comprobante_items', FALSE),
      ('ix_recepcion_items_recepcion', 'recepcion_items', TRUE),
      ('ix_recepcion_observaciones_recepcion', 'recepcion_observaciones', TRUE),
      ('ix_recepcion_adjuntos_observacion', 'recepcion_adjuntos', TRUE),
      ('uq_clientes_dni', 'clientes', TRUE),
      ('uq_empresas_ruc', 'empresas', TRUE),
      ('uq_cierres_caja_apertura', 'cierres_caja', TRUE)
    ) AS t(nombre, tabla, opcional)
  LOOP
    IF to_regclass(format('%I.%I', current_schema(), v_tabla)) IS NULL THEN
      CONTINUE;
    END IF;
    SELECT i.indisvalid INTO v_valido
      FROM pg_index i
     WHERE i.indexrelid = to_regclass(format('%I.%I', current_schema(), v_nombre));
    IF v_valido IS NULL THEN
      IF NOT v_opcional THEN
        RAISE NOTICE '%: FALTA (ver el error anterior) - vuelva a correr el script.', v_nombre;
      ELSIF v_nombre LIKE 'ix\_%' THEN
        RAISE NOTICE '%: FALTA (ver el error anterior) - vuelva a correr el script.', v_nombre;
      END IF;
    ELSIF NOT v_valido THEN
      RAISE NOTICE '%: INVALID (su construcción falló) - ejecute DROP INDEX CONCURRENTLY IF EXISTS %; y vuelva a correr el script.',
        v_nombre, v_nombre;
    ELSE
      RAISE NOTICE '%: OK', v_nombre;
    END IF;
  END LOOP;
END $$;

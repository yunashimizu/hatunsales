-- =============================================================================
-- FASE 14 · Notas de crédito enlazadas a su origen y a la venta (efectos al aceptarse)
-- PostgreSQL · idempotente · aditivo (no borra ni reescribe datos)
-- =============================================================================
-- Qué agrega (PLAN V3, D8, D9 y D15):
--   1) comprobante_items.id_item_origen INTEGER NULL: en una nota de crédito, el ítem
--      del comprobante origen que acredita (lleva la cuenta de lo ya devuelto o
--      descontado por línea). FK NOT VALID a comprobante_items(id_item) e índice
--      parcial. Null en las líneas de ajuste de los motivos por monto (09 y 10).
--   2) comprobantes.efecto_nota VARCHAR(20) NULL ('ninguno' | 'devolucion' |
--      'anular_venta', CHECK NOT VALID): qué hace el sistema cuando SUNAT ACEPTA la
--      nota (nunca antes). Null en los comprobantes que no son notas y en las notas
--      históricas: esas nunca reciben efectos automáticos.
--   3) comprobantes.reingresar_stock BOOLEAN NULL: con efecto 'devolucion', si lo
--      devuelto vuelve al almacén de donde salió.
--   4) comprobantes.efectos_aplicados BOOLEAN NOT NULL DEFAULT false y
--      comprobantes.efectos_aplicados_en TIMESTAMPTZ NULL: los efectos se aplican UNA
--      sola vez (UPDATE ... WHERE efectos_aplicados = false RETURNING en la misma
--      transacción que el stock y la cuenta por cobrar).
--   5) venta_stock_salida.cantidad_devuelta NUMERIC(12,3) NOT NULL DEFAULT 0 con
--      CHECK NOT VALID (0 <= cantidad_devuelta <= cantidad): unidades de cada salida
--      ya resueltas por una devolución (nota de crédito o anulación de la venta). Así
--      el stock nunca vuelve dos veces al almacén.
--   6) ix_comprobantes_nc_efectos_pendientes: índice parcial de las notas con efectos
--      por aplicar (lo recorre el barrido de cada 5 minutos).
--   7) uq_comprobantes_nc_total: a lo sumo UNA nota de crédito total vigente (motivos
--      01, 02 y 06) por comprobante. Solo se crea si NO hay duplicados; si los hay,
--      avisa (NOTICE) y deja la consulta para encontrarlos. Mientras falte, lo protege
--      la aplicación (candado nc:<origen> dentro de la transacción).
--
-- Orden: DESPUÉS de sql/fase4_anulacion.sql (venta_stock_salida) y de
-- sql/fase9_sunat_directo.sql (id_comprobante_modificado, nota_motivo, estado_sunat).
-- Es independiente de fase12 (emisión) y fase13 (GRE).
--
-- Cómo ejecutarlo (en horario de poca venta; tarda menos de un segundo):
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f sql/fase14_notas_credito_enlace.sql
--   o DBeaver sobre la conexión de Railway en modo auto-commit.
-- No lleva BEGIN/COMMIT global: cada bloque es atómico y se puede repetir. Si un
-- bloque falla por lock_timeout (había una transacción larga), vuelva a correrlo.
-- Sin este script la API funciona igual que antes y las notas de crédito responden
-- 503 «Aplique sql/fase14_notas_credito_enlace.sql para habilitar las notas de
-- crédito». La API lo detecta sola (relee el catálogo cada minuto): no hace falta
-- reiniciarla.
-- Requiere PostgreSQL 11+ (columna NOT NULL con DEFAULT sin reescribir la tabla).
-- =============================================================================

-- No quedarse esperando detrás de transacciones largas (y no bloquear a las cajas).
SET lock_timeout = '5s';
SET statement_timeout = '120s';


-- 1) comprobante_items.id_item_origen + FK NOT VALID + índice parcial --------------
DO $$
BEGIN
  IF to_regclass(format('%I.%I', current_schema(), 'comprobante_items')) IS NULL THEN
    RAISE NOTICE 'fase14: no existe la tabla comprobante_items; se omite id_item_origen.';
    RETURN;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = current_schema()
                    AND table_name = 'comprobante_items'
                    AND column_name = 'id_item_origen') THEN
    ALTER TABLE comprobante_items ADD COLUMN id_item_origen INTEGER NULL;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = format('%I.%I', current_schema(), 'comprobante_items')::regclass
                    AND conname = 'comprobante_items_id_item_origen_fkey') THEN
    ALTER TABLE comprobante_items
      ADD CONSTRAINT comprobante_items_id_item_origen_fkey
      FOREIGN KEY (id_item_origen) REFERENCES comprobante_items (id_item) NOT VALID;
  END IF;

  IF to_regclass(format('%I.%I', current_schema(), 'ix_comprobante_items_origen')) IS NULL THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS ix_comprobante_items_origen
               ON comprobante_items (id_item_origen)
            WHERE id_item_origen IS NOT NULL';
  END IF;
END $$;


-- 2) a 4) Columnas de efectos de la nota en comprobantes ---------------------------
DO $$
BEGIN
  IF to_regclass(format('%I.%I', current_schema(), 'comprobantes')) IS NULL THEN
    RAISE NOTICE 'fase14: no existe la tabla comprobantes; se omiten las columnas de efectos.';
    RETURN;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = current_schema() AND table_name = 'comprobantes'
                    AND column_name = 'efecto_nota') THEN
    ALTER TABLE comprobantes ADD COLUMN efecto_nota VARCHAR(20) NULL;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = format('%I.%I', current_schema(), 'comprobantes')::regclass
                    AND conname = 'comprobantes_efecto_nota_ck') THEN
    ALTER TABLE comprobantes
      ADD CONSTRAINT comprobantes_efecto_nota_ck
      CHECK (efecto_nota IS NULL OR efecto_nota IN ('ninguno', 'devolucion', 'anular_venta')) NOT VALID;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = current_schema() AND table_name = 'comprobantes'
                    AND column_name = 'reingresar_stock') THEN
    ALTER TABLE comprobantes ADD COLUMN reingresar_stock BOOLEAN NULL;
  END IF;

  -- Las filas existentes quedan en false, pero sin efecto_nota: el barrido no las toca.
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = current_schema() AND table_name = 'comprobantes'
                    AND column_name = 'efectos_aplicados') THEN
    ALTER TABLE comprobantes ADD COLUMN efectos_aplicados BOOLEAN NOT NULL DEFAULT false;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = current_schema() AND table_name = 'comprobantes'
                    AND column_name = 'efectos_aplicados_en') THEN
    ALTER TABLE comprobantes ADD COLUMN efectos_aplicados_en TIMESTAMPTZ NULL;
  END IF;
END $$;


-- 5) venta_stock_salida.cantidad_devuelta + CHECK NOT VALID ------------------------
DO $$
BEGIN
  IF to_regclass(format('%I.%I', current_schema(), 'venta_stock_salida')) IS NULL THEN
    RAISE NOTICE 'fase14: no existe la tabla venta_stock_salida (falta sql/fase4_anulacion.sql); se omite cantidad_devuelta.';
    RETURN;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = current_schema() AND table_name = 'venta_stock_salida'
                    AND column_name = 'cantidad_devuelta') THEN
    ALTER TABLE venta_stock_salida ADD COLUMN cantidad_devuelta NUMERIC(12,3) NOT NULL DEFAULT 0;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = format('%I.%I', current_schema(), 'venta_stock_salida')::regclass
                    AND conname = 'venta_stock_salida_cantidad_devuelta_ck') THEN
    ALTER TABLE venta_stock_salida
      ADD CONSTRAINT venta_stock_salida_cantidad_devuelta_ck
      CHECK (cantidad_devuelta >= 0 AND cantidad_devuelta <= cantidad) NOT VALID;
  END IF;
END $$;


-- 6) Índice de notas con efectos pendientes (barrido de 5 minutos) -----------------
DO $$
BEGIN
  IF to_regclass(format('%I.%I', current_schema(), 'comprobantes')) IS NULL
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_schema = current_schema() AND table_name = 'comprobantes'
                       AND column_name = 'efectos_aplicados')
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_schema = current_schema() AND table_name = 'comprobantes'
                       AND column_name = 'efecto_nota') THEN
    RAISE NOTICE 'fase14: faltan las columnas de efectos; se omite ix_comprobantes_nc_efectos_pendientes.';
    RETURN;
  END IF;

  IF to_regclass(format('%I.%I', current_schema(), 'ix_comprobantes_nc_efectos_pendientes')) IS NULL THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS ix_comprobantes_nc_efectos_pendientes
               ON comprobantes (id_comprobante)
            WHERE id_tipo = 7 AND efectos_aplicados = false AND efecto_nota IS NOT NULL';
  END IF;
END $$;


-- 7) Una sola nota de crédito TOTAL vigente por comprobante --------------------------
-- Si hay duplicados NO se crea: revíselos con esta consulta, anule (anulado = true) la
-- que no corresponda y vuelva a correr el script:
--   SELECT id_comprobante_modificado,
--          array_agg(id_comprobante ORDER BY id_comprobante) AS notas,
--          array_agg(serie || '-' || numero ORDER BY id_comprobante) AS numeros
--     FROM comprobantes
--    WHERE id_tipo = 7 AND nota_motivo IN ('01', '02', '06')
--      AND COALESCE(anulado, false) = false AND COALESCE(estado, '') <> 'error'
--      AND COALESCE(estado_sunat, '') <> 'RECHAZADO'
--    GROUP BY id_comprobante_modificado
--   HAVING count(*) > 1;
DO $$
DECLARE
  duplicadas integer;
BEGIN
  IF to_regclass(format('%I.%I', current_schema(), 'comprobantes')) IS NULL
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_schema = current_schema() AND table_name = 'comprobantes'
                       AND column_name = 'id_comprobante_modificado')
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_schema = current_schema() AND table_name = 'comprobantes'
                       AND column_name = 'nota_motivo') THEN
    RAISE NOTICE 'fase14: faltan columnas de sql/fase9_sunat_directo.sql; se omite uq_comprobantes_nc_total.';
    RETURN;
  END IF;
  IF to_regclass(format('%I.%I', current_schema(), 'uq_comprobantes_nc_total')) IS NOT NULL THEN
    RETURN;
  END IF;

  SELECT count(*) INTO duplicadas
    FROM (SELECT id_comprobante_modificado
            FROM comprobantes
           WHERE id_tipo = 7 AND nota_motivo IN ('01', '02', '06')
             AND COALESCE(anulado, false) = false AND COALESCE(estado, '') <> 'error'
             AND COALESCE(estado_sunat, '') <> 'RECHAZADO'
           GROUP BY id_comprobante_modificado
          HAVING count(*) > 1) AS d;

  IF duplicadas > 0 THEN
    RAISE NOTICE 'fase14: % comprobante(s) tienen más de una nota de crédito total vigente; NO se creó uq_comprobantes_nc_total. Revíselos con la consulta del paso 7 y vuelva a ejecutar el script.', duplicadas;
  ELSE
    EXECUTE 'CREATE UNIQUE INDEX uq_comprobantes_nc_total
               ON comprobantes (id_comprobante_modificado)
            WHERE id_tipo = 7 AND nota_motivo IN (''01'', ''02'', ''06'')
              AND COALESCE(anulado, false) = false AND COALESCE(estado, '''') <> ''error''
              AND COALESCE(estado_sunat, '''') <> ''RECHAZADO''';
  END IF;
END $$;


-- Verificación ----------------------------------------------------------------
-- Debe devolver una fila con todo en true (nc_total_ok puede quedar en false si el
-- paso 7 avisó duplicados; resuélvalos y vuelva a correr el script).
SELECT
  EXISTS (SELECT 1 FROM information_schema.columns
           WHERE table_schema = current_schema() AND table_name = 'comprobante_items'
             AND column_name = 'id_item_origen')                                              AS id_item_origen_ok,
  (SELECT count(*) FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'comprobantes'
      AND column_name IN ('efecto_nota', 'reingresar_stock', 'efectos_aplicados', 'efectos_aplicados_en')) = 4
                                                                                              AS efectos_ok,
  EXISTS (SELECT 1 FROM information_schema.columns
           WHERE table_schema = current_schema() AND table_name = 'venta_stock_salida'
             AND column_name = 'cantidad_devuelta')                                           AS cantidad_devuelta_ok,
  (SELECT count(*) FROM pg_constraint
    WHERE conname IN ('comprobante_items_id_item_origen_fkey', 'comprobantes_efecto_nota_ck',
                      'venta_stock_salida_cantidad_devuelta_ck')) = 3                          AS restricciones_ok,
  to_regclass(format('%I.%I', current_schema(), 'ix_comprobante_items_origen')) IS NOT NULL            AS indice_origen_ok,
  to_regclass(format('%I.%I', current_schema(), 'ix_comprobantes_nc_efectos_pendientes')) IS NOT NULL  AS indice_pendientes_ok,
  to_regclass(format('%I.%I', current_schema(), 'uq_comprobantes_nc_total')) IS NOT NULL               AS nc_total_ok;

-- Las restricciones NOT VALID se pueden validar después, en horario tranquilo (no
-- bloquean escrituras; recorren la tabla una vez):
--   ALTER TABLE comprobante_items VALIDATE CONSTRAINT comprobante_items_id_item_origen_fkey;
--   ALTER TABLE comprobantes VALIDATE CONSTRAINT comprobantes_efecto_nota_ck;
--   ALTER TABLE venta_stock_salida VALIDATE CONSTRAINT venta_stock_salida_cantidad_devuelta_ck;

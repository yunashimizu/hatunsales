-- =============================================================================
-- FASE 20 · Caja y devoluciones coherentes (SQL-7)
-- PostgreSQL 12+ · idempotente · aditivo (solo agrega columnas NULL y un índice; no toca datos)
-- =============================================================================
-- Propósito (doc/PLAN_ESCRIBIR_MENOS_Y_VENDER_CON_CONTROL.md, Fase 7, R14):
--   1) movimientos_caja.id_venta: el egreso que devuelve efectivo de una venta (anulación de una venta de
--      OTRO turno, o devolución parcial con la venta activa) queda enlazado a esa venta. Con él la API sabe
--      cuánto ya se devolvió y no deja devolver dos veces. NULL = movimiento manual o anterior a fase20.
--      Índice parcial (solo filas con venta): la tabla es chica y casi todas sus filas no lo llevan.
--   2) movimientos_caja.categoria y movimientos_caja.nro_comprobante: el gasto de caja con su categoría
--      (lista cerrada en la API: transporte, servicios, compras_menores, devolucion, otro) y el número del
--      comprobante del gasto (boleta, recibo), ambos opcionales.
--   3) cierres_caja.automatico: TRUE en los cierres que hizo la tarea de cierre automático de turnos
--      olvidados (sin conteo de efectivo). NULL = cierre hecho por una persona o anterior a fase20.
--
-- Qué NO hace: no rellena nada (no hay UPDATE) ni inserta claves de configuración. Sin claves:
--   anulacion_credito_con_abonos = bloquear, arqueo_ciego = apagado, caja_cierre_automatico_horas = 0.
--
-- Sin este script la API funciona igual que antes (capacidades movimientoVenta, gastoCategoria,
-- gastoComprobante y cierreAutomatico de caja/esquema/esquema-caja.service.ts): un reembolso en efectivo
-- pedido al anular responde 503 sin anular nada, el gasto se guarda sin categoría ni número y el cierre
-- automático (si alguien lo enciende) se marca solo en la observación y en la bitácora. Tras correrlo, la
-- API lo detecta sola en menos de un minuto, sin reiniciar.
--
-- Orden: DESPUÉS de fase11 (movimientos_caja.id_apertura). No depende de fase19.
--
-- Cómo ejecutarlo (tarda segundos):
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f sql/fase20_caja_devoluciones.sql
--   o DBeaver en modo auto-commit con "Ejecutar script" (sentencia por sentencia).
-- NO use -1 / --single-transaction: CREATE INDEX CONCURRENTLY no puede ir dentro de una transacción.
-- ADD COLUMN sin valor por defecto solo cambia el catálogo; lock_timeout = 5 s hace que, si un cierre o un
-- egreso largo tiene ocupada la tabla, la sentencia falle en vez de dejar en cola a las cajas. Si falla por
-- eso, vuelva a correr el script (es idempotente). Si el índice queda INVALID, el aviso del final da el DROP.
--
-- Verificación posterior (debe devolver 4 filas con existe = true):
--   SELECT 'movimientos_caja.id_venta' AS objeto, EXISTS (SELECT 1 FROM information_schema.columns
--            WHERE table_schema = 'public' AND table_name = 'movimientos_caja' AND column_name = 'id_venta') AS existe
--   UNION ALL SELECT 'movimientos_caja.categoria', EXISTS (SELECT 1 FROM information_schema.columns
--            WHERE table_schema = 'public' AND table_name = 'movimientos_caja' AND column_name = 'categoria')
--   UNION ALL SELECT 'movimientos_caja.nro_comprobante', EXISTS (SELECT 1 FROM information_schema.columns
--            WHERE table_schema = 'public' AND table_name = 'movimientos_caja' AND column_name = 'nro_comprobante')
--   UNION ALL SELECT 'cierres_caja.automatico', EXISTS (SELECT 1 FROM information_schema.columns
--            WHERE table_schema = 'public' AND table_name = 'cierres_caja' AND column_name = 'automatico');
-- =============================================================================

SET lock_timeout = '5s';
SET statement_timeout = '15min';


-- 1) Egreso enlazado a la venta que se devuelve ----------------------------------------------
ALTER TABLE public.movimientos_caja ADD COLUMN IF NOT EXISTS id_venta INTEGER NULL;

COMMENT ON COLUMN public.movimientos_caja.id_venta IS
  'Venta cuyo efectivo devuelve este egreso (Fase 7.1, sin llave foránea). NULL: movimiento manual o anterior a fase20.';

CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_movimientos_caja_venta
  ON public.movimientos_caja (id_venta)
  WHERE id_venta IS NOT NULL;


-- 2) Gasto de caja con categoría y comprobante ------------------------------------------------
ALTER TABLE public.movimientos_caja ADD COLUMN IF NOT EXISTS categoria VARCHAR(30) NULL;
ALTER TABLE public.movimientos_caja ADD COLUMN IF NOT EXISTS nro_comprobante VARCHAR(40) NULL;

COMMENT ON COLUMN public.movimientos_caja.categoria IS
  'Categoría del gasto (lista cerrada en la API: transporte, servicios, compras_menores, devolucion, otro). NULL: sin categoría.';
COMMENT ON COLUMN public.movimientos_caja.nro_comprobante IS
  'Número del comprobante del gasto (boleta, recibo), opcional.';


-- 3) Marca del cierre automático ----------------------------------------------------------------
ALTER TABLE public.cierres_caja ADD COLUMN IF NOT EXISTS automatico BOOLEAN NULL;

COMMENT ON COLUMN public.cierres_caja.automatico IS
  'TRUE: lo cerró la tarea de turnos olvidados (Fase 7.4), sin conteo. NULL: cierre de una persona o anterior a fase20.';


-- 4) Aviso si el índice concurrente quedó a medias ------------------------------------------
DO $$
DECLARE
  invalido record;
BEGIN
  FOR invalido IN
    SELECT c.relname
      FROM pg_index i
      JOIN pg_class c ON c.oid = i.indexrelid
     WHERE c.relname = 'ix_movimientos_caja_venta' AND NOT i.indisvalid
  LOOP
    RAISE WARNING 'El índice % quedó INVALID. Ejecute: DROP INDEX CONCURRENTLY public.%; y vuelva a correr el script.',
      invalido.relname, invalido.relname;
  END LOOP;
END
$$;

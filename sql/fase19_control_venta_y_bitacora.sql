-- =============================================================================
-- FASE 19 · Quién vendió, a qué costo y bitácora de acciones
-- PostgreSQL 12+ · idempotente · aditivo (solo agrega columnas NULL, una tabla e índices; no toca datos)
-- =============================================================================
-- Propósito (doc/PLAN_ESCRIBIR_MENOS_Y_VENDER_CON_CONTROL.md, Fase 6, SQL-6):
--   1) ventas.id_usuario e ventas.id_almacen: quién vendió y desde qué almacén. Índice (id_usuario, fecha)
--      para el reporte «Ventas por vendedor y por local».
--   2) detalle_venta.costo_unitario: el costo de cada línea al momento de vender (NULL = el producto no
--      tenía costo; «sin costo» no es «costo cero»). La rentabilidad deja de reescribir el pasado cuando
--      cambia productos.precio_compra.
--   2b) detalle_venta.precio_referencia: el precio de catálogo neto que calculó el servidor para esa
--      cantidad (precio y descuento del producto más la regla mayorista). Con él el reporte por vendedor
--      muestra en soles la rebaja que el cajero hizo cambiando el precio. NULL = sin referencia (producto
--      sin precio en la base) o venta anterior a fase19.
--   3) recepcion_items.precio_compra: el costo de cada ítem recibido. Esa tabla la crea la API la primera
--      vez que se usa Recepción: si todavía no existe, este paso no hace nada (la API ya la crea con la
--      columna) y el script no falla.
--   4) Tabla bitacora_acciones: quién hizo qué (anulaciones, notas de crédito, ajustes de stock, cambios de
--      precio y costo, productos eliminados, cierres de caja ajenos, ventas sin descontar stock y, desde la
--      Tanda B2, rebajas sobre el tope). SIN llaves foráneas hacia usuarios ni almacenes: la bitácora
--      sobrevive al borrado de un usuario.
--
-- Qué NO hace: no rellena el autor ni el costo de las ventas antiguas (no hay UPDATE). El autor de las
-- ventas viejas se puede deducir del turno de caja con sql/opcional_autor_ventas_antiguas.sql (aparte,
-- opcional). No inserta claves de configuración: sin ellas el control de rebajas (Tanda B2) queda en modo
-- «registrar» con tope 10 %.
--
-- Sin este script la API funciona igual que antes (capacidades ventaAutor, ventaCosto, ventaReferencia, recepcionCosto y
-- bitacora de caja/esquema/esquema-caja.service.ts): no guarda autor ni costo, la bitácora solo va al log y
-- la rentabilidad usa el precio de compra vigente. Tras correrlo, la API lo detecta sola en menos de un
-- minuto, sin reiniciar.
--
-- Orden: DESPUÉS de fase11 a fase18 (no depende de ninguna en particular; ventas y detalle_venta son del
-- esquema base).
--
-- Cómo ejecutarlo (con los datos de hoy tarda segundos y no bloquea las ventas más de un instante):
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f sql/fase19_control_venta_y_bitacora.sql
--   o DBeaver en modo auto-commit con "Ejecutar script" (sentencia por sentencia).
-- NO use -1 / --single-transaction ni lo pegue como un solo bloque en una consola web:
-- CREATE INDEX CONCURRENTLY no puede ir dentro de una transacción ("cannot run inside a
-- transaction block").
-- ADD COLUMN sin valor por defecto solo cambia el catálogo (no reescribe la tabla), pero necesita un candado
-- exclusivo breve sobre ventas y detalle_venta: lock_timeout = 5 s hace que, si una venta larga lo tiene
-- ocupado, la sentencia falle en vez de dejar en cola a las cajas. Si falla por eso, vuelva a correr el
-- script (es idempotente). Si el índice ix_ventas_usuario_fecha queda INVALID (CONCURRENTLY interrumpido),
-- el aviso del final da el DROP exacto para correrlo a mano antes de una nueva pasada.
--
-- Verificación posterior (debe devolver 6 filas con existe = true; la de recepcion_items puede ser
-- false solo si Recepción nunca se usó):
--   SELECT 'ventas.id_usuario' AS objeto, EXISTS (SELECT 1 FROM information_schema.columns
--            WHERE table_schema = 'public' AND table_name = 'ventas' AND column_name = 'id_usuario') AS existe
--   UNION ALL SELECT 'ventas.id_almacen', EXISTS (SELECT 1 FROM information_schema.columns
--            WHERE table_schema = 'public' AND table_name = 'ventas' AND column_name = 'id_almacen')
--   UNION ALL SELECT 'detalle_venta.costo_unitario', EXISTS (SELECT 1 FROM information_schema.columns
--            WHERE table_schema = 'public' AND table_name = 'detalle_venta' AND column_name = 'costo_unitario')
--   UNION ALL SELECT 'detalle_venta.precio_referencia', EXISTS (SELECT 1 FROM information_schema.columns
--            WHERE table_schema = 'public' AND table_name = 'detalle_venta' AND column_name = 'precio_referencia')
--   UNION ALL SELECT 'recepcion_items.precio_compra', EXISTS (SELECT 1 FROM information_schema.columns
--            WHERE table_schema = 'public' AND table_name = 'recepcion_items' AND column_name = 'precio_compra')
--   UNION ALL SELECT 'bitacora_acciones', to_regclass('public.bitacora_acciones') IS NOT NULL;
-- =============================================================================

SET lock_timeout = '5s';
SET statement_timeout = '15min';


-- 1) Autor y almacén de la venta ------------------------------------------------------
ALTER TABLE public.ventas ADD COLUMN IF NOT EXISTS id_usuario INTEGER NULL;
ALTER TABLE public.ventas ADD COLUMN IF NOT EXISTS id_almacen INTEGER NULL;

COMMENT ON COLUMN public.ventas.id_usuario IS
  'Quién registró la venta (usuarios.id_usuario, sin llave foránea). NULL: venta web o anterior a fase19.';
COMMENT ON COLUMN public.ventas.id_almacen IS
  'Almacén del POS (o del pedido web) desde el que se vendió. NULL: anterior a fase19 o sin almacén único.';

-- Reporte por vendedor: filtra por fecha y agrupa por usuario. CONCURRENTLY: no bloquea las ventas.
CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_ventas_usuario_fecha
  ON public.ventas (id_usuario, fecha);


-- 2) Costo de cada línea vendida --------------------------------------------------------
ALTER TABLE public.detalle_venta ADD COLUMN IF NOT EXISTS costo_unitario NUMERIC(12,4) NULL;

COMMENT ON COLUMN public.detalle_venta.costo_unitario IS
  'productos.precio_compra al momento de vender. NULL: el producto no tenía costo (no es costo cero) o venta anterior a fase19.';

ALTER TABLE public.detalle_venta ADD COLUMN IF NOT EXISTS precio_referencia NUMERIC(12,2) NULL;

COMMENT ON COLUMN public.detalle_venta.precio_referencia IS
  'Precio de catálogo neto (servidor) para esa cantidad al vender. Rebaja = (precio_referencia - precio_unitario_final) x cantidad si es positiva. NULL: sin referencia o venta anterior a fase19.';


-- 3) Costo de cada ítem recibido (solo si Recepción ya creó su tabla) --------------------
DO $$
BEGIN
  IF to_regclass('public.recepcion_items') IS NOT NULL THEN
    ALTER TABLE public.recepcion_items ADD COLUMN IF NOT EXISTS precio_compra NUMERIC(12,4) NULL;
    COMMENT ON COLUMN public.recepcion_items.precio_compra IS
      'Costo de compra informado en la recepción (el mismo que se copia a productos.precio_compra). NULL: no se informó.';
  ELSE
    RAISE NOTICE 'recepcion_items no existe todavía: la API la creará con la columna precio_compra.';
  END IF;
END
$$;


-- 4) Bitácora de acciones -----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.bitacora_acciones (
  id              BIGSERIAL PRIMARY KEY,
  fecha           TIMESTAMPTZ NOT NULL DEFAULT now(),
  id_usuario      INTEGER NULL,
  rol             VARCHAR(30) NULL,
  id_autorizador  INTEGER NULL,
  id_almacen      INTEGER NULL,
  accion          VARCHAR(60) NOT NULL,
  entidad         VARCHAR(40) NULL,
  id_entidad      BIGINT NULL,
  antes           JSONB NULL,
  despues         JSONB NULL,
  motivo          TEXT NULL,
  ip              VARCHAR(60) NULL
);

COMMENT ON TABLE public.bitacora_acciones IS
  'Quién hizo qué (Fase 6.3). Sin llaves foráneas a usuarios/almacenes a propósito: sobrevive al borrado. Solo INSERT desde la API.';

-- Tabla nueva y vacía: los índices se crean al instante (sin CONCURRENTLY).
CREATE INDEX IF NOT EXISTS ix_bitacora_fecha         ON public.bitacora_acciones (fecha);
CREATE INDEX IF NOT EXISTS ix_bitacora_usuario_fecha ON public.bitacora_acciones (id_usuario, fecha);
CREATE INDEX IF NOT EXISTS ix_bitacora_accion_fecha  ON public.bitacora_acciones (accion, fecha);
CREATE INDEX IF NOT EXISTS ix_bitacora_entidad       ON public.bitacora_acciones (entidad, id_entidad);


-- 5) Aviso si el índice concurrente quedó a medias -----------------------------------------
DO $$
DECLARE
  invalido record;
BEGIN
  FOR invalido IN
    SELECT c.relname
      FROM pg_index i
      JOIN pg_class c ON c.oid = i.indexrelid
     WHERE c.relname = 'ix_ventas_usuario_fecha' AND NOT i.indisvalid
  LOOP
    RAISE WARNING 'El índice % quedó INVALID. Ejecute: DROP INDEX CONCURRENTLY public.%; y vuelva a correr el script.',
      invalido.relname, invalido.relname;
  END LOOP;
END
$$;

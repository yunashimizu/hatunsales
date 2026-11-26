-- =============================================================================
-- FASE 21 · Stock confiable, pedidos web y usuarios por local (SQL-8)
-- PostgreSQL 12+ · idempotente · aditivo (solo agrega columnas NULL; no toca datos)
-- =============================================================================
-- Propósito (doc/PLAN_ESCRIBIR_MENOS_Y_VENDER_CON_CONTROL.md, Fase 8):
--   1) movimientos_inventario con rastro (8.1): quién movió el stock (id_usuario), en qué almacén
--      (id_almacen; hasta hoy solo se guardaba la sucursal de origen o destino) y por qué documento
--      (tipo_documento + id_documento: venta, anulacion, nota_credito, recepcion, observacion_recepcion,
--      ajuste, transferencia, pedido, alta_producto). Todas NULL: los movimientos anteriores quedan como
--      estaban y uno hecho por el sistema (pedido web) no lleva usuario. Sin llaves foráneas (igual que
--      fase19): un usuario o un almacén dado de baja no impide guardar ni borrar nada.
--   2) usuario_sucursal (8.5, D7): la tabla YA EXISTE en producción con su llave primaria (R9). Aquí
--      solo se crea si faltara (instalación nueva) y se agrega la llave primaria si faltara. Vacía =
--      nadie restringido: todo usuario conserva el comportamiento de hoy hasta que el dueño asigne.
--   3) Índice único (id_proveedor, guía) en recepciones (8.4): va COMENTADO al final. Antes corra
--      sql/diagnostico_recepciones_duplicadas.sql (solo lectura) y actívelo solo si sale vacío.
--
-- Qué NO hace: no rellena nada (no hay UPDATE) ni inserta claves de configuración. Sin claves:
--   pedido_vencimiento_horas_pasarela = 0 y pedido_vencimiento_horas_transferencia = 0 (apagado: ningún
--   pedido vence solo) y recepcion_guia_repetida = avisar (solo informa en la respuesta).
--
-- Sin este script la API funciona igual que antes (capacidades movimientoUsuario, movimientoAlmacen,
-- movimientoDocumento y usuarioSucursal de caja/esquema/esquema-caja.service.ts): los movimientos se
-- guardan como hoy (sin usuario, almacén ni documento) y la lectura de movimientos los devuelve con esos
-- campos en null. Tras correrlo la API lo detecta sola en menos de un minuto, sin reiniciar.
--
-- Orden: no depende de fase19 ni de fase20.
--
-- Cómo ejecutarlo (tarda segundos):
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f sql/fase21_stock_y_pedidos.sql
--   o DBeaver en modo auto-commit con "Ejecutar script" (sentencia por sentencia).
-- ADD COLUMN sin valor por defecto solo cambia el catálogo; lock_timeout = 5 s hace que, si una venta larga
-- tiene ocupada la tabla, la sentencia falle en vez de dejar en cola al mostrador. Si falla por eso, vuelva a
-- correr el script (es idempotente).
--
-- Verificación posterior (debe devolver 5 filas con existe = true):
--   SELECT 'movimientos_inventario.id_usuario' AS objeto, EXISTS (SELECT 1 FROM information_schema.columns
--            WHERE table_schema = 'public' AND table_name = 'movimientos_inventario' AND column_name = 'id_usuario') AS existe
--   UNION ALL SELECT 'movimientos_inventario.id_almacen', EXISTS (SELECT 1 FROM information_schema.columns
--            WHERE table_schema = 'public' AND table_name = 'movimientos_inventario' AND column_name = 'id_almacen')
--   UNION ALL SELECT 'movimientos_inventario.tipo_documento', EXISTS (SELECT 1 FROM information_schema.columns
--            WHERE table_schema = 'public' AND table_name = 'movimientos_inventario' AND column_name = 'tipo_documento')
--   UNION ALL SELECT 'movimientos_inventario.id_documento', EXISTS (SELECT 1 FROM information_schema.columns
--            WHERE table_schema = 'public' AND table_name = 'movimientos_inventario' AND column_name = 'id_documento')
--   UNION ALL SELECT 'usuario_sucursal (llave primaria)', EXISTS (SELECT 1 FROM pg_constraint
--            WHERE conrelid = 'public.usuario_sucursal'::regclass AND contype = 'p');
-- =============================================================================

SET lock_timeout = '5s';
SET statement_timeout = '15min';


-- 1) Movimientos de stock con rastro (8.1) -----------------------------------------------------
ALTER TABLE public.movimientos_inventario ADD COLUMN IF NOT EXISTS id_usuario INTEGER NULL;
ALTER TABLE public.movimientos_inventario ADD COLUMN IF NOT EXISTS id_almacen INTEGER NULL;
ALTER TABLE public.movimientos_inventario ADD COLUMN IF NOT EXISTS tipo_documento VARCHAR(30) NULL;
ALTER TABLE public.movimientos_inventario ADD COLUMN IF NOT EXISTS id_documento INTEGER NULL;

COMMENT ON COLUMN public.movimientos_inventario.id_usuario IS
  'Quién movió el stock (Fase 8.1, sin llave foránea). NULL: lo movió el sistema (pedido web) o es anterior a fase21.';
COMMENT ON COLUMN public.movimientos_inventario.id_almacen IS
  'Almacén del movimiento (en una transferencia, el de origen). NULL: anterior a fase21.';
COMMENT ON COLUMN public.movimientos_inventario.tipo_documento IS
  'Origen: venta, anulacion, nota_credito, recepcion, observacion_recepcion, ajuste, transferencia, pedido, alta_producto. NULL: anterior a fase21.';
COMMENT ON COLUMN public.movimientos_inventario.id_documento IS
  'Id del documento de origen (venta, comprobante de la nota, recepción, observación, pedido o producto). NULL en ajustes y transferencias.';


-- 2) usuario_sucursal (8.5): solo si faltara --------------------------------------------------
-- En producción ya existe con PRIMARY KEY (id_usuario, id_sucursal) y llaves foráneas: ambas
-- sentencias no hacen nada allí.
CREATE TABLE IF NOT EXISTS public.usuario_sucursal (
  id_usuario  INTEGER NOT NULL REFERENCES public.usuarios(id_usuario),
  id_sucursal INTEGER NOT NULL REFERENCES public.sucursales(id_sucursal),
  PRIMARY KEY (id_usuario, id_sucursal)
);

DO $$
DECLARE
  duplicados integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.usuario_sucursal'::regclass AND contype = 'p') THEN
    SELECT COUNT(*) INTO duplicados FROM (
      SELECT id_usuario, id_sucursal FROM public.usuario_sucursal
       GROUP BY id_usuario, id_sucursal HAVING COUNT(*) > 1
    ) d;
    IF duplicados > 0 THEN
      RAISE WARNING 'usuario_sucursal tiene % pares repetidos: no se agregó la llave primaria. Quite los repetidos y vuelva a correr el script.', duplicados;
    ELSIF EXISTS (SELECT 1 FROM public.usuario_sucursal WHERE id_usuario IS NULL OR id_sucursal IS NULL) THEN
      RAISE WARNING 'usuario_sucursal tiene filas con id_usuario o id_sucursal vacío: no se agregó la llave primaria.';
    ELSE
      ALTER TABLE public.usuario_sucursal ADD CONSTRAINT usuario_sucursal_pkey PRIMARY KEY (id_usuario, id_sucursal);
      RAISE NOTICE 'Llave primaria de usuario_sucursal agregada.';
    END IF;
  END IF;
END
$$;


-- 3) Guía de recepción única por proveedor (8.4) · COMENTADO ---------------------------------
-- Primero corra sql/diagnostico_recepciones_duplicadas.sql (solo lectura). Actívelo SOLO si su consulta
-- principal sale vacía: quite los guiones de la sentencia y vuelva a correr este script (es idempotente).
-- CONCURRENTLY no bloquea las recepciones mientras se crea; si falla por duplicados el índice queda INVALID
-- y el aviso del bloque 4 da el DROP exacto.
--
-- OJO: con el índice activo, una guía repetida del mismo proveedor ya no se puede registrar NUNCA, ni siquiera
-- con «confirmar_guia_repetida: true» (la API responde 409 RECEPCION_GUIA_REPETIDA). Sin el índice, la regla
-- la decide la clave recepcion_guia_repetida (avisar · bloquear) en Configuración.
--
-- CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS uq_recepciones_proveedor_guia
--   ON public.recepciones (id_proveedor, UPPER(BTRIM(nro_guia)))
--   WHERE BTRIM(nro_guia) <> '';


-- 4) Aviso si el índice del bloque 3 quedó a medias ------------------------------------------
DO $$
DECLARE
  invalido record;
BEGIN
  FOR invalido IN
    SELECT c.relname
      FROM pg_index i
      JOIN pg_class c ON c.oid = i.indexrelid
     WHERE c.relname = 'uq_recepciones_proveedor_guia' AND NOT i.indisvalid
  LOOP
    RAISE WARNING 'El índice % quedó INVALID (hay guías repetidas). Ejecute: DROP INDEX CONCURRENTLY public.%; revise el diagnóstico y vuelva a intentarlo.',
      invalido.relname, invalido.relname;
  END LOOP;
END
$$;

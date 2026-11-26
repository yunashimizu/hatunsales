-- =============================================================================
-- FASE 22 · Almacén con dirección, ubigeo y código de establecimiento (SQL de la Fase 4.4)
-- PostgreSQL 12+ · idempotente · aditivo (solo agrega columnas NULL; no toca datos)
-- =============================================================================
-- Propósito (doc/PLAN_ESCRIBIR_MENOS_Y_VENDER_CON_CONTROL.md, Fase 4.4, R10):
--   almacenes.direccion, almacenes.ubigeo y almacenes.codigo_establecimiento: el punto de partida de la
--   guía de remisión de cada almacén. Hoy esos datos se tipean en cada guía; con ellos el panel los
--   propone solo. Si un almacén no tiene dirección propia, la API propone la de su sucursal
--   (sucursales.direccion, que ya existe) y, si tampoco hay, la partida por defecto de la configuración
--   fiscal. La emisión de la guía NO cambia: estos datos solo precargan el formulario.
--     * direccion               VARCHAR(200): igual que sucursales.direccion.
--     * ubigeo                  VARCHAR(6): código INEI de 6 dígitos (la API lo valida).
--     * codigo_establecimiento  VARCHAR(4): código del establecimiento anexo en SUNAT (4 dígitos;
--                                «0000» es el domicilio fiscal). La API lo valida.
--
-- Qué NO hace: no rellena nada (no hay UPDATE), no crea índices ni llaves foráneas, no inserta claves de
-- configuración.
--
-- Sin este script la API funciona igual que antes (capacidad almacenDireccion de
-- caja/esquema/esquema-caja.service.ts): el almacén se lee y se edita como hoy (nombre, descripción,
-- sucursal); si alguien manda una dirección propia del almacén responde 503 sin guardar nada, y la
-- partida propuesta sale de la sucursal o de la configuración fiscal. Tras correrlo, la API lo detecta sola
-- en menos de un minuto, sin reiniciar.
--
-- Orden: no depende de ningún otro script (fase19 a fase21 pueden estar o no).
--
-- Cómo ejecutarlo (tarda menos de un segundo):
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f sql/fase22_almacenes_direccion.sql
--   o DBeaver en modo auto-commit con "Ejecutar script".
-- ADD COLUMN sin valor por defecto solo cambia el catálogo; lock_timeout = 5 s hace que, si una venta larga
-- tiene ocupada la tabla, la sentencia falle en vez de dejar en cola a las cajas. Si falla por eso, vuelva a
-- correr el script (es idempotente).
--
-- Verificación posterior (debe devolver 3 filas con existe = true):
--   SELECT c AS columna, EXISTS (SELECT 1 FROM information_schema.columns
--            WHERE table_schema = 'public' AND table_name = 'almacenes' AND column_name = c) AS existe
--     FROM unnest(ARRAY['direccion', 'ubigeo', 'codigo_establecimiento']) AS c;
-- =============================================================================

SET lock_timeout = '5s';
SET statement_timeout = '5min';


-- 1) Dirección del almacén (punto de partida de la guía) -------------------------------------
ALTER TABLE public.almacenes ADD COLUMN IF NOT EXISTS direccion VARCHAR(200) NULL;
ALTER TABLE public.almacenes ADD COLUMN IF NOT EXISTS ubigeo VARCHAR(6) NULL;
ALTER TABLE public.almacenes ADD COLUMN IF NOT EXISTS codigo_establecimiento VARCHAR(4) NULL;

COMMENT ON COLUMN public.almacenes.direccion IS
  'Dirección del almacén (punto de partida de la guía, Fase 4.4). NULL: se usa la de su sucursal.';
COMMENT ON COLUMN public.almacenes.ubigeo IS
  'Ubigeo INEI de 6 dígitos de la dirección del almacén. NULL: sin dato.';
COMMENT ON COLUMN public.almacenes.codigo_establecimiento IS
  'Código de establecimiento anexo en SUNAT (4 dígitos; 0000 = domicilio fiscal). NULL: sin dato.';

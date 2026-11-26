-- =============================================================================
-- FASE 23 · Mejora automática de fotos de producto: guardar la original y publicar la mejorada
-- PostgreSQL 12+ · idempotente · aditivo (solo crea una tabla nueva y sus índices; no toca datos)
-- =============================================================================
-- Propósito (doc/PLAN_MEJORA_AUTOMATICA_DE_FOTOS.md §6, tanda B2):
--   Al subir una foto, el servidor la mide y, solo si lo necesita, publica una versión mejorada (recorte
--   del borde vacío, luz, contraste, enfoque, ampliación de las chicas). La ORIGINAL nunca se pierde:
--   esta tabla recuerda, por cada foto (productos_imagenes.id_imagen), dónde está la original y dónde la
--   mejorada, cuál se eligió y qué se hizo. Con eso el panel ofrece «Usar la original» foto por foto.
--     * estado: mejorada | sin_cambios | original_elegido | omitida | error
--     * version: versión del algoritmo que la procesó (para reprocesar a pedido si cambia).
--     * *_original / *_mejorada: URL, clave del almacén, miniatura, tipo, peso y medidas de cada archivo.
--     * informe: qué se midió y qué se hizo (JSON).
--   La fila de productos_imagenes sigue siendo la que leen todas las pantallas: apunta a la mejorada o a
--   la original, y cambiar entre ellas es una sola sentencia. Los dos archivos se conservan mientras
--   exista la foto.
--
-- Qué NO hace: no modifica productos_imagenes ni archivos, no inserta filas, no procesa las fotos ya
-- subidas (eso es un botón aparte, a pedido) y no inserta claves de configuración (la clave
-- fotos_mejora_automatica vale «encendida» si no existe).
--
-- Sin este script la API funciona igual que antes: sube y publica las fotos tal como llegan, y
-- GET producto/:id/images/mejoras responde { disponible: false }. Tras correrlo, la API lo detecta sola en
-- menos de un minuto, sin reiniciar, y empieza a mejorar lo que se suba desde entonces.
--
-- Orden: no depende de ningún otro script (fase19 a fase22 pueden estar o no). Necesita la tabla
-- productos_imagenes con su llave primaria id_imagen (existe desde el inicio).
--
-- Cómo ejecutarlo (tarda menos de un segundo):
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f sql/fase23_mejora_fotos.sql
--   o DBeaver en modo auto-commit con "Ejecutar script".
-- La llave foránea toma un bloqueo corto sobre productos_imagenes; lock_timeout = 5 s hace que, si algo
-- la tiene ocupada, la sentencia falle en vez de dejar en cola a quien sube fotos. Si falla por eso,
-- vuelva a correr el script (es idempotente).
--
-- Verificación posterior (debe devolver existe = true y 4 índices):
--   SELECT to_regclass('public.productos_imagenes_mejora') IS NOT NULL AS existe,
--          (SELECT count(*) FROM pg_indexes WHERE tablename = 'productos_imagenes_mejora') AS indices;
-- =============================================================================

SET lock_timeout = '5s';
SET statement_timeout = '5min';


-- 1) Original y mejorada de cada foto ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.productos_imagenes_mejora (
  id_imagen          INTEGER      PRIMARY KEY REFERENCES public.productos_imagenes (id_imagen) ON DELETE CASCADE,
  estado             VARCHAR(20)  NOT NULL,
  version            SMALLINT     NOT NULL,
  proveedor_original VARCHAR(30)  NOT NULL,
  url_original       TEXT         NOT NULL,
  clave_original     TEXT         NOT NULL,
  thumb_original     TEXT         NULL,
  mime_original      VARCHAR(100) NULL,
  size_original      INTEGER      NULL,
  ancho_original     INTEGER      NULL,
  alto_original      INTEGER      NULL,
  proveedor_mejorada VARCHAR(30)  NULL,
  url_mejorada       TEXT         NULL,
  clave_mejorada     TEXT         NULL,
  thumb_mejorada     TEXT         NULL,
  mime_mejorada      VARCHAR(100) NULL,
  size_mejorada      INTEGER      NULL,
  ancho_mejorada     INTEGER      NULL,
  alto_mejorada      INTEGER      NULL,
  informe            JSONB        NOT NULL DEFAULT '{}'::jsonb,
  creado_en          TIMESTAMP    NOT NULL DEFAULT now(),
  actualizado_en     TIMESTAMP    NOT NULL DEFAULT now(),
  CONSTRAINT ck_pim_estado CHECK (estado IN ('mejorada', 'sin_cambios', 'original_elegido', 'omitida', 'error')),
  -- Una foto «mejorada» siempre tiene su archivo mejorado.
  CONSTRAINT ck_pim_mejorada CHECK (estado <> 'mejorada' OR url_mejorada IS NOT NULL)
);

COMMENT ON TABLE public.productos_imagenes_mejora IS
  'Mejora automática de fotos (fase23): original y mejorada de cada productos_imagenes. La fila de la imagen apunta a una de las dos.';
COMMENT ON COLUMN public.productos_imagenes_mejora.estado IS
  'mejorada | sin_cambios (estaba bien: se publicó tal cual) | original_elegido (una persona eligió la original: no se reprocesa) | omitida | error';
COMMENT ON COLUMN public.productos_imagenes_mejora.informe IS
  'Medidas, acciones, avisos y receta aplicada (src/fotos). Solo informativo.';

-- 2) Índices: el borrado de archivos pregunta si una URL sigue en uso como original o mejorada; el
--    lote de fotos viejas filtra por estado y versión.
CREATE INDEX IF NOT EXISTS ix_pim_url_original ON public.productos_imagenes_mejora (url_original);
CREATE INDEX IF NOT EXISTS ix_pim_url_mejorada ON public.productos_imagenes_mejora (url_mejorada) WHERE url_mejorada IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_pim_estado ON public.productos_imagenes_mejora (estado, version);

-- Índice ÚNICO de código de barras (L2.2 del plan del lector).
-- Córrelo SOLO cuando el bloque (a) de sql/diagnostico_codigos_barras.sql salga VACÍO.
-- Si hay duplicados, el CREATE UNIQUE INDEX falla y deja un índice inválido que hay que borrar
-- (DROP INDEX CONCURRENTLY IF EXISTS uq_productos_codigo_barras;).
--
-- IMPORTANTE: CREATE INDEX CONCURRENTLY no puede ir dentro de BEGIN/COMMIT. Ejecútelo suelto
-- (una sentencia por vez si su cliente envuelve el script en una transacción).

-- Paso opcional para el bloque (b) del diagnóstico: recortar espacios/tab/saltos del borde.
-- Descomentar y correr ANTES del índice si el bloque (b) devolvió filas; luego repetir el bloque (a),
-- porque al recortar pueden aparecer duplicados nuevos.
-- UPDATE productos
--    SET codigo_barras = btrim(codigo_barras)
--  WHERE codigo_barras IS NOT NULL
--    AND codigo_barras <> btrim(codigo_barras);

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS uq_productos_codigo_barras
  ON productos (btrim(codigo_barras))
  WHERE codigo_barras IS NOT NULL AND btrim(codigo_barras) <> '';

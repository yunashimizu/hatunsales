-- Diagnóstico de códigos de barras / SKU (L2.1 del plan del lector).
-- SOLO SELECT: no modifica nada. Córrelo completo y revisa cada bloque.
-- Regla: el bloque (a) debe quedar VACÍO antes de correr sql/indice_unico_codigo_barras.sql.

-- (a) Código de barras repetido tras recortar espacios. Cada fila es un producto del grupo.
--     Si sale algo aquí, el índice único fallará: corrija o desactive los duplicados primero.
SELECT btrim(p.codigo_barras) AS codigo,
       p.id_producto,
       p.nombre,
       p.sku,
       p.estado
  FROM productos p
 WHERE btrim(COALESCE(p.codigo_barras, '')) <> ''
   AND btrim(p.codigo_barras) IN (
         SELECT btrim(codigo_barras)
           FROM productos
          WHERE btrim(COALESCE(codigo_barras, '')) <> ''
          GROUP BY btrim(codigo_barras)
         HAVING COUNT(*) > 1
       )
 ORDER BY btrim(p.codigo_barras), p.id_producto;

-- (b) Códigos con espacio, tab o salto de línea al borde (el lector o un Excel los dejó sucios).
--     Se corrigen con el UPDATE comentado de sql/indice_unico_codigo_barras.sql.
SELECT p.id_producto,
       p.nombre,
       '[' || p.codigo_barras || ']' AS codigo_con_bordes,
       length(p.codigo_barras)       AS largo,
       length(btrim(p.codigo_barras)) AS largo_limpio
  FROM productos p
 WHERE p.codigo_barras IS NOT NULL
   AND p.codigo_barras <> btrim(p.codigo_barras)
 ORDER BY p.id_producto;

-- (c) El SKU de un producto es igual al código de barras de OTRO producto (sin distinguir mayúsculas).
--     El lector buscaría por barras primero y nunca llegaría al SKU del otro.
SELECT a.id_producto AS id_con_sku,
       a.nombre      AS nombre_con_sku,
       a.sku,
       b.id_producto AS id_con_barras,
       b.nombre      AS nombre_con_barras,
       b.codigo_barras
  FROM productos a
  JOIN productos b
    ON b.id_producto <> a.id_producto
   AND LOWER(btrim(COALESCE(a.sku, ''))) = LOWER(btrim(COALESCE(b.codigo_barras, '')))
 WHERE btrim(COALESCE(a.sku, '')) <> ''
 ORDER BY a.id_producto, b.id_producto;

-- (d) UPC-A (12 dígitos) y EAN-13 (13 dígitos con un 0 delante) que existen como productos distintos.
--     El POS trata ambos como el mismo código: si salen filas, hay dos productos que se confundirían.
SELECT a.id_producto AS id_12_digitos,
       a.nombre      AS nombre_12_digitos,
       btrim(a.codigo_barras) AS codigo_12,
       b.id_producto AS id_13_digitos,
       b.nombre      AS nombre_13_digitos,
       btrim(b.codigo_barras) AS codigo_13
  FROM productos a
  JOIN productos b
    ON b.id_producto <> a.id_producto
   AND btrim(b.codigo_barras) = '0' || btrim(a.codigo_barras)
 WHERE btrim(a.codigo_barras) ~ '^[0-9]{12}$'
 ORDER BY a.id_producto, b.id_producto;

-- (e) Productos INACTIVOS que tienen código de barras o SKU. Escanear uno de ellos ahora responde
--     «existe pero está inactivo» (409) en vez de «no existe»; conviene saber cuántos hay.
SELECT p.id_producto,
       p.nombre,
       p.sku,
       p.codigo_barras
  FROM productos p
 WHERE COALESCE(p.estado, TRUE) = FALSE
   AND (btrim(COALESCE(p.codigo_barras, '')) <> '' OR btrim(COALESCE(p.sku, '')) <> '')
 ORDER BY p.id_producto;

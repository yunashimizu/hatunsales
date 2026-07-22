-- View: product with one representative image (useful for quick listings)
CREATE OR REPLACE VIEW view_product_with_image AS
SELECT
  p.id_producto,
  p.nombre,
  img.url as image_url
FROM productos p
LEFT JOIN productos_imagenes img ON img.id_producto = p.id_producto
GROUP BY p.id_producto, p.nombre, img.url;

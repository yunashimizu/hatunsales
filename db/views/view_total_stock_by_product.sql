-- View: total stock per product across all branches
CREATE OR REPLACE VIEW view_total_stock_by_product AS
SELECT
  p.id_producto,
  p.nombre,
  COALESCE(SUM(s.stock), 0) AS total_stock,
  COALESCE(SUM(s.stock_comprometido), 0) AS total_comprometido
FROM productos p
LEFT JOIN stock_sucursal s ON s.id_producto = p.id_producto
GROUP BY p.id_producto, p.nombre;

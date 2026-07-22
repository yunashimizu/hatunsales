-- View: low stock per branch (threshold can be used in queries)
CREATE OR REPLACE VIEW view_low_stock_per_branch AS
SELECT
  s.id_stock,
  p.id_producto,
  p.nombre as producto_nombre,
  suc.id_sucursal,
  suc.nombre as sucursal_nombre,
  s.stock,
  s.stock_comprometido
FROM stock_sucursal s
JOIN productos p ON p.id_producto = s.id_producto
JOIN sucursales suc ON suc.id_sucursal = s.id_sucursal
WHERE s.stock <= 10; -- default threshold, callers can filter differently

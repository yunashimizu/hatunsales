-- Índices para búsqueda rápida del punto de venta (idempotente).
CREATE INDEX IF NOT EXISTS idx_productos_estado ON productos (estado);
CREATE INDEX IF NOT EXISTS idx_productos_codigo_barras
  ON productos (codigo_barras)
  WHERE codigo_barras IS NOT NULL AND codigo_barras <> '';
CREATE INDEX IF NOT EXISTS idx_productos_sku_lower
  ON productos (LOWER(sku));
CREATE INDEX IF NOT EXISTS idx_productos_nombre_lower
  ON productos (LOWER(nombre));
CREATE INDEX IF NOT EXISTS idx_inventario_id_producto
  ON inventario (id_producto);
CREATE UNIQUE INDEX IF NOT EXISTS uq_ventas_clave_idempotencia
  ON ventas (clave_idempotencia)
  WHERE clave_idempotencia IS NOT NULL AND clave_idempotencia <> '';
CREATE INDEX IF NOT EXISTS idx_inventario_producto_almacen
  ON inventario (id_producto, id_almacen);

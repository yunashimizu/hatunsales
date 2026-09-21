-- Descuentos por producto y reglas mayoristas opcionales.
-- Ejecutar una sola vez en Railway, con respaldo previo.
BEGIN;

CREATE TABLE IF NOT EXISTS producto_descuento_mayorista (
  id_regla BIGSERIAL PRIMARY KEY,
  id_producto INTEGER NOT NULL REFERENCES productos(id_producto),
  cantidad_minima NUMERIC(12,3) NOT NULL,
  descuento_unitario NUMERIC(12,2) NOT NULL DEFAULT 0,
  activo BOOLEAN NOT NULL DEFAULT TRUE,
  creado_en TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT producto_descuento_mayorista_cantidad_ck CHECK (cantidad_minima > 0),
  CONSTRAINT producto_descuento_mayorista_descuento_ck CHECK (descuento_unitario >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_producto_descuento_mayorista_minimo
  ON producto_descuento_mayorista (id_producto, cantidad_minima)
  WHERE activo = TRUE;

ALTER TABLE detalle_venta
  ADD COLUMN IF NOT EXISTS precio_lista_unitario NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS descuento_unitario_aplicado NUMERIC(12,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS descuento_total_linea NUMERIC(12,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS precio_unitario_final NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS subtotal NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS igv NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS total NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS id_regla_mayorista BIGINT;

ALTER TABLE ventas
  ADD COLUMN IF NOT EXISTS total_descuento NUMERIC(12,2) DEFAULT 0;

-- La tienda antigua interpretaba productos.descuento como porcentaje.
-- La política vigente lo interpreta como monto fijo en soles por unidad.
CREATE OR REPLACE VIEW vw_catalogo AS
SELECT
  p.id_producto,
  p.nombre,
  p.slug,
  p.descripcion,
  p.descripcion_corta,
  p.sku,
  p.codigo_barras,
  p.precio_venta,
  p.descuento,
  ROUND(p.precio_venta - COALESCE(p.descuento, 0), 2) AS precio_final,
  p.destacado,
  p.estado,
  p.unidad_medida,
  c.id_categoria,
  c.nombre AS categoria,
  m.id_marca,
  m.nombre AS marca,
  COALESCE(st.stock_total, 0) AS stock,
  COALESCE(rt.rating, 0) AS rating,
  COALESCE(rt.total_resenas, 0) AS total_resenas,
  (
    SELECT pi.url FROM productos_imagenes pi
    WHERE pi.id_producto = p.id_producto
    ORDER BY pi.is_primary DESC NULLS LAST, pi.orden ASC, pi.id_imagen ASC
    LIMIT 1
  ) AS imagen_principal
FROM productos p
LEFT JOIN categorias c ON c.id_categoria = p.id_categoria
LEFT JOIN marcas m ON m.id_marca = p.id_marca
LEFT JOIN vw_producto_stock st ON st.id_producto = p.id_producto
LEFT JOIN vw_producto_rating rt ON rt.id_producto = p.id_producto;

COMMIT;
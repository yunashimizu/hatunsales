-- Migración manual e idempotente para Cotizaciones.
-- Ejecutar con respaldo previo de la base de datos.

BEGIN;

ALTER TABLE proformas
  ADD COLUMN IF NOT EXISTS porcentaje_igv NUMERIC(5,2) DEFAULT 18;

UPDATE proformas
   SET porcentaje_igv = 18
 WHERE porcentaje_igv IS NULL;

CREATE INDEX IF NOT EXISTS idx_proformas_id_venta
  ON proformas (id_venta);

CREATE INDEX IF NOT EXISTS idx_proformas_valida_hasta
  ON proformas (valida_hasta);

CREATE UNIQUE INDEX IF NOT EXISTS uq_ventas_clave_idempotencia
  ON ventas (clave_idempotencia)
  WHERE clave_idempotencia IS NOT NULL
    AND clave_idempotencia <> '';

COMMIT;

-- Auditoría previa a cualquier traslado desde stock_sucursal.
-- No mezclar ambas tablas ni ejecutar un backfill sin revisar estos resultados.
-- El POS y Ventas usan inventario por almacén como fuente oficial.
SELECT 'inventario' AS fuente, COUNT(*)::int AS filas, COALESCE(SUM(stock), 0)::numeric AS unidades
  FROM inventario
 WHERE COALESCE(stock, 0) > 0
UNION ALL
SELECT 'stock_sucursal' AS fuente, COUNT(*)::int AS filas, COALESCE(SUM(stock), 0)::numeric AS unidades
  FROM stock_sucursal
 WHERE COALESCE(stock, 0) > 0;

-- Ramas con más de un almacén: requieren decisión manual antes de migrar.
SELECT s.id_sucursal,
       s.nombre AS sucursal,
       COUNT(a.id_almacen)::int AS almacenes
  FROM sucursales s
  LEFT JOIN almacenes a ON a.id_sucursal = s.id_sucursal
 GROUP BY s.id_sucursal, s.nombre
HAVING COUNT(a.id_almacen) > 1
 ORDER BY s.nombre;

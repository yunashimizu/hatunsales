-- DIAGNOSTICO SOLO LECTURA - GUIA DE REMISION
-- Ejecutar en DBeaver sobre la conexion PostgreSQL de Railway.
-- No modifica datos, no crea tablas y no requiere credenciales en el archivo.

SELECT 'CONEXION' AS seccion,
       current_database() AS base,
       current_user AS usuario,
       inet_server_addr()::text AS servidor,
       version() AS version;

SELECT 'TABLAS_BASE' AS seccion,
       nombre,
       to_regclass('public.' || nombre)::text AS tabla,
       CASE WHEN to_regclass('public.' || nombre) IS NULL THEN 'FALTA' ELSE 'OK' END AS estado
FROM (VALUES
  ('guias_remision'),
  ('guias_remision_items'),
  ('guias_remision_envios'),
  ('ventas'),
  ('detalle_venta'),
  ('venta_stock_salida'),
  ('comprobantes'),
  ('almacenes'),
  ('sucursales'),
  ('productos'),
  ('usuarios')
) AS t(nombre)
ORDER BY nombre;

SELECT 'COLUMNAS_GUIA' AS seccion,
       table_name,
       ordinal_position,
       column_name,
       data_type,
       udt_name,
       is_nullable,
       column_default
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name IN ('guias_remision', 'guias_remision_items', 'guias_remision_envios')
ORDER BY table_name, ordinal_position;

SELECT 'CONSTRAINTS_GUIA' AS seccion,
       table_name,
       constraint_name,
       constraint_type
FROM information_schema.table_constraints
WHERE table_schema = 'public'
  AND table_name IN ('guias_remision', 'guias_remision_items', 'guias_remision_envios')
ORDER BY table_name, constraint_name;

SELECT 'INDICES_GUIA' AS seccion,
       schemaname,
       tablename,
       indexname,
       indexdef
FROM pg_indexes
WHERE schemaname = 'public'
  AND tablename IN ('guias_remision', 'guias_remision_items', 'guias_remision_envios')
ORDER BY tablename, indexname;

SELECT 'CONTEOS' AS seccion,
       (SELECT COUNT(*) FROM guias_remision) AS guias,
       (SELECT COUNT(*) FROM guias_remision_items) AS items,
      CASE WHEN to_regclass('public.guias_remision_envios') IS NULL THEN 0 ELSE 1 END AS tabla_envios_existe,
       (SELECT COUNT(*) FROM ventas) AS ventas,
       (SELECT COUNT(*) FROM venta_stock_salida) AS salidas_stock;

SELECT 'ESTADOS_GUIA' AS seccion,
       COALESCE(estado, '<NULL>') AS estado,
       COUNT(*) AS cantidad
FROM guias_remision
GROUP BY estado
ORDER BY estado;

SELECT 'RIESGOS_DATOS' AS seccion,
       'guias_sin_items' AS riesgo,
       COUNT(*) AS cantidad
FROM guias_remision g
LEFT JOIN guias_remision_items i ON i.id_guia = g.id_guia
WHERE i.id_item IS NULL
UNION ALL
SELECT 'RIESGOS_DATOS', 'items_sin_guia', COUNT(*)
FROM guias_remision_items i
LEFT JOIN guias_remision g ON g.id_guia = i.id_guia
WHERE g.id_guia IS NULL
UNION ALL
SELECT 'RIESGOS_DATOS', 'guias_venta_inexistente', COUNT(*)
FROM guias_remision g
LEFT JOIN ventas v ON v.id_venta = g.id_venta
WHERE g.id_venta IS NOT NULL AND v.id_venta IS NULL
UNION ALL
SELECT 'RIESGOS_DATOS', 'guias_comprobante_inexistente', COUNT(*)
FROM guias_remision g
LEFT JOIN comprobantes c ON c.id_comprobante = g.id_comprobante
WHERE g.id_comprobante IS NOT NULL AND c.id_comprobante IS NULL
UNION ALL
SELECT 'RIESGOS_DATOS', 'guias_almacen_inexistente', COUNT(*)
FROM guias_remision g
LEFT JOIN almacenes a ON a.id_almacen = g.id_almacen_origen
WHERE g.id_almacen_origen IS NOT NULL AND a.id_almacen IS NULL
UNION ALL
SELECT 'RIESGOS_DATOS', 'items_producto_inexistente', COUNT(*)
FROM guias_remision_items i
LEFT JOIN productos p ON p.id_producto = i.id_producto
WHERE i.id_producto IS NOT NULL AND p.id_producto IS NULL
UNION ALL
SELECT 'RIESGOS_DATOS', 'salidas_sin_venta', COUNT(*)
FROM venta_stock_salida s
LEFT JOIN ventas v ON v.id_venta = s.id_venta
WHERE v.id_venta IS NULL;

SELECT 'SALIDAS_VENTA' AS seccion,
       v.id_venta,
       COALESCE(v.estado, 'activa') AS estado_venta,
       COUNT(s.id) AS filas_salida,
       COUNT(DISTINCT s.id_almacen) AS almacenes_origen,
       COALESCE(SUM(s.cantidad), 0) AS unidades_salida
FROM ventas v
JOIN venta_stock_salida s ON s.id_venta = v.id_venta
GROUP BY v.id_venta, v.estado
ORDER BY v.id_venta DESC
LIMIT 20;

SELECT 'DUPLICADOS_IDEMPOTENCIA' AS seccion,
       clave_idempotencia,
       COUNT(*) AS cantidad
FROM guias_remision
WHERE NULLIF(TRIM(clave_idempotencia), '') IS NOT NULL
GROUP BY clave_idempotencia
HAVING COUNT(*) > 1
ORDER BY cantidad DESC;

-- Resultado esperado antes de migrar:
-- 1) Conexion apunta a Railway.
-- 2) Tablas base guias_remision y guias_remision_items existen.
-- 3) guias_remision_envios puede salir FALTA: la migracion la crea.
-- 4) Riesgos que impedirian FKs deben ser 0.
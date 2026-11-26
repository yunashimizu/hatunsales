-- =============================================================================
-- DIAGNÓSTICO DE DUPLICADOS (Fase 9.1) · SOLO LECTURA
-- =============================================================================
-- Qué es: una lista de fichas repetidas en clientes, empresas, proveedores y productos. NO cambia nada:
-- todas las sentencias son SELECT. Se puede correr las veces que quiera, también en horario de venta.
--
-- Para qué sirve: antes de impedir duplicados con un «índice único» (una regla de la base de datos que
-- rechaza la segunda ficha igual), hay que saber cuántos hay hoy. Si existen duplicados, el índice no se
-- puede crear: primero se juntan o corrigen esas fichas a mano y después se activa el índice.
-- Orden obligatorio: MEDIR (este script) → LIMPIAR (a mano, ficha por ficha) → RESTRINGIR (los índices).
--
-- Cómo correrlo:
--   psql "$DATABASE_URL" -f sql/diagnostico_duplicados.sql
--   o en DBeaver: abrir el archivo y «Ejecutar script». Cada bloque devuelve su propia tabla.
--
-- Cómo leerlo: cada bloque numerado devuelve UNA FILA POR FICHA REPETIDA (agrupadas por el dato que se
-- repite). Un bloque VACÍO significa «no hay duplicados de ese tipo». El último bloque (7) es el resumen:
-- cuántas fichas tocaría cada índice único y si ya está activo.
--
-- Qué hacer con un duplicado:
--   * Clientes / empresas: las ventas, cuentas por cobrar y comprobantes apuntan a UNA de las fichas.
--     Conserve la que tiene historial y corrija el documento de la otra (o pásele sus datos y déjela sin
--     documento). No borre fichas con ventas.
--   * Proveedores: igual; las recepciones apuntan a uno de ellos.
--   * Productos (SKU, código de barras, nombre): corrija el SKU o el código del que sobra, o desactívelo
--     (Productos › Desactivar). Un nombre repetido NO impide nada: es solo una alerta (bloque 6).
--
-- Dónde están los índices: ver sql/indices_unicos_datos_limpios.sql (todos comentados; cada uno dice qué
-- bloque de este diagnóstico debe salir vacío antes de activarlo).
-- =============================================================================


-- 1) DNI repetido en clientes ---------------------------------------------------------------
--    Una persona con dos fichas tiene dos cupos de crédito: así se evade el límite.
--    (Mismo criterio que el bloque 2.1 de sql/fase18_concurrencia_e_indices.sql.)
SELECT c.dni,
       c.id_cliente,
       TRIM(CONCAT_WS(' ', c.nombre, c.apellido_paterno, c.apellido_materno)) AS nombre,
       c.creado_en,
       (SELECT COUNT(*) FROM ventas v WHERE v.id_cliente = c.id_cliente) AS ventas
  FROM clientes c
 WHERE c.dni IN (SELECT dni FROM clientes WHERE dni IS NOT NULL GROUP BY dni HAVING COUNT(*) > 1)
 ORDER BY c.dni, c.id_cliente;


-- 2) RUC repetido en empresas -----------------------------------------------------------------
--    (Mismo criterio que el bloque 2.2 de sql/fase18_concurrencia_e_indices.sql.)
SELECT e.ruc,
       e.id_empresa,
       COALESCE(e.razon_social, e.nombre_comercial) AS razon_social,
       e.creado_en,
       (SELECT COUNT(*) FROM ventas v WHERE v.id_empresa = e.id_empresa) AS ventas
  FROM empresas e
 WHERE e.ruc IN (SELECT ruc FROM empresas WHERE ruc IS NOT NULL AND ruc <> '' GROUP BY ruc HAVING COUNT(*) > 1)
 ORDER BY e.ruc, e.id_empresa;


-- 3) RUC repetido en proveedores (sin espacios al borde) ---------------------------------------
--    Desde la Fase 9.5 la API ya no deja crear un segundo proveedor con el mismo RUC; esto muestra los
--    que quedaron de antes.
SELECT BTRIM(p.ruc) AS ruc,
       p.id_proveedor,
       p.nombre,
       -- Recepciones de cada uno (vacío si la tabla «recepciones» aún no existe: Recepción nunca se usó).
       CASE WHEN to_regclass('recepciones') IS NULL THEN NULL
            ELSE (xpath('/row/n/text()', query_to_xml(
                   format('SELECT COUNT(*) AS n FROM recepciones WHERE id_proveedor = %s', p.id_proveedor),
                   FALSE, TRUE, '')))[1]::text::int
       END AS recepciones
  FROM proveedores p
 WHERE BTRIM(COALESCE(p.ruc, '')) <> ''
   AND BTRIM(p.ruc) IN (
         SELECT BTRIM(ruc) FROM proveedores
          WHERE BTRIM(COALESCE(ruc, '')) <> ''
          GROUP BY BTRIM(ruc) HAVING COUNT(*) > 1)
 ORDER BY BTRIM(p.ruc), p.id_proveedor;


-- 4) SKU repetido (sin espacios al borde y sin distinguir mayúsculas) ---------------------------
--    El lector de códigos busca el SKU sin distinguir mayúsculas: «MAR-1» y «mar-1» son el mismo.
SELECT LOWER(BTRIM(p.sku)) AS sku,
       p.id_producto,
       p.nombre,
       p.sku AS sku_tal_cual,
       p.estado AS activo
  FROM productos p
 WHERE BTRIM(COALESCE(p.sku, '')) <> ''
   AND LOWER(BTRIM(p.sku)) IN (
         SELECT LOWER(BTRIM(sku)) FROM productos
          WHERE BTRIM(COALESCE(sku, '')) <> ''
          GROUP BY LOWER(BTRIM(sku)) HAVING COUNT(*) > 1)
 ORDER BY LOWER(BTRIM(p.sku)), p.id_producto;


-- 5) Código de barras repetido (sin espacios al borde) -----------------------------------------
--    (Mismo criterio que el bloque (a) de sql/diagnostico_codigos_barras.sql, que además revisa bordes
--    sucios, SKU igual al código de otro producto y UPC/EAN equivalentes.)
SELECT BTRIM(p.codigo_barras) AS codigo,
       p.id_producto,
       p.nombre,
       p.sku,
       p.estado AS activo
  FROM productos p
 WHERE BTRIM(COALESCE(p.codigo_barras, '')) <> ''
   AND BTRIM(p.codigo_barras) IN (
         SELECT BTRIM(codigo_barras) FROM productos
          WHERE BTRIM(COALESCE(codigo_barras, '')) <> ''
          GROUP BY BTRIM(codigo_barras) HAVING COUNT(*) > 1)
 ORDER BY BTRIM(p.codigo_barras), p.id_producto;


-- 6) Nombres de producto iguales tras normalizar (SOLO ALERTA, no lleva índice) ----------------
--    Normalizar = minúsculas, sin tildes, sin espacios dobles ni al borde. «Martillo  Stanley» y
--    «martillo stanley» cuentan como el mismo nombre. Dos productos pueden llamarse igual a propósito
--    (otra marca, otra medida): revise y, si es el mismo, desactive uno.
WITH normalizados AS (
  SELECT p.id_producto,
         p.nombre,
         p.sku,
         p.estado,
         REGEXP_REPLACE(
           TRANSLATE(LOWER(BTRIM(COALESCE(p.nombre, ''))), 'áéíóúàèìòùäëïöüâêîôûñ', 'aeiouaeiouaeiouaeioun'),
           '\s+', ' ', 'g') AS nombre_normalizado
    FROM productos p
)
SELECT n.nombre_normalizado,
       n.id_producto,
       n.nombre,
       n.sku,
       n.estado AS activo
  FROM normalizados n
 WHERE n.nombre_normalizado <> ''
   AND n.nombre_normalizado IN (
         SELECT nombre_normalizado FROM normalizados
          WHERE nombre_normalizado <> ''
          GROUP BY nombre_normalizado HAVING COUNT(*) > 1)
 ORDER BY n.nombre_normalizado, n.id_producto;


-- 7) RESUMEN: cuántas fichas tocaría cada índice único y si ya está activo ----------------------
--    grupos   = cuántos datos distintos están repetidos (p. ej. 2 DNI repetidos).
--    fichas   = cuántas filas hay en esos grupos (p. ej. 5 fichas en total).
--    activo   = el índice ya existe y es válido. «false» con grupos = 0 → ya se puede activar.
--    Dónde está cada índice: la columna «script».
WITH resumen AS (
  SELECT 'uq_clientes_dni' AS indice, 'bloque 1' AS bloque,
         'sql/fase18_concurrencia_e_indices.sql (bloque 3)' AS script,
         (SELECT COUNT(*) FROM (SELECT dni FROM clientes WHERE dni IS NOT NULL GROUP BY dni HAVING COUNT(*) > 1) g) AS grupos,
         (SELECT COALESCE(SUM(n), 0) FROM (SELECT COUNT(*) AS n FROM clientes WHERE dni IS NOT NULL GROUP BY dni HAVING COUNT(*) > 1) g) AS fichas
  UNION ALL
  SELECT 'uq_empresas_ruc', 'bloque 2', 'sql/fase18_concurrencia_e_indices.sql (bloque 3)',
         (SELECT COUNT(*) FROM (SELECT ruc FROM empresas WHERE ruc IS NOT NULL AND ruc <> '' GROUP BY ruc HAVING COUNT(*) > 1) g),
         (SELECT COALESCE(SUM(n), 0) FROM (SELECT COUNT(*) AS n FROM empresas WHERE ruc IS NOT NULL AND ruc <> '' GROUP BY ruc HAVING COUNT(*) > 1) g)
  UNION ALL
  SELECT 'uq_proveedores_ruc', 'bloque 3', 'sql/indices_unicos_datos_limpios.sql',
         (SELECT COUNT(*) FROM (SELECT BTRIM(ruc) FROM proveedores WHERE BTRIM(COALESCE(ruc, '')) <> '' GROUP BY BTRIM(ruc) HAVING COUNT(*) > 1) g),
         (SELECT COALESCE(SUM(n), 0) FROM (SELECT COUNT(*) AS n FROM proveedores WHERE BTRIM(COALESCE(ruc, '')) <> '' GROUP BY BTRIM(ruc) HAVING COUNT(*) > 1) g)
  UNION ALL
  SELECT 'uq_productos_sku', 'bloque 4', 'sql/indices_unicos_datos_limpios.sql',
         (SELECT COUNT(*) FROM (SELECT LOWER(BTRIM(sku)) FROM productos WHERE BTRIM(COALESCE(sku, '')) <> '' GROUP BY LOWER(BTRIM(sku)) HAVING COUNT(*) > 1) g),
         (SELECT COALESCE(SUM(n), 0) FROM (SELECT COUNT(*) AS n FROM productos WHERE BTRIM(COALESCE(sku, '')) <> '' GROUP BY LOWER(BTRIM(sku)) HAVING COUNT(*) > 1) g)
  UNION ALL
  SELECT 'uq_productos_codigo_barras', 'bloque 5', 'sql/indice_unico_codigo_barras.sql (antes: sql/diagnostico_codigos_barras.sql)',
         (SELECT COUNT(*) FROM (SELECT BTRIM(codigo_barras) FROM productos WHERE BTRIM(COALESCE(codigo_barras, '')) <> '' GROUP BY BTRIM(codigo_barras) HAVING COUNT(*) > 1) g),
         (SELECT COALESCE(SUM(n), 0) FROM (SELECT COUNT(*) AS n FROM productos WHERE BTRIM(COALESCE(codigo_barras, '')) <> '' GROUP BY BTRIM(codigo_barras) HAVING COUNT(*) > 1) g)
)
SELECT r.indice,
       r.bloque,
       r.grupos,
       r.fichas,
       COALESCE((SELECT i.indisvalid FROM pg_index i
                  WHERE i.indexrelid = to_regclass(format('%I.%I', current_schema(), r.indice))), FALSE) AS activo,
       r.script
  FROM resumen r
 ORDER BY r.indice;

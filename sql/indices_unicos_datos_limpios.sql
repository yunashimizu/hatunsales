-- =============================================================================
-- ÍNDICES ÚNICOS DE DATOS LIMPIOS (Fase 9.2) · TODO COMENTADO
-- =============================================================================
-- Qué es: las reglas de la base de datos que impiden, de aquí en adelante, dos fichas con el mismo dato.
-- Están COMENTADAS (con «--» delante): este archivo, tal cual, no hace nada.
--
-- Cuándo activar cada uno: SOLO cuando su bloque de sql/diagnostico_duplicados.sql salga VACÍO (o, en el
-- resumen del bloque 7, «grupos» = 0). Si hay duplicados, el índice falla y queda «INVALID» (existe pero no
-- sirve, y hay que borrarlo con el DROP que se indica abajo antes de reintentarlo).
--
-- Cómo activarlo: quite los «-- » de las líneas de ESE índice (CREATE … y sus líneas ON/WHERE) y corra:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f sql/indices_unicos_datos_limpios.sql
--   o DBeaver en modo auto-commit, una sentencia por vez.
-- NO use -1 / --single-transaction: CREATE INDEX CONCURRENTLY no puede ir dentro de una transacción.
-- CONCURRENTLY no bloquea las ventas mientras se construye (con los datos de hoy tarda menos de un segundo).
--
-- Comprobar que quedó bien (indisvalid = true):
--   SELECT c.relname, i.indisvalid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
--    WHERE c.relname IN ('uq_proveedores_ruc', 'uq_productos_sku');
--
-- Los otros índices únicos de la Fase 9.2 YA ESTÁN ESCRITOS en otros archivos (no se repiten aquí):
--   * DNI de clientes (uq_clientes_dni) y RUC de empresas (uq_empresas_ruc):
--       sql/fase18_concurrencia_e_indices.sql, bloque 3 (comentado). Diagnóstico: bloques 1 y 2.
--   * Código de barras (uq_productos_codigo_barras):
--       sql/indice_unico_codigo_barras.sql. Diagnóstico: bloque 5 (o sql/diagnostico_codigos_barras.sql).
--   * Guía de recepción por proveedor (uq_recepciones_proveedor_guia):
--       sql/fase21_stock_y_pedidos.sql (comentado). Diagnóstico: sql/diagnostico_recepciones_duplicadas.sql.
--
-- Qué pasa en la API cuando un índice está activo y alguien intenta repetir el dato:
--   * Proveedor: 409 «PROVEEDOR_RUC_REPETIDO» (la API ya lo comprueba antes; el índice es la red final).
--   * Producto:  409 «Ya existe un producto con ese código de barras o SKU» (la API ya lo comprueba antes).
-- =============================================================================

SET lock_timeout = '5s';
SET statement_timeout = '15min';


-- A) RUC de proveedor único (sin espacios al borde). Diagnóstico: bloque 3.
--    Si falló: DROP INDEX CONCURRENTLY IF EXISTS uq_proveedores_ruc;
-- CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS uq_proveedores_ruc
--   ON proveedores (BTRIM(ruc))
--   WHERE ruc IS NOT NULL AND BTRIM(ruc) <> '';


-- B) SKU de producto único (sin espacios al borde y sin distinguir mayúsculas). Diagnóstico: bloque 4.
--    Si falló: DROP INDEX CONCURRENTLY IF EXISTS uq_productos_sku;
-- CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS uq_productos_sku
--   ON productos (LOWER(BTRIM(sku)))
--   WHERE sku IS NOT NULL AND BTRIM(sku) <> '';


-- Nombres de producto: SIN índice a propósito (dos productos pueden llamarse igual: otra marca, otra
-- medida). El bloque 6 del diagnóstico es solo una alerta para revisar a mano.

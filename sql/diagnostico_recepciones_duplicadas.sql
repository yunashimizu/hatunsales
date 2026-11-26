-- =============================================================================
-- DIAGNÓSTICO · Guías de recepción repetidas por proveedor (Fase 8.4) · SOLO LECTURA
-- =============================================================================
-- No escribe nada: solo SELECT. Se puede correr en Railway en cualquier momento.
--   psql "$DATABASE_URL" -f sql/diagnostico_recepciones_duplicadas.sql
--
-- Para qué: antes de activar el índice único comentado en sql/fase21_stock_y_pedidos.sql (bloque 3),
-- ver si ya hay recepciones del mismo proveedor con la misma guía. Una guía repetida suele ser la misma
-- mercadería sumada dos veces al stock (otra pestaña, otro equipo o un reintento sin clave de idempotencia).
--
-- La guía se compara igual que la API y que el índice: sin espacios en los bordes y sin distinguir
-- mayúsculas (UPPER(BTRIM(nro_guia))). Las guías vacías no cuentan.
--
-- Qué hacer con el resultado:
--   * Consulta 1 vacía → puede activar el índice (quite los guiones del bloque 3 de fase21 y vuelva a correrlo).
--   * Con filas → revise cada grupo con la consulta 2: si es la misma mercadería sumada dos veces, corrija el
--     stock con un ajuste (motivo «Corrección de registro») y cambie la guía de la recepción sobrante (por ejemplo
--     agregándole « (dup)») con un UPDATE puntual que usted revise. Este script no lo hace.
-- =============================================================================

-- 0) ¿Existe la tabla? (instalaciones sin recepción no la tienen) --------------------------------
SELECT to_regclass('public.recepciones') IS NOT NULL AS hay_recepciones;

-- 1) Grupos repetidos (proveedor + guía) ----------------------------------------------------------
SELECT r.id_proveedor,
       COALESCE(p.nombre, '')                               AS proveedor,
       UPPER(BTRIM(r.nro_guia))                             AS guia,
       COUNT(*)                                             AS recepciones,
       array_agg(r.id_recepcion ORDER BY r.id_recepcion)   AS ids_recepcion,
       MIN(r.creado_en)                                     AS primera,
       MAX(r.creado_en)                                     AS ultima
  FROM recepciones r
  LEFT JOIN proveedores p ON p.id_proveedor = r.id_proveedor
 WHERE BTRIM(COALESCE(r.nro_guia, '')) <> ''
 GROUP BY r.id_proveedor, p.nombre, UPPER(BTRIM(r.nro_guia))
HAVING COUNT(*) > 1
 ORDER BY recepciones DESC, r.id_proveedor, guia;

-- 2) Detalle de cada recepción de esos grupos: almacén, quién, cuándo y cuánto entró ---------------
SELECT r.id_recepcion, r.id_proveedor, UPPER(BTRIM(r.nro_guia)) AS guia, r.nro_documento, r.estado,
       r.creado_en, r.id_usuario, COALESCE(a.nombre, '') AS almacen,
       (SELECT COUNT(*) FROM recepcion_items i WHERE i.id_recepcion = r.id_recepcion)                    AS lineas,
       (SELECT COALESCE(SUM(i.cantidad_ok), 0) FROM recepcion_items i WHERE i.id_recepcion = r.id_recepcion) AS unidades_ok
  FROM recepciones r
  LEFT JOIN almacenes a ON a.id_almacen = r.id_almacen
 WHERE BTRIM(COALESCE(r.nro_guia, '')) <> ''
   AND (r.id_proveedor, UPPER(BTRIM(r.nro_guia))) IN (
         SELECT id_proveedor, UPPER(BTRIM(nro_guia))
           FROM recepciones
          WHERE BTRIM(COALESCE(nro_guia, '')) <> ''
          GROUP BY id_proveedor, UPPER(BTRIM(nro_guia))
         HAVING COUNT(*) > 1)
 ORDER BY r.id_proveedor, guia, r.id_recepcion;

-- 3) ¿Ya está el índice? (true = ya activado) -------------------------------------------------------
SELECT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'uq_recepciones_proveedor_guia') AS indice_activado;

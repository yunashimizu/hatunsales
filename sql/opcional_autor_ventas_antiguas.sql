-- =============================================================================
-- OPCIONAL · Autor de las ventas anteriores a fase19, deducido del turno de caja
-- PostgreSQL 12+ · se corre UNA vez, a mano, solo si se quiere · modifica datos (UPDATE)
-- =============================================================================
-- Qué hace (doc/PLAN_ESCRIBIR_MENOS_Y_VENDER_CON_CONTROL.md, Fase 6.2):
--   Las ventas de mostrador registradas antes de sql/fase19_control_venta_y_bitacora.sql no guardaron
--   quién vendió (ventas.id_usuario NULL). Este script les pone como autor al usuario que tenía ABIERTO el
--   turno de la caja de la venta en ese momento: misma ventana que usa el arqueo
--   (caja/arqueo/sql-esperado.ts): [aperturas_caja.fecha, primer cierres_caja.fecha) sobre la misma caja.
--
-- Cuidado, es una APROXIMACIÓN:
--   * Con la caja «blanda» una venta pudo colgarse del turno de otro cajero (o de ninguno): el autor
--     deducido es el dueño del turno, no necesariamente quien cobró.
--   * Las ventas sin caja, las de la tienda web (origen <> 'mostrador') y las de turnos sin usuario quedan
--     como están (en el reporte siguen saliendo como «Sin registrar (anteriores)»).
--   * No toca ventas que ya tienen autor (las nuevas, registradas por la API).
--   * No rellena el almacén ni el costo: el costo de entonces no se puede saber.
--
-- Requisitos: haber corrido sql/fase19_control_venta_y_bitacora.sql (si no, el paso 1 falla por la columna).
--
-- Cómo usarlo:
--   PASO 1 (solo lectura): corra el SELECT de conteo y revise cuántas ventas se rellenarían.
--   PASO 2 (opcional): si está de acuerdo, corra el bloque BEGIN … COMMIT. El UPDATE devuelve cuántas filas
--   cambió; debe coincidir con «se_rellenan» del paso 1 (si no coincide, ROLLBACK en lugar de COMMIT).
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1    y pegue cada paso por separado.
--
-- Deshacer: no hay forma automática de distinguir después qué autor vino de este script. Si quiere poder
-- deshacerlo, antes del PASO 2 guarde la lista:
--   CREATE TABLE respaldo_autor_ventas_antiguas AS SELECT id_venta FROM ventas WHERE id_usuario IS NULL;
-- =============================================================================

-- PASO 1 · Conteo (solo lectura) -------------------------------------------------------------
WITH turnos AS (
  SELECT a.id_apertura, a.id_caja, a.id_usuario, a.fecha AS desde,
         (SELECT MIN(ci.fecha) FROM cierres_caja ci WHERE ci.id_apertura = a.id_apertura) AS hasta
    FROM aperturas_caja a
   WHERE a.id_usuario IS NOT NULL
),
candidatas AS (
  SELECT v.id_venta,
         (SELECT t.id_usuario
            FROM turnos t
           WHERE t.id_caja = v.id_caja
             AND v.fecha >= t.desde
             AND (t.hasta IS NULL OR v.fecha < t.hasta)
           ORDER BY t.desde DESC
           LIMIT 1) AS id_usuario_turno
    FROM ventas v
   WHERE v.id_usuario IS NULL
     AND v.id_caja IS NOT NULL
     AND COALESCE(v.origen, 'mostrador') = 'mostrador'
)
SELECT (SELECT COUNT(*) FROM ventas WHERE id_usuario IS NULL)       AS ventas_sin_autor,
       COUNT(*)                                                     AS de_mostrador_con_caja,
       COUNT(*) FILTER (WHERE id_usuario_turno IS NOT NULL)          AS se_rellenan,
       COUNT(*) FILTER (WHERE id_usuario_turno IS NULL)              AS quedan_sin_autor
  FROM candidatas;


-- PASO 2 · Relleno (descomente y corra solo si el conteo le parece correcto) ---------------------
-- BEGIN;
-- SET LOCAL lock_timeout = '5s';
-- UPDATE ventas v
--    SET id_usuario = x.id_usuario_turno
--   FROM (
--     SELECT v2.id_venta,
--            (SELECT a.id_usuario
--               FROM aperturas_caja a
--              WHERE a.id_usuario IS NOT NULL
--                AND a.id_caja = v2.id_caja
--                AND v2.fecha >= a.fecha
--                AND NOT EXISTS (SELECT 1 FROM cierres_caja ci
--                                 WHERE ci.id_apertura = a.id_apertura AND ci.fecha <= v2.fecha)
--              ORDER BY a.fecha DESC
--              LIMIT 1) AS id_usuario_turno
--       FROM ventas v2
--      WHERE v2.id_usuario IS NULL
--        AND v2.id_caja IS NOT NULL
--        AND COALESCE(v2.origen, 'mostrador') = 'mostrador'
--   ) x
--  WHERE v.id_venta = x.id_venta
--    AND x.id_usuario_turno IS NOT NULL
--    AND v.id_usuario IS NULL;
-- -- Compare el «UPDATE n» con «se_rellenan» del PASO 1: si coincide, COMMIT; si no, ROLLBACK.
-- COMMIT;

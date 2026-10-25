-- =============================================================================
-- FASE 15 · Índices de rendimiento en llaves foráneas muy consultadas
-- PostgreSQL 12+ · idempotente · aditivo (solo crea índices: no toca datos)
-- =============================================================================
-- Propósito (auditoría del 2026-10-21, hallazgo R02; PLAN V3 D14): estas llaves foráneas
-- no tienen índice, así que cada consulta por ellas recorre la tabla entera. Medido en la
-- BD de pruebas con datos sintéticos (100 000 ventas, 400 000 líneas):
--   1) ix_detalle_venta_venta  detalle_venta (id_venta): el listado de ventas cuenta los
--      ítems de cada fila; también el detalle de la venta, la guía y la anulación.
--      Listado de 50 filas: 1317 ms → 0,7 ms.
--   2) ix_detalle_venta_producto  detalle_venta (id_producto): la verificación de la llave
--      foránea al borrar un producto y las consultas por producto.
--   3) ix_abonos_credito_cxc  abonos_credito (id_cxc, id_abono DESC): los abonos de una
--      cuenta por cobrar en el orden en que se listan, el "¿tiene abonos?" del historial de
--      ventas y el ON DELETE CASCADE. 4,8 ms → 0,16 ms.
--   4) ix_comprobante_items_comprobante  comprobante_items (id_comprobante): los ítems de
--      un comprobante (detalle, PDF, nota de crédito).
--   5) ix_ventas_cliente  ventas (id_cliente) WHERE id_cliente IS NOT NULL: las compras de
--      un cliente y la verificación antes de eliminarlo. Parcial porque la mayoría de las
--      ventas del mostrador no llevan cliente.
-- NO se crean aquí porque ya los crea otra fase (un segundo índice igual solo encarece
-- cada escritura):
--   * clientes (id_usuario): uq_clientes_usuario de fase16 (único y parcial). Si fase16
--     avisó cuentas con más de un cliente, resuélvalas y vuelva a correr fase16.
--   * guias_remision_items (id_guia): ix_guias_remision_items_guia de fase13.
--
-- Orden: DESPUÉS de fase12, fase13, fase14 y fase16. No usa sus columnas; el orden solo
-- garantiza que los índices de la lista anterior ya existen.
--
-- Cómo ejecutarlo (con los datos de hoy tarda menos de un segundo y no bloquea las ventas):
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f sql/fase15_indices_rendimiento.sql
--   o DBeaver en modo auto-commit con "Ejecutar script" (sentencia por sentencia).
-- NO use -1 / --single-transaction ni lo pegue como un solo bloque en una consola web:
-- CREATE INDEX CONCURRENTLY no puede ir dentro de una transacción ("cannot run inside a
-- transaction block").
-- CONCURRENTLY construye el índice sin bloquear lecturas ni escrituras, pero espera a que
-- terminen las transacciones ya abiertas (como mucho lock_timeout = 5 s). Si una sentencia
-- falla por eso, el índice puede quedar INVALID (existe pero no se usa y IF NOT EXISTS ya no
-- lo reconstruye): vuelva a correr el script y el aviso del final le dará el DROP exacto
-- para ejecutarlo a mano antes de una tercera pasada.
--
-- Sin este script la API funciona igual: los índices no cambian ningún resultado, solo
-- evitan los recorridos completos cuando crezcan los datos.
--
-- Verificación posterior (5 filas, todas con indisvalid = true):
--   SELECT c.relname AS indice, i.indisvalid
--     FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
--    WHERE c.relname IN ('ix_detalle_venta_venta', 'ix_detalle_venta_producto', 'ix_abonos_credito_cxc',
--                        'ix_comprobante_items_comprobante', 'ix_ventas_cliente');
-- =============================================================================

SET lock_timeout = '5s';
SET statement_timeout = '15min';


-- 1) y 2) Líneas de la venta -------------------------------------------------------
CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_detalle_venta_venta
  ON detalle_venta (id_venta);

CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_detalle_venta_producto
  ON detalle_venta (id_producto);


-- 3) Abonos de una cuenta por cobrar (mismo orden que el detalle: id_abono DESC) ----
CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_abonos_credito_cxc
  ON abonos_credito (id_cxc, id_abono DESC);


-- 4) Ítems de un comprobante -------------------------------------------------------
CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_comprobante_items_comprobante
  ON comprobante_items (id_comprobante);


-- 5) Ventas de un cliente ----------------------------------------------------------
CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_ventas_cliente
  ON ventas (id_cliente)
  WHERE id_cliente IS NOT NULL;


-- Resumen --------------------------------------------------------------------------
-- Un CONCURRENTLY que falla deja el índice INVALID: PostgreSQL lo mantiene en cada
-- escritura pero nunca lo usa para leer. Este script no borra nada (D15): da el DROP exacto.
DO $$
DECLARE
  v_nombre text;
  v_valido boolean;
BEGIN
  FOREACH v_nombre IN ARRAY ARRAY['ix_detalle_venta_venta', 'ix_detalle_venta_producto', 'ix_abonos_credito_cxc',
                                  'ix_comprobante_items_comprobante', 'ix_ventas_cliente'] LOOP
    SELECT i.indisvalid INTO v_valido
      FROM pg_index i
     WHERE i.indexrelid = to_regclass(format('%I.%I', current_schema(), v_nombre));
    IF v_valido IS NULL THEN
      RAISE NOTICE '%: FALTA (ver el error anterior) - vuelva a correr el script.', v_nombre;
    ELSIF NOT v_valido THEN
      RAISE NOTICE '%: INVALID (su construcción falló) - ejecute DROP INDEX CONCURRENTLY IF EXISTS %; y vuelva a correr el script.',
        v_nombre, v_nombre;
    ELSE
      RAISE NOTICE '%: OK', v_nombre;
    END IF;
  END LOOP;
END $$;

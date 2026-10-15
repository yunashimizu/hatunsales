/**
 * Consulta única que agrega todo lo que mueve el efectivo y los demás medios de un turno.
 * Devuelve filas (fuente, id_metodo, nombre, tipo, total, cantidad, vuelto) que la
 * CalculadoraEsperado convierte en el esperado. Un solo parámetro: $1 = id_apertura.
 *
 * Ventana del turno: [aperturas_caja.fecha, primer cierres_caja.fecha) sobre la caja del
 * turno (una caja solo tiene un turno abierto a la vez). Las fechas sin zona guardan UTC;
 * abonos_credito.creado_en es timestamptz, por eso se compara con `… AT TIME ZONE 'UTC'`.
 *
 * Las variantes solo cambian fragmentos fijos según el esquema detectado; nunca se
 * interpolan valores.
 */
export interface OpcionesSqlEsperado {
  /** Existen cuentas_por_cobrar/abonos_credito: se suman los abonos cobrados por el cajero. */
  conAbonos: boolean;
  /** movimientos_caja.id_apertura existe (fase 11). */
  movimientosPorTurno: boolean;
  /** ventas.estado existe (para excluir anuladas). */
  conEstado: boolean;
  /** ventas.origen existe (para separar ventas web). */
  conOrigen: boolean;
}

export function sqlEsperadoTurno(o: OpcionesSqlEsperado): string {
  const estado = o.conEstado ? `COALESCE(v.estado, 'activa')` : `'activa'`;
  const origen = o.conOrigen ? `COALESCE(v.origen, 'mostrador')` : `'mostrador'`;
  const ventanaMovimiento = `m.id_caja = ap.id_caja AND m.fecha >= ap.desde AND (ap.hasta IS NULL OR m.fecha < ap.hasta)`;
  const condicionMovimiento = o.movimientosPorTurno
    ? `(m.id_apertura = ap.id_apertura OR (m.id_apertura IS NULL AND ${ventanaMovimiento}))`
    : `(${ventanaMovimiento})`;

  const abonos = o.conAbonos
    ? `
UNION ALL
SELECT 'abono', ab.id_metodo, mp.nombre, mp.tipo,
       SUM(ab.monto)::text, COUNT(*)::int, '0'
  FROM ap
  JOIN abonos_credito ab
    ON ab.id_usuario = ap.id_usuario
   AND ab.creado_en >= (ap.desde AT TIME ZONE 'UTC')
   AND (ap.hasta IS NULL OR ab.creado_en < (ap.hasta AT TIME ZONE 'UTC'))
  LEFT JOIN metodos_pago mp ON mp.id_metodo = ab.id_metodo
 GROUP BY ab.id_metodo, mp.nombre, mp.tipo`
    : '';

  return `WITH ap AS (
  SELECT a.id_apertura, a.id_caja, a.id_usuario, a.fecha AS desde,
         (SELECT MIN(ci.fecha) FROM cierres_caja ci WHERE ci.id_apertura = a.id_apertura) AS hasta
    FROM aperturas_caja a
   WHERE a.id_apertura = $1
),
vs AS (
  SELECT v.id_venta, v.total, ${estado} AS estado, ${origen} AS origen
    FROM ap
    JOIN ventas v
      ON v.id_caja = ap.id_caja
     AND v.fecha >= ap.desde
     AND (ap.hasta IS NULL OR v.fecha < ap.hasta)
)
SELECT 'venta' AS fuente, vp.id_metodo, mp.nombre, mp.tipo,
       SUM(vp.monto)::text AS total, COUNT(*)::int AS cantidad, COALESCE(SUM(vp.vuelto), 0)::text AS vuelto
  FROM vs
  JOIN venta_pago vp ON vp.id_venta = vs.id_venta
  LEFT JOIN metodos_pago mp ON mp.id_metodo = vp.id_metodo
 WHERE vs.estado <> 'anulada' AND vs.origen = 'mostrador'
 GROUP BY vp.id_metodo, mp.nombre, mp.tipo${abonos}
UNION ALL
SELECT m.tipo::text, NULL, NULL, NULL, SUM(m.monto)::text, COUNT(*)::int, '0'
  FROM ap
  JOIN movimientos_caja m ON ${condicionMovimiento}
 GROUP BY m.tipo
UNION ALL
SELECT 'venta_web', NULL, NULL, NULL, COALESCE(SUM(vs.total), 0)::text, COUNT(*)::int, '0'
  FROM vs
 WHERE vs.estado <> 'anulada' AND vs.origen <> 'mostrador'
HAVING COUNT(*) > 0
UNION ALL
SELECT 'venta_anulada', NULL, NULL, NULL, COALESCE(SUM(vs.total), 0)::text, COUNT(*)::int, '0'
  FROM vs
 WHERE vs.estado = 'anulada'
HAVING COUNT(*) > 0`;
}

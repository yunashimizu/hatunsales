import { sqlEsperadoTurno } from './sql-esperado';

/** Fase 7.1: la venta anulada y devuelta con un egreso DESPUÉS del cierre sigue contando en su turno cerrado. */
describe('sqlEsperadoTurno · devoluciones enlazadas (Fase 7.1)', () => {
  const base = { conAbonos: true, movimientosPorTurno: true, conEstado: true, conOrigen: true };

  it('sin la opción (antes de fase20) el SQL es exactamente el de antes', () => {
    const sql = sqlEsperadoTurno(base);
    expect(sqlEsperadoTurno({ ...base, devolucionesEnlazadas: false })).toBe(sql);
    expect(sql).not.toContain('devuelta_despues');
    expect(sql).not.toContain('movimientos_caja mr');
    expect(sql).toContain("WHERE vs.estado <> 'anulada' AND vs.origen = 'mostrador'");
    expect(sql).toContain("WHERE vs.estado = 'anulada'\nHAVING");
  });

  it('con la opción: solo un egreso enlazado y POSTERIOR al cierre del turno mantiene la venta anulada en él', () => {
    const sql = sqlEsperadoTurno({ ...base, devolucionesEnlazadas: true });
    expect(sql).toContain("mr.id_venta = v.id_venta AND mr.tipo = 'egreso'");
    expect(sql).toContain('ap.hasta IS NOT NULL AND mr.fecha >= ap.hasta');
    expect(sql).toContain("WHERE (vs.estado <> 'anulada' OR vs.devuelta_despues) AND vs.origen = 'mostrador'");
    expect(sql).toContain("WHERE vs.estado = 'anulada' AND NOT vs.devuelta_despues");
    // Las ventas web no cambian.
    expect(sql).toContain("WHERE vs.estado <> 'anulada' AND vs.origen <> 'mostrador'");
    // Un solo parámetro, como siempre.
    expect(sql.match(/\$\d+/g)).toEqual(['$1']);
  });
});

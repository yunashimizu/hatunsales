import { ReportesBussnies } from './reportes.bussnies';

/**
 * Ventas netas por hora de Lima. Misma regla que el reporte de ventas
 * (clasificarComprobanteReporte): NC resta, ND suma, anuladas/rechazadas/BETA no cuentan.
 */
function comp(id: number, creadoEn: string, total: string, datos: Record<string, unknown> = {}) {
  return {
    id_comprobante: id,
    creado_en: new Date(creadoEn),
    total,
    anulado: false,
    estado: 'emitido',
    estado_sunat: 'ACEPTADO',
    ambiente_fiscal: 'produccion',
    tipo: { id_tipo: 2, nombre: 'BOLETA' },
    ...datos,
  };
}

/** Repositorio doble que, como el real, entrega solo lo creado dentro de [desde, hasta). */
function armar(todos: any[] = []) {
  const repo = {
    obtenerVentasPorPeriodo: jest.fn(async (desde: Date, hasta: Date) =>
      todos.filter((c) => c.creado_en >= desde && c.creado_en < hasta)),
  };
  return { servicio: new ReportesBussnies(repo as any), repo };
}

describe('ReportesBussnies.ventasPorHora', () => {
  beforeEach(() => jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] }));
  afterEach(() => jest.useRealTimers());

  it('siempre devuelve las 24 horas (0..23), con ceros donde no hubo ventas', async () => {
    const { servicio } = armar();

    const r = await servicio.ventasPorHora('2026-10-21');

    expect(r.horas).toHaveLength(24);
    expect(r.horas.map((h) => h.hora)).toEqual(Array.from({ length: 24 }, (_, i) => i));
    expect(r.horas.every((h) => h.total === 0 && h.ventas === 0)).toBe(true);
    expect(r.comparacion.horas).toHaveLength(24);
  });

  it('agrupa por hora de Lima: 02:30 UTC es la hora 21 del día anterior de Lima', async () => {
    const { servicio, repo } = armar([
      comp(1, '2026-10-21T02:30:00Z', '50.00'), // 20/10 21:30 en Lima
      comp(2, '2026-10-21T15:10:00Z', '30.50'), // 21/10 10:10 en Lima
      comp(3, '2026-10-21T15:50:00Z', '20.25'), // 21/10 10:50 en Lima
    ]);

    const dia20 = await servicio.ventasPorHora('2026-10-20');
    const dia21 = await servicio.ventasPorHora('2026-10-21');

    expect(dia20.horas[21]).toEqual({ hora: 21, total: 50, ventas: 1 });
    expect(dia20.horas[2]).toEqual({ hora: 2, total: 0, ventas: 0 });
    expect(dia21.horas[10]).toEqual({ hora: 10, total: 50.75, ventas: 2 });
    expect(dia21.horas[21].total).toBe(0);
    const [desde, hasta] = repo.obtenerVentasPorPeriodo.mock.calls[2];
    expect(desde.toISOString()).toBe('2026-10-21T05:00:00.000Z');
    expect(hasta.toISOString()).toBe('2026-10-22T05:00:00.000Z');
  });

  it('las notas de crédito restan (sin contar como venta), la de débito suma, y el total sale con 2 decimales', async () => {
    const { servicio } = armar([
      comp(1, '2026-10-21T15:00:00Z', '100.10'),
      comp(2, '2026-10-21T15:20:00Z', '30.00', { tipo: { id_tipo: 7 } }),
      comp(3, '2026-10-21T15:40:00Z', '5.05', { tipo: { id_tipo: 8 } }),
    ]);

    const r = await servicio.ventasPorHora('2026-10-21');

    expect(r.horas[10]).toEqual({ hora: 10, total: 75.15, ventas: 1 });
  });

  it('no cuentan anuladas, con error, rechazadas ni pruebas BETA', async () => {
    const { servicio } = armar([
      comp(1, '2026-10-21T15:00:00Z', '10.00'),
      comp(2, '2026-10-21T15:00:00Z', '99.00', { anulado: true }),
      comp(3, '2026-10-21T15:00:00Z', '99.00', { estado: 'anulado' }),
      comp(4, '2026-10-21T15:00:00Z', '99.00', { estado_sunat: 'ANULADO' }),
      comp(5, '2026-10-21T15:00:00Z', '99.00', { estado: 'error' }),
      comp(6, '2026-10-21T15:00:00Z', '99.00', { estado_sunat: 'RECHAZADO' }),
      comp(7, '2026-10-21T15:00:00Z', '99.00', { ambiente_fiscal: 'beta' }),
    ]);

    const r = await servicio.ventasPorHora('2026-10-21');

    expect(r.horas[10]).toEqual({ hora: 10, total: 10, ventas: 1 });
  });

  it('la comparación es el mismo día de la semana anterior (fecha − 7 días) con sus propias ventas', async () => {
    const { servicio, repo } = armar([
      comp(1, '2026-10-21T15:00:00Z', '40.00'),
      comp(2, '2026-10-14T20:00:00Z', '25.00'), // 14/10 15:00 en Lima
    ]);

    const r = await servicio.ventasPorHora('2026-10-21');

    expect(r.fecha).toBe('2026-10-21');
    expect(r.comparacion.fecha).toBe('2026-10-14');
    expect(r.horas[10].total).toBe(40);
    expect(r.comparacion.horas[15]).toEqual({ hora: 15, total: 25, ventas: 1 });
    expect(repo.obtenerVentasPorPeriodo).toHaveBeenCalledTimes(2);
  });

  it('sin fecha usa HOY en Lima (a las 20:00 de Lima ya es "mañana" en UTC)', async () => {
    jest.setSystemTime(new Date('2026-10-22T01:00:00Z')); // 21/10 20:00 en Lima
    const { servicio } = armar();

    const r = await servicio.ventasPorHora();

    expect(r.fecha).toBe('2026-10-21');
    expect(r.comparacion.fecha).toBe('2026-10-14');
  });

  it.each(['2026-02-30', '21/10/2026', 'hoy', '2026-13-01'])('fecha inválida (%s) responde 400 REPORTE_FECHA_INVALIDA', async (mala) => {
    const { servicio, repo } = armar();

    await expect(servicio.ventasPorHora(mala)).rejects.toMatchObject({
      status: 400,
      response: expect.objectContaining({ codigo: 'REPORTE_FECHA_INVALIDA' }),
    });
    expect(repo.obtenerVentasPorPeriodo).not.toHaveBeenCalled();
  });
});

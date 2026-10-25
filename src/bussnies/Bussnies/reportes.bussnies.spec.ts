import { BadRequestException } from '@nestjs/common';
import { ReportesBussnies, clasificarComprobanteReporte, diaLimaComprobante } from './reportes.bussnies';

/**
 * Reporte de ventas: días de Lima (el servidor corre en UTC) y ventas NETAS.
 *
 * Regla de lo que cuenta (clasificarComprobanteReporte):
 * - factura y boleta suman, la nota de crédito (id_tipo 7) resta, la de débito (8) suma;
 * - no cuentan los anulados, los de prueba BETA, los que quedaron en 'error' ni los
 *   RECHAZADOS por SUNAT; los históricos de Nubefact (ambiente nulo) cuentan.
 */
function comprobante(id: number, datos: Record<string, unknown> = {}) {
  return {
    id_comprobante: id,
    serie: 'F001',
    numero: id,
    cliente_denominacion: 'CLIENTE ' + id,
    cliente_numero_doc: '2050000000' + (id % 10),
    fecha_de_emision: '2026-10-21',
    creado_en: new Date('2026-10-21T15:00:00Z'),
    total: '0.00',
    anulado: false,
    estado: 'emitido',
    estado_sunat: 'ACEPTADO',
    ambiente_fiscal: 'produccion',
    proveedor_fiscal: 'sunat_directo',
    tipo: { id_tipo: 1, nombre: 'FACTURA' },
    ...datos,
  };
}

function armar(lista: any[] = []) {
  const repo = { obtenerVentasPorPeriodo: jest.fn().mockResolvedValue(lista) };
  return { servicio: new ReportesBussnies(repo as any), repo };
}

describe('ReportesBussnies · periodos en días de Lima', () => {
  beforeEach(() => jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] }));
  afterEach(() => jest.useRealTimers());

  it('a las 20:00 de Lima el diario cubre de 00:00 a 23:59 de Lima (no desde las 19:00 de ayer)', async () => {
    jest.setSystemTime(new Date('2026-10-22T01:00:00Z')); // 21/10 20:00 en Lima
    const { servicio, repo } = armar();

    const r = await servicio.reporteVentas('diario', {});

    const [desde, hasta] = repo.obtenerVentasPorPeriodo.mock.calls[0];
    expect(desde.toISOString()).toBe('2026-10-21T05:00:00.000Z');
    expect(hasta.toISOString()).toBe('2026-10-22T05:00:00.000Z');
    expect(r.fecha_inicio).toBe('2026-10-21T05:00:00.000Z');
    expect(r.fecha_fin).toBe('2026-10-22T04:59:59.999Z');
  });

  it('el 31/10 a las 21:00 de Lima el mensual sigue siendo octubre', async () => {
    jest.setSystemTime(new Date('2026-11-01T02:00:00Z'));
    const { servicio, repo } = armar();

    await servicio.reporteVentas('mensual', {});

    const [desde, hasta] = repo.obtenerVentasPorPeriodo.mock.calls[0];
    expect(desde.toISOString()).toBe('2026-10-01T05:00:00.000Z');
    expect(hasta.toISOString()).toBe('2026-11-01T05:00:00.000Z');
  });

  it('el domingo por la noche la semana empieza el lunes anterior de Lima', async () => {
    jest.setSystemTime(new Date('2026-10-26T03:00:00Z')); // domingo 25/10 22:00 en Lima
    const { servicio, repo } = armar();

    await servicio.reporteVentas('semana', {});

    expect(repo.obtenerVentasPorPeriodo.mock.calls[0][0].toISOString()).toBe('2026-10-19T05:00:00.000Z');
  });

  it('quincenal y anual también arrancan a las 00:00 de Lima', async () => {
    jest.setSystemTime(new Date('2027-01-01T03:00:00Z')); // 31/12/2026 22:00 en Lima
    const { servicio, repo } = armar();

    await servicio.reporteVentas('quincenal', {});
    await servicio.reporteVentas('anual', {});

    expect(repo.obtenerVentasPorPeriodo.mock.calls[0][0].toISOString()).toBe('2026-12-16T05:00:00.000Z');
    expect(repo.obtenerVentasPorPeriodo.mock.calls[1][0].toISOString()).toBe('2026-01-01T05:00:00.000Z');
  });

  it('un rango personalizado toma los días completos de Lima y rechaza fechas mal escritas', async () => {
    const { servicio, repo } = armar();

    await servicio.reporteVentas('diario', { fecha_inicio: '2026-10-01', fecha_fin: '2026-10-15' });
    const [desde, hasta] = repo.obtenerVentasPorPeriodo.mock.calls[0];
    expect(desde.toISOString()).toBe('2026-10-01T05:00:00.000Z');
    expect(hasta.toISOString()).toBe('2026-10-16T05:00:00.000Z');

    await expect(
      servicio.reporteVentas('diario', { fecha_inicio: '2026-13-01', fecha_fin: '2026-10-15' }),
    ).rejects.toMatchObject({ response: expect.objectContaining({ codigo: 'REPORTE_FECHA_INVALIDA' }) });
    await expect(
      servicio.reporteVentas('diario', { fecha_inicio: '2026-10-15', fecha_fin: '2026-10-01' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('una venta de las 20:30 de Lima se agrupa en su día de Lima, no en el siguiente', async () => {
    jest.setSystemTime(new Date('2026-10-22T02:00:00Z'));
    const { servicio } = armar([
      comprobante(1, { fecha_de_emision: '', creado_en: new Date('2026-10-22T01:30:00Z'), total: '40.00' }),
    ]);

    const r = await servicio.reporteVentas('mensual', {});

    expect(r.detalle[0].fecha).toBe('2026-10-21');
    expect(r.estadisticas.serie).toEqual([{ clave: '2026-10-21', etiqueta: '21 oct', total: 40, cantidad: 1 }]);
  });
});

describe('clasificarComprobanteReporte · qué cuenta como venta', () => {
  it.each([
    ['factura aceptada', comprobante(1), { cuenta: true, signo: 1, tipo: 'venta' }],
    ['boleta', comprobante(2, { tipo: { id_tipo: 2 } }), { cuenta: true, signo: 1, tipo: 'venta' }],
    ['nota de crédito: resta', comprobante(3, { tipo: { id_tipo: 7 } }), { cuenta: true, signo: -1, tipo: 'nota_credito' }],
    ['nota de débito: suma', comprobante(4, { tipo: { id_tipo: 8 } }), { cuenta: true, signo: 1, tipo: 'nota_debito' }],
    [
      'histórico de Nubefact (ambiente nulo) sigue contando',
      comprobante(5, { ambiente_fiscal: null, proveedor_fiscal: 'nubefact', estado_sunat: null }),
      { cuenta: true, signo: 1, tipo: 'venta' },
    ],
    ['pendiente de envío a SUNAT cuenta', comprobante(6, { estado_sunat: 'PENDIENTE_REENVIO' }), { cuenta: true, signo: 1, tipo: 'venta' }],
    ['anulado', comprobante(7, { anulado: true }), { cuenta: false, motivo: 'anulado' }],
    ['baja aceptada', comprobante(8, { estado_sunat: 'ANULADO' }), { cuenta: false, motivo: 'anulado' }],
    ['prueba BETA', comprobante(9, { ambiente_fiscal: 'beta' }), { cuenta: false, motivo: 'prueba' }],
    ['con error (no se emitió)', comprobante(10, { estado: 'error', estado_sunat: null }), { cuenta: false, motivo: 'error' }],
    ['rechazado por SUNAT', comprobante(11, { estado_sunat: 'RECHAZADO' }), { cuenta: false, motivo: 'rechazado' }],
    [
      'nota de crédito rechazada no resta',
      comprobante(12, { tipo: { id_tipo: 7 }, estado_sunat: 'RECHAZADO' }),
      { cuenta: false, motivo: 'rechazado' },
    ],
  ])('%s', (_caso, c, esperado) => {
    expect(clasificarComprobanteReporte(c)).toEqual(esperado);
  });
});

describe('ReportesBussnies · ventas netas', () => {
  const lista = [
    comprobante(1, { total: '100.00', cliente_denominacion: 'ACME', cliente_numero_doc: '20111111111' }),
    comprobante(2, { total: '50.00', serie: 'B001', tipo: { id_tipo: 2 } }),
    comprobante(3, { total: '30.00', serie: 'FC01', tipo: { id_tipo: 7 }, cliente_denominacion: 'ACME', cliente_numero_doc: '20111111111' }),
    comprobante(4, { total: '10.00', serie: 'FD01', tipo: { id_tipo: 8 } }),
    comprobante(5, { total: '999.00', anulado: true }),
    comprobante(6, { total: '500.00', ambiente_fiscal: 'beta', serie: 'FB01' }),
    comprobante(7, { total: '70.00', estado: 'error', estado_sunat: null }),
    comprobante(8, { total: '80.00', estado_sunat: 'RECHAZADO' }),
  ];

  it('resta las notas de crédito, suma las de débito y deja fuera anulados, BETA, error y rechazados', async () => {
    const { servicio } = armar(lista);

    const r = await servicio.reporteVentas('mensual', {});

    expect(r.total_vendido).toBe(130); // 100 + 50 + 10 − 30
    expect(r.total_bruto).toBe(160);
    expect(r.notas_credito).toEqual({ cantidad: 1, total: 30 });
    expect(r.notas_debito).toEqual({ cantidad: 1, total: 10 });
    expect(r.cantidad_comprobantes).toBe(2); // facturas y boletas
    expect(r.ticket_promedio).toBe(65);
    expect(r.excluidos).toEqual({ anulados: 1, con_error: 1, rechazados: 1 });
    expect(r.detalle.map((d) => [d.id_comprobante, d.total_vendido, d.tipo_documento])).toEqual([
      [1, 100, 'venta'],
      [2, 50, 'venta'],
      [3, -30, 'nota_credito'],
      [4, 10, 'nota_debito'],
    ]);
  });

  it('las estadísticas usan el mismo neto: máximos de ventas, anulados y errores reales, top por cliente', async () => {
    const { servicio } = armar(lista);

    const { estadisticas } = await servicio.reporteVentas('mensual', {});

    expect(estadisticas.venta_maxima).toBe(100);
    expect(estadisticas.venta_minima).toBe(50);
    expect(estadisticas.emitidos).toBe(4);
    expect(estadisticas.anulados).toBe(1);
    expect(estadisticas.con_error).toBe(2);
    expect(estadisticas.serie).toEqual([{ clave: '2026-10-21', etiqueta: '21 oct', total: 130, cantidad: 4 }]);
    expect(estadisticas.top_clientes[0]).toEqual({ cliente: 'ACME', documento: '20111111111', total: 70, cantidad: 2 });
  });

  it('el Excel muestra el neto y la línea de notas de crédito', async () => {
    const { servicio } = armar(lista);
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const ExcelJS = require('exceljs');

    const { buffer } = await servicio.exportVentasExcel('mensual', {});
    const libro = new ExcelJS.Workbook();
    await libro.xlsx.load(buffer);
    const hoja = libro.getWorksheet('Ventas');
    const resumen: Record<string, unknown> = {};
    hoja.eachRow((fila: any) => {
      const etiqueta = fila.getCell(1).value;
      if (typeof etiqueta === 'string') resumen[etiqueta] = fila.getCell(2).value;
    });

    expect(resumen['Total vendido']).toBe(130);
    expect(resumen['Notas de crédito']).toBe(-30);
    expect(resumen['Anulados']).toBe(1);
  });
});

describe('diaLimaComprobante', () => {
  it('usa la fecha de emisión (AAAA-MM-DD o DD-MM-AAAA) y si no el día de Lima del registro', () => {
    expect(diaLimaComprobante({ fecha_de_emision: '2026-10-21' })).toBe('2026-10-21');
    expect(diaLimaComprobante({ fecha_de_emision: '21-10-2026' })).toBe('2026-10-21');
    expect(diaLimaComprobante({ fecha_de_emision: null, creado_en: new Date('2026-10-22T04:59:00Z') })).toBe('2026-10-21');
    expect(diaLimaComprobante({ fecha_de_emision: '', creado_en: null })).toBe('');
  });
});

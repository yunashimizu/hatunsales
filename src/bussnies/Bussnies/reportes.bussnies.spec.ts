import { emisorConfig } from '../../config/emisor.config';
import { BadRequestException } from '@nestjs/common';
import { ReportesBussnies, clasificarComprobanteReporte, diaLimaComprobante } from './reportes.bussnies';
import { obtenerLogoEmisor } from '../../util/documentos/logo-emisor';

// Por defecto el logo es el real (el oficial del repo); cada prueba de logo lo reemplaza con mockResolvedValueOnce.
jest.mock('../../util/documentos/logo-emisor', () => {
  const real = jest.requireActual('../../util/documentos/logo-emisor');
  return { ...real, obtenerLogoEmisor: jest.fn(real.obtenerLogoEmisor) };
});
const logoMock = obtenerLogoEmisor as jest.MockedFunction<typeof obtenerLogoEmisor>;

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

function armar(lista: any[] = [], vendidos: any[] = [], cotizados: any[] = []) {
  const repo = {
    obtenerVentasPorPeriodo: jest.fn().mockResolvedValue(lista),
    obtenerProductosVendidos: jest.fn().mockResolvedValue(vendidos),
    obtenerProductosCotizados: jest.fn().mockResolvedValue(cotizados),
  };
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
    const hoja = libro.getWorksheet('Resumen');
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


describe('ReportesBussnies · por tipo de comprobante', () => {
  // factura 100, boleta 50, nota de crédito 30, nota de débito 10 y cuatro que no cuentan (facturas).
  const lista = [
    comprobante(1, { total: '100.00' }),
    comprobante(2, { total: '50.00', serie: 'B001', tipo: { id_tipo: 2 } }),
    comprobante(3, { total: '30.00', serie: 'FC01', tipo: { id_tipo: 7 } }),
    comprobante(4, { total: '10.00', serie: 'FD01', tipo: { id_tipo: 8 } }),
    comprobante(5, { total: '999.00', anulado: true }),
    comprobante(6, { total: '500.00', ambiente_fiscal: 'beta' }),
    comprobante(7, { total: '70.00', estado: 'error', estado_sunat: null }),
    comprobante(8, { total: '80.00', estado_sunat: 'RECHAZADO' }),
  ];

  it('solo boletas: el tipo se filtra en memoria (no en SQL) y el reporte cuenta solo esas', async () => {
    const { servicio, repo } = armar(lista);

    const r = await servicio.reporteVentas('mensual', { id_tipo: 2 });

    expect(repo.obtenerVentasPorPeriodo.mock.calls[0][2]).toEqual({ id_cliente: undefined, id_moneda: undefined });
    expect(r.total_vendido).toBe(50);
    expect(r.cantidad_comprobantes).toBe(1);
    expect(r.detalle.map((d) => [d.id_comprobante, d.id_tipo])).toEqual([[2, 2]]);
    expect(r.excluidos).toEqual({ anulados: 0, con_error: 0, rechazados: 0 }); // los excluidos eran facturas
    expect(r.filtro_tipo).toEqual({ id_tipo: 2, nombre: 'Boletas' });
    expect(r.estadisticas.serie).toEqual([{ clave: '2026-10-21', etiqueta: '21 oct', total: 50, cantidad: 1 }]);
  });

  it('solo facturas: los anulados, con error y rechazados que se informan son los de facturas', async () => {
    const { servicio } = armar(lista);

    const r = await servicio.reporteVentas('mensual', { id_tipo: 1 });

    expect(r.total_vendido).toBe(100);
    expect(r.excluidos).toEqual({ anulados: 1, con_error: 1, rechazados: 1 });
  });

  it('sin filtro el resultado es el de siempre y filtro_tipo es null', async () => {
    const { servicio } = armar(lista);

    const r = await servicio.reporteVentas('mensual', {});

    expect(r.total_vendido).toBe(130);
    expect(r.filtro_tipo).toBeNull();
    expect(r.productos_modo).toBe('vendidos');
  });

  it('por_tipo reparte lo vendido entre TODOS los tipos aunque se filtre por uno (la nota de crédito va en negativo)', async () => {
    const { servicio } = armar(lista);

    const filtrado = await servicio.reporteVentas('mensual', { id_tipo: 2 });
    const todos = await servicio.reporteVentas('mensual', {});

    const esperado = [
      { id_tipo: 1, tipo: 'Facturas', cantidad: 1, total: 100 },
      { id_tipo: 2, tipo: 'Boletas', cantidad: 1, total: 50 },
      { id_tipo: 7, tipo: 'Notas de crédito', cantidad: 1, total: -30 },
      { id_tipo: 8, tipo: 'Notas de débito', cantidad: 1, total: 10 },
    ];
    expect(todos.por_tipo).toEqual(esperado);
    expect(filtrado.por_tipo).toEqual(esperado);
  });

  it('un tipo filtrado sin comprobantes aparece con ceros; un id inválido (NaN, 0, decimal) no filtra', async () => {
    const { servicio } = armar([comprobante(1, { total: '100.00' })]);

    const sinBoletas = await servicio.reporteVentas('mensual', { id_tipo: 2 });
    expect(sinBoletas.detalle).toEqual([]);
    expect(sinBoletas.por_tipo.find((t) => t.id_tipo === 2)).toEqual({ id_tipo: 2, tipo: 'Boletas', cantidad: 0, total: 0 });

    for (const invalido of [Number.NaN, 0, 1.5, -2]) {
      const r = await servicio.reporteVentas('mensual', { id_tipo: invalido });
      expect(r.filtro_tipo).toBeNull();
      expect(r.total_vendido).toBe(100);
    }
  });

  it('solo notas de crédito: los rankings pasan a «devueltos» y piden los números en positivo', async () => {
    const { servicio, repo } = armar(lista);

    const r = await servicio.reporteVentas('mensual', { id_tipo: 7 });

    expect(r.productos_modo).toBe('devueltos');
    expect(repo.obtenerProductosVendidos).toHaveBeenCalledWith([3], 10, true);
  });
});

describe('ReportesBussnies · productos más vendidos y más cotizados', () => {
  const lista = [
    comprobante(1, { total: '100.00' }),
    comprobante(2, { total: '50.00', tipo: { id_tipo: 2 } }),
    comprobante(5, { total: '999.00', anulado: true }),
  ];

  it('pide los ítems solo de los comprobantes que cuentan y mapea los dos rankings', async () => {
    const { servicio, repo } = armar(
      lista,
      [
        { id_producto: 2, codigo: '0002', descripcion: 'Cemento', cantidad: '119.00', total: '3865.00', comprobantes: '4' },
        { id_producto: null, codigo: null, descripcion: null, cantidad: '2', total: '10.00', comprobantes: '1' },
        { id_producto: 9, codigo: 'X', descripcion: 'Devuelto del todo', cantidad: '0', total: '0', comprobantes: '2' },
      ],
      [{ id_producto: 10, sku: '0009', descripcion: 'acero', cotizaciones: '2', cantidad: '2', total: '30.00', convertidas: '1' }],
    );

    const r = await servicio.reporteVentas('mensual', {});

    expect(repo.obtenerProductosVendidos).toHaveBeenCalledWith([1, 2], 10, false);
    expect(repo.obtenerProductosCotizados.mock.calls[0].slice(2)).toEqual([10, undefined]);
    expect(r.top_productos_vendidos).toEqual([
      { id_producto: 2, codigo: '0002', producto: 'Cemento', cantidad: 119, total: 3865, comprobantes: 4 },
      { id_producto: null, codigo: '', producto: 'Producto sin descripción', cantidad: 2, total: 10, comprobantes: 1 },
    ]); // el que quedó en cero neto no sale
    expect(r.top_productos_cotizados).toEqual([
      { id_producto: 10, sku: '0009', producto: 'acero', cotizaciones: 2, cantidad: 2, total: 30, convertidas: 1 },
    ]);
  });

  it('si los rankings fallan, el reporte de ventas sale completo con los rankings vacíos', async () => {
    const { servicio, repo } = armar(lista);
    repo.obtenerProductosVendidos.mockRejectedValue(new Error('relation does not exist'));
    const aviso = jest.spyOn((servicio as any).logger, 'warn').mockImplementation(() => undefined);

    const r = await servicio.reporteVentas('mensual', {});

    expect(r.total_vendido).toBe(150);
    expect(r.top_productos_vendidos).toEqual([]);
    expect(r.top_productos_cotizados).toEqual([]);
    expect(aviso).toHaveBeenCalled();
  });

  it('los límites de la pantalla (10) y del Excel (50) se piden al repositorio', async () => {
    const { servicio, repo } = armar(lista);

    await servicio.exportVentasExcel('mensual', {});

    expect(repo.obtenerProductosVendidos).toHaveBeenLastCalledWith([1, 2], 50, false);
  });
});

describe('ReportesBussnies · exportes profesionales', () => {
  const lista = [
    comprobante(1, { total: '100.00', cliente_denominacion: 'ACME' }),
    comprobante(2, { total: '50.00', serie: 'B001', tipo: { id_tipo: 2 } }),
    comprobante(3, { total: '30.00', serie: 'FC01', tipo: { id_tipo: 7 } }),
  ];
  const vendidos = [{ id_producto: 2, codigo: '0002', descripcion: 'Cemento', cantidad: '5', total: '120.00', comprobantes: '2' }];
  const cotizados = [{ id_producto: 10, sku: '0009', descripcion: 'acero', cotizaciones: '2', cantidad: '2', total: '30.00', convertidas: '1' }];

  async function leer(buffer: Buffer) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const ExcelJS = require('exceljs');
    const libro = new ExcelJS.Workbook();
    await libro.xlsx.load(buffer);
    return libro;
  }

  it('el Excel trae las hojas del reporte y el nombre de archivo lleva el tipo', async () => {
    const { servicio } = armar(lista, vendidos, cotizados);

    const { buffer, filename } = await servicio.exportVentasExcel('mensual', { id_tipo: 2 });
    const libro = await leer(buffer);

    expect(filename).toMatch(/^ventas_boletas_mensual_\d{8}\.xlsx$/);
    expect(libro.worksheets.map((h: any) => h.name)).toEqual([
      'Resumen', 'Detalle', 'Tendencia', 'Productos vendidos', 'Productos cotizados', 'Clientes',
    ]);
  });

  it('el Detalle usa fechas y montos reales, tipo legible, autofiltro, cabecera inmovilizada y total con fórmula', async () => {
    const { servicio } = armar(lista, vendidos, cotizados);

    const { buffer } = await servicio.exportVentasExcel('mensual', {});
    const detalle = (await leer(buffer)).getWorksheet('Detalle');

    const cabecera = detalle.getRow(5).values.slice(1);
    expect(cabecera).toEqual(['N.º', 'Fecha', 'Tipo', 'Comprobante', 'Cliente', 'Documento', 'Estado', 'Total']);
    const primera = detalle.getRow(6);
    expect(primera.getCell(2).value).toBeInstanceOf(Date);
    expect((primera.getCell(2).value as Date).toISOString().slice(0, 10)).toBe('2026-10-21');
    expect(detalle.getRow(6).getCell(3).value).toBe('Factura');
    expect(detalle.getRow(7).getCell(3).value).toBe('Boleta');
    expect(detalle.getRow(8).getCell(3).value).toBe('Nota de crédito');
    expect(detalle.getRow(8).getCell(8).value).toBe(-30);
    const total = detalle.getRow(9).getCell(8).value as { formula: string; result: number };
    expect(total.formula).toBe('SUBTOTAL(109,H6:H8)');
    expect(total.result).toBe(120);
    expect(detalle.views[0]).toMatchObject({ state: 'frozen', ySplit: 5 });
    expect(detalle.autoFilter).toBeTruthy();
  });

  it('las hojas de productos llevan sus columnas y la conversión de cotizaciones', async () => {
    const { servicio } = armar(lista, vendidos, cotizados);

    const { buffer } = await servicio.exportVentasExcel('mensual', {});
    const libro = await leer(buffer);

    const vendidosHoja = libro.getWorksheet('Productos vendidos');
    expect(vendidosHoja.getRow(5).values.slice(1)).toEqual([
      '#', 'Código', 'Producto', 'Cantidad vendida', 'Importe', '% de las ventas', 'Comprobantes',
    ]);
    expect(vendidosHoja.getRow(6).values.slice(1, 6)).toEqual([1, '0002', 'Cemento', 5, 120]);

    const cotizadosHoja = libro.getWorksheet('Productos cotizados');
    const fila = cotizadosHoja.getRow(6).values.slice(1);
    expect(fila.slice(0, 7)).toEqual([1, '0009', 'acero', 2, 2, 30, 1]);
    expect(fila[7]).toBeCloseTo(0.5); // 1 de 2 cotizaciones llegó a venta
  });

  it('con un filtro, el resumen lo dice y el reparto por tipo marca el filtro aplicado', async () => {
    const { servicio } = armar(lista);

    const { buffer } = await servicio.exportVentasExcel('mensual', { id_tipo: 2 });
    const resumen = (await leer(buffer)).getWorksheet('Resumen');
    const textos: string[] = [];
    resumen.eachRow((fila: any) => {
      fila.eachCell((celda: any) => {
        if (typeof celda.value === 'string') textos.push(celda.value);
      });
    });

    expect(textos.some((t) => t.includes('Tipo: Boletas'))).toBe(true);
    expect(textos.some((t) => t.includes('filtro aplicado'))).toBe(true);
  });

  it('el PDF es un PDF válido con varias secciones, también para un reporte vacío', async () => {
    const lleno = armar(lista, vendidos, cotizados);
    const { buffer, filename } = await lleno.servicio.exportVentasPdf('mensual', { id_tipo: 2 });

    expect(buffer.subarray(0, 5).toString()).toBe('%PDF-');
    expect(buffer.subarray(-8).toString()).toContain('%%EOF');
    expect(buffer.length).toBeGreaterThan(5_000);
    expect(filename).toMatch(/^ventas_boletas_mensual_\d{8}\.pdf$/);

    const vacio = armar([]);
    const pdfVacio = await vacio.servicio.exportVentasPdf('diario', {});
    expect(pdfVacio.buffer.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('un detalle largo se reparte en páginas con la cabecera repetida y no revienta', async () => {
    const muchos = Array.from({ length: 220 }, (_, i) =>
      comprobante(i + 1, { total: '10.00', cliente_denominacion: 'CLIENTE CON UN NOMBRE MUY LARGO ' + i }),
    );
    const { servicio } = armar(muchos, vendidos, cotizados);

    const { buffer } = await servicio.exportVentasPdf('anual', {});

    const paginas = (buffer.toString('latin1').match(/\/Type \/Page\b/g) ?? []).length;
    expect(paginas).toBeGreaterThan(5);
  });

  describe('logo del emisor en el reporte de ventas', () => {
    const imagenesDelExcel = (libro: any) => libro.worksheets.reduce((n: number, h: any) => n + h.getImages().length, 0);
    const imagenesDelPdf = (buffer: Buffer) => (buffer.toString('latin1').match(/\/Subtype \/Image/g) ?? []).length;

    it('con logo, el Excel lo inserta en cada hoja y el PDF lo dibuja en la banda de empresa', async () => {
      const { servicio } = armar(lista, vendidos, cotizados);

      const excel = await servicio.exportVentasExcel('mensual', {});
      const libro = await leer(excel.buffer);
      const pdf = await servicio.exportVentasPdf('mensual', {});

      expect(imagenesDelExcel(libro)).toBe(libro.worksheets.length);
      // El texto del encabezado se corre a la derecha para no quedar debajo del logo.
      expect(libro.getWorksheet('Resumen').getCell(1, 1).alignment.indent).toBeGreaterThan(0);
      expect(imagenesDelPdf(pdf.buffer)).toBeGreaterThan(0);
      expect(pdf.buffer.subarray(0, 5).toString()).toBe('%PDF-');
    });

    it('sin logo, el Excel y el PDF se generan igual, sin imagen ni sangría', async () => {
      const { servicio } = armar(lista, vendidos, cotizados);
      logoMock.mockResolvedValueOnce(null);
      const excel = await servicio.exportVentasExcel('mensual', {});
      logoMock.mockResolvedValueOnce(null);
      const pdf = await servicio.exportVentasPdf('mensual', {});
      const libro = await leer(excel.buffer);

      expect(imagenesDelExcel(libro)).toBe(0);
      expect(libro.getWorksheet('Resumen').getCell(1, 1).alignment.indent ?? 0).toBe(0);
      expect(imagenesDelPdf(pdf.buffer)).toBe(0);
      expect(pdf.buffer.subarray(0, 5).toString()).toBe('%PDF-');
    });

    it('un logo ilegible no impide el PDF y si falla la lectura del logo el reporte sale igual', async () => {
      const { servicio } = armar(lista, vendidos, cotizados);
      logoMock.mockResolvedValueOnce(Buffer.from('esto no es una imagen'));
      const ilegible = await servicio.exportVentasPdf('mensual', {});
      logoMock.mockRejectedValueOnce(new Error('sin red'));
      const sinLectura = await servicio.exportVentasPdf('mensual', {});

      for (const { buffer } of [ilegible, sinLectura]) {
        expect(buffer.subarray(0, 5).toString()).toBe('%PDF-');
        expect(buffer.subarray(-8).toString()).toContain('%%EOF');
      }
    });

    it('usa el «Logo para documentos» del panel y, si no hay o falla la lectura, el de la configuración de entorno', async () => {
      const repo = {
        obtenerVentasPorPeriodo: jest.fn().mockResolvedValue(lista),
        obtenerProductosVendidos: jest.fn().mockResolvedValue(vendidos),
        obtenerProductosCotizados: jest.fn().mockResolvedValue(cotizados),
      };
      const obtenerVarias = jest.fn().mockResolvedValue({ emisor_logo_url: ' /uploads/otro.png ' });
      const servicio = new ReportesBussnies(repo as any, { obtenerVarias } as any);

      logoMock.mockClear();
      await servicio.exportVentasPdf('mensual', {});
      expect(obtenerVarias).toHaveBeenCalledWith(['emisor_logo_url']);
      expect(logoMock).toHaveBeenLastCalledWith('/uploads/otro.png');

      obtenerVarias.mockRejectedValueOnce(new Error('sin base'));
      await servicio.exportVentasPdf('mensual', {});
      expect(logoMock).toHaveBeenLastCalledWith(emisorConfig.logo_url);
    });
  });
});

/**
 * Registro de ventas para el SIRE (RVIE): lo que entra, en negativo las notas de crédito, los anulados en cero,
 * el nombre oficial del archivo y los casos de borde (mes sin ventas, cliente sin documento).
 */
describe('ReportesBussnies · registro de ventas (SIRE / RVIE)', () => {
  const fila = (id: number, datos: Record<string, unknown> = {}) => ({
    id_comprobante: id,
    id_tipo: 1,
    serie: 'F001',
    numero: id,
    fecha_de_emision: '2026-10-05',
    fecha_de_vencimiento: '2026-10-05',
    creado_en: new Date('2026-10-05T15:00:00Z'),
    cliente_tipo_doc: 6,
    cliente_numero_doc: '20100066603',
    cliente_denominacion: 'FERRETERIA EL SOL S.A.C.',
    total_gravada: '100.00',
    total_exonerada: '0.00',
    total_inafecta: '0.00',
    total_igv: '18.00',
    total: '118.00',
    id_moneda: 1,
    anulado: false,
    estado: 'emitido',
    estado_sunat: 'ACEPTADO',
    aceptada_sunat: true,
    ambiente_fiscal: 'produccion',
    doc_modificado_tipo: null,
    doc_modificado_serie: null,
    doc_modificado_numero: null,
    fecha_doc_modificado: null,
    ...datos,
  });
  const montar = (lista: any[]) => {
    const repo = { obtenerComprobantesRvie: jest.fn().mockResolvedValue(lista) };
    return { servicio: new ReportesBussnies(repo as any), repo };
  };
  const columnas = (linea: string) => linea.split('|');
  const lineas = (txt: string) => txt.split('\r\n').filter(Boolean);

  beforeEach(() => jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] }).setSystemTime(new Date('2026-11-08T15:00:00Z')));
  afterEach(() => jest.useRealTimers());

  it('estructura: 34 columnas separadas por «|», periodo, fechas dd/mm/aaaa, tipo 01, importes con dos decimales', async () => {
    const { servicio, repo } = montar([fila(12)]);
    const r = await servicio.registroVentasRvie('202610');

    expect(repo.obtenerComprobantesRvie).toHaveBeenCalledWith('202610');
    const [linea] = lineas(r.contenido);
    const c = columnas(linea);
    expect(c).toHaveLength(34);
    expect(c.slice(0, 13)).toEqual([emisorConfig.ruc, emisorConfig.razon_social, '202610', '', '05/10/2026', '05/10/2026', '01', 'F001', '12', '', '6', '20100066603', 'FERRETERIA EL SOL S.A.C.']);
    expect(c.slice(13, 27)).toEqual(['0.00', '100.00', '0.00', '18.00', '0.00', '0.00', '0.00', '0.00', '0.00', '0.00', '0.00', '0.00', '118.00', 'PEN']);
    expect(r.contenido.endsWith('\r\n')).toBe(true);
    expect(r.contenido.charCodeAt(0)).not.toBe(0xfeff);
    expect(r.resumen).toMatchObject({ periodo: '202610', filas: 1, por_tipo: { factura: 1, boleta: 0, nota_credito: 0, nota_debito: 0 } });
    expect(r.resumen.aviso).toContain('PLE 14.1');
  });

  it('la nota de crédito va en negativo y lleva el documento que modifica; la nota de débito en positivo', async () => {
    const { servicio } = montar([
      fila(12),
      fila(3, {
        id_tipo: 7, serie: 'FC01', total_gravada: '50.00', total_igv: '9.00', total: '59.00',
        doc_modificado_tipo: '01', doc_modificado_serie: 'F001', doc_modificado_numero: 12, fecha_doc_modificado: '2026-10-05',
      }),
      fila(4, { id_tipo: 8, serie: 'FD01', total_gravada: '10.00', total_igv: '1.80', total: '11.80' }),
    ]);
    const [, nc, nd] = lineas((await servicio.registroVentasRvie('202610')).contenido).map(columnas);

    expect(nc[6]).toBe('07');
    expect(nc.slice(14, 17)).toEqual(['-50.00', '0.00', '-9.00']);
    expect(nc[25]).toBe('-59.00');
    expect(nc.slice(28, 32)).toEqual(['05/10/2026', '01', 'F001', '12']);
    expect(nd[6]).toBe('08');
    expect(nd[25]).toBe('11.80');
    expect(nd.slice(28, 32)).toEqual(['', '', '', '']);
  });

  it('el comprobante dado de baja en SUNAT sale en cero y «ANULADO»; el anulado solo en el sistema, las pruebas, errores, rechazados y pendientes quedan fuera', async () => {
    const { servicio } = montar([
      fila(1),
      fila(2, { estado_sunat: 'ANULADO', anulado: true }),
      fila(3, { anulado: true, aceptada_sunat: false, estado_sunat: 'NO_ENVIADO' }),
      fila(4, { ambiente_fiscal: 'beta' }),
      fila(5, { estado: 'error', aceptada_sunat: false, estado_sunat: 'EXCEPCION' }),
      fila(6, { estado_sunat: 'RECHAZADO', aceptada_sunat: false }),
      fila(7, { estado_sunat: 'PENDIENTE_REENVIO', aceptada_sunat: false }),
      fila(8, { anulado: true }), // anulada con nota de crédito: sigue aceptada en SUNAT
    ]);
    const r = await servicio.registroVentasRvie('202610');
    const filas = lineas(r.contenido).map(columnas);

    expect(filas.map((c) => c[8])).toEqual(['1', '2', '8']);
    const anulado = filas[1];
    expect(anulado[10]).toBe('0');
    expect(anulado[11]).toBe('0');
    expect(anulado[12]).toBe('ANULADO');
    expect(anulado.slice(13, 26)).toEqual(Array(13).fill('0.00'));
    expect(filas[2][25]).toBe('118.00');
    expect(r.resumen).toMatchObject({
      filas: 3,
      anulados: 1,
      omitidos: { pruebas: 1, con_error: 1, rechazados: 1, sin_aceptar: 1, anulados_sin_sunat: 1 },
    });
  });

  it('nombre oficial del archivo: LE + RUC + AAAAMM + 00 + 140400 + 02 + O I M G, y con el mes vacío I = 0 y contenido vacío', async () => {
    const con = await montar([fila(1)]).servicio.registroVentasRvie('202610');
    expect(con.nombre).toBe(`LE${emisorConfig.ruc}20261000140400021112.txt`);
    expect(con.tipo).toBe('text/plain; charset=utf-8');

    const sin = await montar([]).servicio.registroVentasRvie('202609');
    expect(sin.nombre).toBe(`LE${emisorConfig.ruc}20260900140400021012.txt`);
    expect(sin.contenido).toBe('');
    expect(sin.resumen).toMatchObject({ filas: 0, anulados: 0 });
  });

  it('un cliente sin documento (boleta sin DNI) sale con tipo 0 y «-»; el «|» y los saltos del nombre no rompen la línea', async () => {
    const { servicio } = montar([
      fila(9, { id_tipo: 2, serie: 'B001', cliente_tipo_doc: null, cliente_numero_doc: '', cliente_denominacion: 'CLIENTES VARIOS' }),
      fila(10, { id_tipo: 2, serie: 'B001', cliente_denominacion: 'PEREZ | SOLIS\n  HNOS', cliente_tipo_doc: 1, cliente_numero_doc: '45612378' }),
    ]);
    const [sinDoc, conBarra] = lineas((await servicio.registroVentasRvie('202610')).contenido).map(columnas);

    expect(sinDoc).toHaveLength(34);
    expect(sinDoc.slice(10, 13)).toEqual(['0', '-', 'CLIENTES VARIOS']);
    expect(sinDoc[6]).toBe('03');
    expect(conBarra).toHaveLength(34);
    expect(conBarra.slice(10, 13)).toEqual(['1', '45612378', 'PEREZ SOLIS HNOS']);
  });

  it('solo cuenta lo emitido en ese mes (también las fechas DD-MM-AAAA de Nubefact) y avisa de los dólares', async () => {
    const { servicio } = montar([
      fila(1, { fecha_de_emision: '2026-09-30' }),
      fila(2, { fecha_de_emision: '15-10-2026', estado_sunat: null, ambiente_fiscal: null, aceptada_sunat: true }),
      fila(3, { id_moneda: 2, total: '50.00', total_gravada: '42.37', total_igv: '7.63' }),
      fila(4, { fecha_de_emision: 'basura', creado_en: new Date('2026-11-01T02:00:00Z') }), // 31/10 21:00 en Lima
    ]);
    const r = await servicio.registroVentasRvie('202610');
    const filas = lineas(r.contenido).map(columnas);

    // En orden de fecha: el 3 (5/10), el 2 (15/10) y el 4 (31/10).
    expect(filas.map((c) => c[8])).toEqual(['3', '2', '4']);
    expect(filas[0][26]).toBe('USD');
    expect(filas[0][27]).toBe('');
    expect(filas[1][4]).toBe('15/10/2026');
    expect(filas[2][4]).toBe('31/10/2026');
    expect(r.resumen.en_dolares).toBe(1);
  });

  it('el CSV lleva cabeceras, la columna Estado, BOM y comillas donde hace falta', async () => {
    const { servicio } = montar([
      fila(1, { cliente_denominacion: 'SOLIS, HNOS "EL SOL"' }),
      fila(2, { estado_sunat: 'ANULADO', anulado: true }),
    ]);
    const r = await servicio.registroVentasRvieCsv('202610');
    const [cabecera, a, b] = r.contenido.replace('﻿', '').split('\r\n');

    expect(r.contenido.charCodeAt(0)).toBe(0xfeff);
    expect(r.nombre).toBe(`registro-ventas-sire-${emisorConfig.ruc}-202610.csv`);
    expect(r.tipo).toBe('text/csv; charset=utf-8');
    expect(cabecera.split(',')).toHaveLength(35);
    expect(cabecera).toContain('Base imponible gravada');
    expect(cabecera.endsWith(',Estado')).toBe(true);
    expect(a).toContain('"SOLIS, HNOS ""EL SOL"""');
    expect(a.endsWith(',Aceptado')).toBe(true);
    expect(b.endsWith(',Anulado')).toBe(true);
  });

  it('rechaza un periodo mal escrito o futuro (400) y avisa claro si la consulta falla (503)', async () => {
    const { servicio, repo } = montar([]);
    for (const malo of ['', '2026', '2026-10', '202613', '201912', 'octubre']) {
      await expect(servicio.registroVentasRvie(malo)).rejects.toBeInstanceOf(BadRequestException);
    }
    await expect(servicio.registroVentasRvie('202612')).rejects.toBeInstanceOf(BadRequestException);
    expect(repo.obtenerComprobantesRvie).not.toHaveBeenCalled();

    repo.obtenerComprobantesRvie.mockRejectedValueOnce(new Error('column "doc_modificado_tipo" does not exist'));
    await expect(servicio.registroVentasRvie('202610')).rejects.toMatchObject({ status: 503 });
  });
});

// ── Fase F: rentabilidad, estancados, mapa de calor ─────────────────────────

function armarF(lista: any[] = [], extra: Record<string, jest.Mock> = {}) {
  const repo = {
    obtenerVentasPorPeriodo: jest.fn().mockResolvedValue(lista),
    obtenerRentabilidadProductos: jest.fn().mockResolvedValue([]),
    obtenerProductosEstancados: jest.fn().mockResolvedValue([]),
    ...extra,
  };
  return { servicio: new ReportesBussnies(repo as any), repo };
}

function filaRent(datos: Record<string, unknown> = {}) {
  return {
    id_producto: 1,
    codigo: 'MARTILLO-1',
    producto: 'Martillo',
    categoria: 'Herramientas',
    cantidad: '10',
    ingreso: '236.00',
    costo: '150.00',
    ultima_venta: new Date('2026-11-04T15:00:00Z'),
    sin_costo: false,
    ...datos,
  };
}

describe('ReportesBussnies · rentabilidad por producto (F1)', () => {
  beforeEach(() => jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] }));
  afterEach(() => jest.useRealTimers());

  it('calcula margen en soles y en porcentaje y pide solo los comprobantes que cuentan', async () => {
    jest.setSystemTime(new Date('2026-11-08T15:00:00Z'));
    const lista = [
      comprobante(1, { total: '100.00' }),
      comprobante(2, { total: '50.00', anulado: true }),
      comprobante(3, { total: '20.00', estado_sunat: 'RECHAZADO' }),
      comprobante(4, { total: '30.00', ambiente_fiscal: 'beta' }),
      comprobante(5, { total: '40.00', tipo: { id_tipo: 7 } }),
    ];
    const { servicio, repo } = armarF(lista, { obtenerRentabilidadProductos: jest.fn().mockResolvedValue([filaRent()]) });

    const r = await servicio.rentabilidadProductos({ fecha_inicio: '2026-11-01', fecha_fin: '2026-11-08' });

    expect(repo.obtenerRentabilidadProductos).toHaveBeenCalledWith([1, 5], 501);
    expect(r.fecha_inicio).toBe('2026-11-01');
    expect(r.fecha_fin).toBe('2026-11-08');
    expect(r.productos[0]).toMatchObject({
      producto: 'Martillo',
      cantidad: 10,
      ingreso: 236,
      costo: 150,
      margen: 86,
      margen_pct: 36.44,
      ultima_venta: '2026-11-04',
      sin_costo: false,
    });
    expect(r.nota_costo).toContain('precio de compra actual');
  });

  it('el margen se calcula sobre la venta sin IGV: gravada pura', async () => {
    jest.setSystemTime(new Date('2026-11-08T15:00:00Z'));
    const fila = filaRent({ cantidad: '2', ingreso: '118.00', ingreso_sin_igv: '100.00', costo: '60.00' });
    const { servicio } = armarF([comprobante(1)], { obtenerRentabilidadProductos: jest.fn().mockResolvedValue([fila]) });

    const r = await servicio.rentabilidadProductos({ fecha_inicio: '2026-11-01', fecha_fin: '2026-11-08' });

    expect(r.productos[0]).toMatchObject({ ingreso: 118, ingreso_sin_igv: 100, costo: 60, margen: 40, margen_pct: 40 });
    expect(r.totales).toMatchObject({ ingreso: 118, ingreso_sin_igv: 100, margen: 40, margen_pct: 40 });
    expect(r.nota_costo).toContain('venta sin IGV − costo');
  });

  it('con gravadas y exoneradas mezcladas el margen y los totales por categoría usan la base sin IGV', async () => {
    jest.setSystemTime(new Date('2026-11-08T15:00:00Z'));
    // Comprobante de 218 (118 gravado + 100 exonerado, IGV 18): la base es 200/218 de cada ítem.
    const filas = [
      filaRent({ id_producto: 1, producto: 'Gravado', ingreso: '118.00', ingreso_sin_igv: '108.26', costo: '70.00' }),
      filaRent({ id_producto: 2, producto: 'Exonerado', ingreso: '100.00', ingreso_sin_igv: '91.74', costo: '50.00' }),
    ];
    const { servicio } = armarF([comprobante(1)], { obtenerRentabilidadProductos: jest.fn().mockResolvedValue(filas) });

    const r = await servicio.rentabilidadProductos({ fecha_inicio: '2026-11-01', fecha_fin: '2026-11-08' });

    expect(r.productos.map((p) => [p.margen, p.margen_pct])).toEqual([[38.26, 35.34], [41.74, 45.5]]);
    expect(r.categorias[0]).toMatchObject({ ingreso: 218, ingreso_sin_igv: 200, costo: 120, margen: 80, margen_pct: 40 });
    expect(r.totales).toMatchObject({ ingreso: 218, ingreso_sin_igv: 200, margen: 80, margen_pct: 40 });
  });

  it('sin fechas usa el mes en curso de Lima', async () => {
    jest.setSystemTime(new Date('2026-11-09T03:00:00Z')); // 8/11 22:00 en Lima
    const { servicio, repo } = armarF([]);

    const r = await servicio.rentabilidadProductos({});

    const [desde, hasta] = repo.obtenerVentasPorPeriodo.mock.calls[0];
    expect(desde.toISOString()).toBe('2026-11-01T05:00:00.000Z');
    expect(hasta.toISOString()).toBe('2026-11-09T05:00:00.000Z');
    expect(r.productos).toEqual([]);
    expect(r.totales.margen_pct).toBeNull();
  });

  it('suma los productos por categoría y deja la categoría de mayor ingreso primero', async () => {
    jest.setSystemTime(new Date('2026-11-08T15:00:00Z'));
    const filas = [
      filaRent({ id_producto: 1, producto: 'Martillo', ingreso: '100.00', costo: '60.00', cantidad: '4' }),
      filaRent({ id_producto: 2, producto: 'Pintura', categoria: 'Pinturas', ingreso: '500.00', costo: '350.00', cantidad: '5' }),
      filaRent({ id_producto: 3, producto: 'Clavos', ingreso: '20.00', costo: '10.00', cantidad: '2' }),
    ];
    const { servicio } = armarF([comprobante(1)], { obtenerRentabilidadProductos: jest.fn().mockResolvedValue(filas) });

    const r = await servicio.rentabilidadProductos({ fecha_inicio: '2026-11-01', fecha_fin: '2026-11-08' });

    expect(r.categorias.map((c) => c.categoria)).toEqual(['Pinturas', 'Herramientas']);
    expect(r.categorias[1]).toMatchObject({ productos: 2, cantidad: 6, ingreso: 120, costo: 70, margen: 50, margen_pct: 41.67 });
    expect(r.totales).toMatchObject({ productos: 3, cantidad: 11, ingreso: 620, costo: 420, margen: 200, margen_pct: 32.26 });
  });

  it('avisa los productos sin precio de compra y un margen negativo se conserva', async () => {
    jest.setSystemTime(new Date('2026-11-08T15:00:00Z'));
    const filas = [
      filaRent({ producto: 'Sin costo', ingreso: '80.00', costo: '0.00', sin_costo: true }),
      filaRent({ id_producto: 2, producto: 'A pérdida', ingreso: '50.00', costo: '70.00', ultima_venta: null }),
    ];
    const { servicio } = armarF([comprobante(1)], { obtenerRentabilidadProductos: jest.fn().mockResolvedValue(filas) });

    const r = await servicio.rentabilidadProductos({ fecha_inicio: '2026-11-01', fecha_fin: '2026-11-08' });

    expect(r.productos[0].sin_costo).toBe(true);
    expect(r.productos[1]).toMatchObject({ margen: -20, margen_pct: -40, ultima_venta: null });
  });

  it('con más de 500 productos devuelve 500 y lo avisa', async () => {
    jest.setSystemTime(new Date('2026-11-08T15:00:00Z'));
    const filas = Array.from({ length: 501 }, (_, i) => filaRent({ id_producto: i + 1, producto: `P${i}`, ingreso: '10.00', costo: '5.00' }));
    const { servicio } = armarF([comprobante(1)], { obtenerRentabilidadProductos: jest.fn().mockResolvedValue(filas) });

    const r = await servicio.rentabilidadProductos({ fecha_inicio: '2026-11-01', fecha_fin: '2026-11-08' });

    expect(r.productos).toHaveLength(500);
    expect(r.recortado).toBe(true);
  });
});

describe('ReportesBussnies · stock estancado (F1)', () => {
  beforeEach(() => jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] }));
  afterEach(() => jest.useRealTimers());

  it('acepta 30, 60 o 90 días (otro valor va al más cercano) y calcula el corte desde ahora', async () => {
    jest.setSystemTime(new Date('2026-11-08T15:00:00Z'));
    const { servicio, repo } = armarF();

    expect((await servicio.productosEstancados('60')).dias).toBe(60);
    expect((await servicio.productosEstancados(95)).dias).toBe(90);
    expect((await servicio.productosEstancados(undefined)).dias).toBe(30);
    expect((await servicio.productosEstancados('xx')).dias).toBe(30);

    const [corte, limite] = repo.obtenerProductosEstancados.mock.calls[0];
    expect(corte.toISOString()).toBe('2026-09-09T15:00:00.000Z');
    expect(limite).toBe(200);
  });

  it('valoriza el stock, cuenta los días sin venta en días de Lima y deja null lo que nunca se vendió', async () => {
    jest.setSystemTime(new Date('2026-11-08T15:00:00Z'));
    const filas = [
      { id_producto: 1, codigo: 'A1', producto: 'Taladro', categoria: 'Herramientas', stock: '4', precio_compra: '125.50', ultima_venta: new Date('2026-09-01T02:00:00Z'), total_filas: '2' },
      { id_producto: 2, codigo: '', producto: 'Cinta', categoria: null, stock: '10', precio_compra: '3.00', ultima_venta: null, total_filas: '2' },
    ];
    const { servicio } = armarF([], { obtenerProductosEstancados: jest.fn().mockResolvedValue(filas) });

    const r = await servicio.productosEstancados(30);

    expect(r.productos[0]).toMatchObject({ valorizado: 502, ultima_venta: '2026-08-31', dias_sin_venta: 69 });
    expect(r.productos[1]).toMatchObject({ valorizado: 30, ultima_venta: null, dias_sin_venta: null, categoria: 'Sin categoría' });
    expect(r.valorizado_total).toBe(532);
    expect(r.total_productos).toBe(2);
    expect(r.recortado).toBe(false);
  });

  it('avisa cuando hay más productos de los que se devuelven', async () => {
    jest.setSystemTime(new Date('2026-11-08T15:00:00Z'));
    const fila = { id_producto: 1, codigo: 'A', producto: 'X', categoria: 'C', stock: '1', precio_compra: '1', ultima_venta: null, total_filas: '350' };
    const { servicio } = armarF([], { obtenerProductosEstancados: jest.fn().mockResolvedValue([fila]) });

    const r = await servicio.productosEstancados(90);

    expect(r.total_productos).toBe(350);
    expect(r.recortado).toBe(true);
  });
});

describe('ReportesBussnies · mapa de calor hora × día (F2)', () => {
  beforeEach(() => jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] }));
  afterEach(() => jest.useRealTimers());

  // Hoy es domingo 8/11/2026 en Lima. El jueves 5/11 a las 16:30 de Lima son las 21:30 UTC.
  const jueves = (hora: string, datos: Record<string, unknown> = {}, id = 1) =>
    comprobante(id, { creado_en: new Date(`2026-11-05T${hora}Z`), total: '100.00', ...datos });

  it('devuelve siempre 168 celdas, pide las últimas 4 semanas y usa el día y la hora de Lima', async () => {
    jest.setSystemTime(new Date('2026-11-08T15:00:00Z'));
    const lista = [
      jueves('21:30:00'), // jueves 16:30 Lima
      jueves('02:00:00', {}, 2), // 4/11 21:00 Lima = miércoles (en UTC ya es jueves)
      comprobante(3, { creado_en: new Date('2026-11-09T02:00:00Z'), total: '40.00' }), // domingo 8/11 21:00 Lima
    ];
    const { servicio, repo } = armarF(lista);

    const r = await servicio.ventasMapaCalor();

    const [desde, hasta] = repo.obtenerVentasPorPeriodo.mock.calls[0];
    expect(desde.toISOString()).toBe('2026-10-12T05:00:00.000Z');
    expect(hasta.toISOString()).toBe('2026-11-09T05:00:00.000Z');
    expect(r).toMatchObject({ desde: '2026-10-12', hasta: '2026-11-08', semanas: 4 });
    expect(r.celdas).toHaveLength(168);
    const celda = (dia: number, hora: number) => r.celdas.find((c) => c.dia === dia && c.hora === hora)!;
    expect(celda(4, 16)).toMatchObject({ total: 100, ventas: 1 });
    expect(celda(3, 21)).toMatchObject({ total: 100, ventas: 1 });
    expect(celda(0, 21)).toMatchObject({ total: 40, ventas: 1 });
    expect(celda(4, 17)).toMatchObject({ total: 0, ventas: 0 });
  });

  it('usa el mismo criterio de ventas netas: la nota de crédito resta y anulados, rechazados y pruebas no cuentan', async () => {
    jest.setSystemTime(new Date('2026-11-08T15:00:00Z'));
    const lista = [
      jueves('21:30:00'),
      jueves('21:40:00', { tipo: { id_tipo: 7 }, total: '30.00' }, 2),
      jueves('21:45:00', { anulado: true }, 3),
      jueves('21:50:00', { estado_sunat: 'RECHAZADO' }, 4),
      jueves('21:55:00', { ambiente_fiscal: 'beta' }, 5),
    ];
    const { servicio } = armarF(lista);

    const r = await servicio.ventasMapaCalor(4);

    expect(r.celdas.find((c) => c.dia === 4 && c.hora === 16)).toMatchObject({ total: 70, ventas: 1 });
  });

  it('la mejor franja son dos horas seguidas con más ventas; sin ventas no hay franja', async () => {
    jest.setSystemTime(new Date('2026-11-08T15:00:00Z'));
    const lista = [
      jueves('21:30:00', { total: '100.00' }), // jueves 16
      jueves('22:30:00', { total: '80.00' }, 2), // jueves 17
      jueves('15:00:00', { total: '150.00' }, 3), // jueves 10
    ];
    const { servicio } = armarF(lista);

    const r = await servicio.ventasMapaCalor(4);
    expect(r.mejor).toEqual({ dia: 4, hora_inicio: 16, hora_fin: 18, total: 180 });

    const vacio = await armarF([]).servicio.ventasMapaCalor(4);
    expect(vacio.mejor).toBeNull();
  });

  it('limita las semanas entre 1 y 12 y usa 4 si el valor no sirve', async () => {
    jest.setSystemTime(new Date('2026-11-08T15:00:00Z'));
    const { servicio } = armarF([]);

    expect((await servicio.ventasMapaCalor('0')).semanas).toBe(4);
    expect((await servicio.ventasMapaCalor('abc')).semanas).toBe(4);
    expect((await servicio.ventasMapaCalor('99')).semanas).toBe(12);
    const una = await servicio.ventasMapaCalor('1');
    expect(una).toMatchObject({ semanas: 1, desde: '2026-11-02', hasta: '2026-11-08' });
  });

  it('resumenDia da ventas netas, cantidad de facturas y boletas y ticket promedio', async () => {
    jest.setSystemTime(new Date('2026-11-08T15:00:00Z'));
    const hoy = (id: number, datos: Record<string, unknown>) => comprobante(id, { creado_en: new Date('2026-11-08T14:00:00Z'), ...datos });
    const { servicio } = armarF([hoy(1, { total: '100.00' }), hoy(2, { total: '50.00' }), hoy(3, { total: '30.00', tipo: { id_tipo: 7 } })]);

    const r = await servicio.resumenDia('2026-11-08');

    expect(r).toEqual({ fecha: '2026-11-08', total: 120, ventas: 2, ticket_promedio: 60 });
  });
});

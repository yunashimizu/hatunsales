import * as ExcelJS from 'exceljs';
import { argb, PALETA } from './proforma-documento';
import {
  capitalizarEstado,
  DatosReporteVentas,
  etiquetaPeriodo,
  etiquetaTipoReporte,
  idTipoDeDetalle,
} from '../reporte-export';

/**
 * Reporte de ventas en Excel (.xlsx): un libro con varias hojas (Resumen, Detalle, Tendencia,
 * productos vendidos y cotizados, Clientes) con la misma imagen de marca que la proforma y el PDF.
 *
 * Criterios de diseño: tablas limpias que se pueden filtrar y ordenar (cabecera inmovilizada y
 * autofiltro), fechas y montos como valores reales (no texto) con su formato, negativos en rojo,
 * totales con fórmula SUBTOTAL (siguen bien si se filtra) y configuración de impresión en A4.
 * Sin elementos que Excel pueda marcar como contenido a reparar (nada de gráficos ni de barras
 * de datos).
 */

const ARGB = {
  marca: argb(PALETA.grafito),
  acento: argb(PALETA.naranja),
  acentoSuave: argb(PALETA.naranjaSuave),
  texto: argb(PALETA.texto),
  gris: argb(PALETA.gris),
  grisClaro: argb(PALETA.grisClaro),
  linea: argb(PALETA.linea),
  fondo: argb(PALETA.fondo),
  cebra: argb(PALETA.cebra),
  blanco: argb(PALETA.blanco),
  peligro: argb(PALETA.peligro),
};

const FUENTE = 'Calibri';
const FORMATO_MONEDA = '"S/ "#,##0.00;[Red]-"S/ "#,##0.00';
const FORMATO_ENTERO = '#,##0';
const FORMATO_CANTIDAD = '#,##0.##';
const FORMATO_PORCENTAJE = '0.0%';
const FORMATO_FECHA = 'dd/mm/yyyy';

const bordeFino: Partial<ExcelJS.Border> = { style: 'thin', color: { argb: ARGB.linea } };
const bordes: Partial<ExcelJS.Borders> = { top: bordeFino, left: bordeFino, bottom: bordeFino, right: bordeFino };

/** Fila de la cabecera de cada tabla: arriba van el nombre de la empresa, el título y la fecha. */
const FILA_CABECERA = 5;

type Valor = string | number | Date | null;

interface ColumnaHoja {
  titulo: string;
  ancho: number;
  alinear?: 'left' | 'right' | 'center';
  formato?: string;
}

interface TotalHoja {
  etiqueta: string;
  /** Columna (1 = A) cuya suma se muestra. */
  columna: number;
  valor: number;
  formato: string;
}

interface OpcionesHoja {
  nombre: string;
  titulo: string;
  columnas: ColumnaHoja[];
  filas: Valor[][];
  vacio: string;
  total?: TotalHoja;
  orientacion?: 'landscape' | 'portrait';
}

function relleno(color: string): ExcelJS.Fill {
  return { type: 'pattern', pattern: 'solid', fgColor: { argb: color } };
}

/** 'AAAA-MM-DD' → fecha de Excel (a medianoche UTC, así no se corre un día); si no es fecha, el texto tal cual. */
function aFecha(ymd: string | undefined): Date | string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd ?? ''));
  return m ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))) : String(ymd || '—');
}

function pct(parte: number, todo: number): number | null {
  return todo > 0 ? parte / todo : null;
}

/** Encabezado común: empresa y RUC, título de la hoja con los filtros y cuándo se generó. */
function bloqueTitulo(ws: ExcelJS.Worksheet, datos: DatosReporteVentas, titulo: string, ultimaColumna: number): void {
  const { cabecera } = datos;
  const combinar = (fila: number) => ws.mergeCells(fila, 1, fila, Math.max(ultimaColumna, 2));

  combinar(1);
  const empresa = ws.getCell(1, 1);
  empresa.value = `${cabecera.empresa}  ·  RUC ${cabecera.ruc}`;
  empresa.font = { name: FUENTE, size: 13, bold: true, color: { argb: ARGB.marca } };
  empresa.alignment = { vertical: 'middle' };
  ws.getRow(1).height = 24;

  // Las hojas estrechas (Tendencia, Clientes) no alcanzan para estos textos en una línea: se ajustan en varias.
  let anchoTotal = 0;
  for (let c = 1; c <= Math.max(ultimaColumna, 2); c++) anchoTotal += ws.getColumn(c).width ?? 10;
  const lineas = (texto: string, caracteresPorUnidad: number) =>
    Math.max(1, Math.ceil((texto.length * caracteresPorUnidad) / anchoTotal));

  combinar(2);
  const filtros = (cabecera.filtros ?? []).map((f) => `${f.etiqueta}: ${f.valor}`).join('  ·  ');
  const subtitulo = ws.getCell(2, 1);
  subtitulo.value = filtros ? `${titulo}  —  ${filtros}` : titulo;
  subtitulo.font = { name: FUENTE, size: 11, bold: true, color: { argb: ARGB.acento } };
  subtitulo.alignment = { vertical: 'middle', wrapText: true };
  ws.getRow(2).height = Math.max(20, lineas(String(subtitulo.value), 1.15) * 15 + 5);

  combinar(3);
  const generado = ws.getCell(3, 1);
  generado.value = `Generado el ${cabecera.generadoEl} (hora de Lima)${cabecera.direccion ? `  ·  ${cabecera.direccion}` : ''}`;
  generado.font = { name: FUENTE, size: 8, italic: true, color: { argb: ARGB.grisClaro } };
  generado.alignment = { vertical: 'top', wrapText: true };
  ws.getRow(3).height = Math.max(14, lineas(String(generado.value), 0.85) * 11 + 3);

  ws.getRow(4).height = 6;
}

function cabeceraTabla(ws: ExcelJS.Worksheet, fila: number, columnas: ColumnaHoja[]): void {
  const row = ws.getRow(fila);
  columnas.forEach((col, i) => {
    const celda = row.getCell(i + 1);
    celda.value = col.titulo;
    celda.font = { name: FUENTE, size: 10, bold: true, color: { argb: ARGB.blanco } };
    celda.fill = relleno(ARGB.marca);
    celda.border = bordes;
    celda.alignment = { vertical: 'middle', horizontal: col.alinear ?? 'left', wrapText: true };
  });
  row.height = 22;
}

function configurarImpresion(ws: ExcelJS.Worksheet, datos: DatosReporteVentas, orientacion: 'landscape' | 'portrait'): void {
  ws.pageSetup = {
    paperSize: 9, // A4
    orientation: orientacion,
    fitToPage: true,
    fitToWidth: 1,
    fitToHeight: 0,
    horizontalCentered: true,
    margins: { left: 0.4, right: 0.4, top: 0.6, bottom: 0.6, header: 0.3, footer: 0.3 },
    printTitlesRow: `${FILA_CABECERA}:${FILA_CABECERA}`,
  };
  ws.headerFooter = {
    oddFooter: `&L&8${datos.cabecera.empresa} · Reporte de ventas&C&8Página &P de &N&R&8&D`,
  };
}

/** Hoja tabular estándar: título, cabecera inmovilizada con autofiltro, cebra, formatos y total opcional. */
function agregarHoja(wb: ExcelJS.Workbook, datos: DatosReporteVentas, op: OpcionesHoja): ExcelJS.Worksheet {
  const ws = wb.addWorksheet(op.nombre, {
    properties: { defaultRowHeight: 18, tabColor: { argb: ARGB.acento } },
    views: [{ state: 'frozen', ySplit: FILA_CABECERA, showGridLines: false }],
  });
  op.columnas.forEach((col, i) => {
    ws.getColumn(i + 1).width = col.ancho;
  });
  bloqueTitulo(ws, datos, op.titulo, op.columnas.length);
  cabeceraTabla(ws, FILA_CABECERA, op.columnas);

  let fila = FILA_CABECERA;
  if (!op.filas.length) {
    fila += 1;
    ws.mergeCells(fila, 1, fila, op.columnas.length);
    const vacio = ws.getCell(fila, 1);
    vacio.value = op.vacio;
    vacio.font = { name: FUENTE, size: 10, italic: true, color: { argb: ARGB.gris } };
    vacio.alignment = { vertical: 'middle', indent: 1 };
    ws.getRow(fila).height = 26;
  } else {
    op.filas.forEach((valores, idx) => {
      fila += 1;
      const row = ws.getRow(fila);
      valores.forEach((valor, i) => {
        const col = op.columnas[i];
        const celda = row.getCell(i + 1);
        celda.value = valor;
        celda.font = { name: FUENTE, size: 10, color: { argb: ARGB.texto } };
        celda.border = bordes;
        celda.alignment = { vertical: 'middle', horizontal: col.alinear ?? 'left' };
        if (col.formato) celda.numFmt = col.formato;
        if (idx % 2 === 1) celda.fill = relleno(ARGB.cebra);
      });
    });

    ws.autoFilter = {
      from: { row: FILA_CABECERA, column: 1 },
      to: { row: FILA_CABECERA, column: op.columnas.length },
    };

    if (op.total) {
      fila += 1;
      const primera = FILA_CABECERA + 1;
      const letra = ws.getColumn(op.total.columna).letter;
      const row = ws.getRow(fila);
      for (let c = 1; c <= op.columnas.length; c++) {
        const celda = row.getCell(c);
        celda.fill = relleno(ARGB.acentoSuave);
        celda.border = { top: { style: 'medium', color: { argb: ARGB.marca } }, bottom: bordeFino };
        celda.font = { name: FUENTE, size: 10, bold: true, color: { argb: ARGB.marca } };
      }
      row.getCell(1).value = op.total.etiqueta;
      row.getCell(1).alignment = { vertical: 'middle', indent: 1 };
      const suma = row.getCell(op.total.columna);
      suma.value = { formula: `SUBTOTAL(109,${letra}${primera}:${letra}${fila - 1})`, result: op.total.valor };
      suma.numFmt = op.total.formato;
      suma.alignment = { vertical: 'middle', horizontal: 'right' };
      row.height = 22;
    }
  }

  configurarImpresion(ws, datos, op.orientacion ?? 'landscape');
  return ws;
}

/** Resumen: indicadores del periodo, reparto por tipo de comprobante y la nota de cómo se calcula. */
function agregarResumen(wb: ExcelJS.Workbook, datos: DatosReporteVentas): void {
  const { reporte, cabecera } = datos;
  const stats = reporte.estadisticas;
  const columnas: ColumnaHoja[] = [
    { titulo: 'Indicador', ancho: 34 },
    { titulo: 'Valor', ancho: 22, alinear: 'right' },
    { titulo: 'Detalle', ancho: 64 },
  ];
  const ws = wb.addWorksheet('Resumen', {
    properties: { defaultRowHeight: 18, tabColor: { argb: ARGB.marca } },
    views: [{ state: 'frozen', ySplit: FILA_CABECERA, showGridLines: false }],
  });
  columnas.forEach((col, i) => {
    ws.getColumn(i + 1).width = col.ancho;
  });
  bloqueTitulo(ws, datos, 'Resumen del periodo', columnas.length);
  cabeceraTabla(ws, FILA_CABECERA, columnas);

  const indicadores: Array<[string, number, string, string]> = [
    ['Total vendido', reporte.total_vendido, FORMATO_MONEDA, 'Ventas netas: facturas y boletas + notas de débito − notas de crédito'],
    ['Ventas brutas', reporte.total_bruto, FORMATO_MONEDA, 'Antes de restar las notas de crédito'],
    [
      'Notas de crédito',
      reporte.notas_credito.total ? -reporte.notas_credito.total : 0,
      FORMATO_MONEDA,
      `${reporte.notas_credito.cantidad} documento${reporte.notas_credito.cantidad === 1 ? '' : 's'} que restan`,
    ],
    [
      'Notas de débito',
      reporte.notas_debito.total,
      FORMATO_MONEDA,
      `${reporte.notas_debito.cantidad} documento${reporte.notas_debito.cantidad === 1 ? '' : 's'} que suman`,
    ],
    ['Comprobantes', reporte.cantidad_comprobantes, FORMATO_ENTERO, 'Facturas y boletas vigentes'],
    ['Ticket promedio', reporte.ticket_promedio, FORMATO_MONEDA, 'Venta neta ÷ comprobantes de venta'],
    ['Venta máxima', stats.venta_maxima, FORMATO_MONEDA, 'Comprobante de venta más alto'],
    ['Venta mínima', stats.venta_minima, FORMATO_MONEDA, 'Comprobante de venta más bajo'],
    ['Días con venta', stats.dias_con_venta, FORMATO_ENTERO, 'Días con al menos una factura o boleta'],
    ['Emitidos', stats.emitidos, FORMATO_ENTERO, 'Documentos que cuentan (incluye notas)'],
    ['Anulados', stats.anulados, FORMATO_ENTERO, 'No suman al total'],
    [
      'Con error',
      stats.con_error,
      FORMATO_ENTERO,
      `Con error de emisión o rechazados por SUNAT (${reporte.excluidos.con_error} con error, ${reporte.excluidos.rechazados} rechazados); no suman`,
    ],
  ];

  let fila = FILA_CABECERA;
  const escribir = (a: string, b: Valor, c: string, formato?: string, idx = 0) => {
    fila += 1;
    const row = ws.getRow(fila);
    const celdas = [row.getCell(1), row.getCell(2), row.getCell(3)];
    celdas[0].value = a;
    celdas[1].value = b;
    celdas[2].value = c;
    celdas.forEach((celda, i) => {
      celda.font = {
        name: FUENTE,
        size: 10,
        bold: i === 0,
        color: { argb: i === 2 ? ARGB.gris : ARGB.texto },
      };
      celda.border = bordes;
      celda.alignment = { vertical: 'middle', horizontal: i === 1 ? 'right' : 'left', wrapText: i === 2, indent: 1 };
      if (idx % 2 === 1) celda.fill = relleno(ARGB.cebra);
    });
    if (formato) celdas[1].numFmt = formato;
  };
  indicadores.forEach(([etiqueta, valor, formato, detalle], i) => escribir(etiqueta, valor, detalle, formato, i));

  // Ventas por tipo de comprobante
  fila += 2;
  ws.mergeCells(fila, 1, fila, columnas.length);
  const seccion = ws.getCell(fila, 1);
  seccion.value = reporte.filtro_tipo
    ? `Ventas por tipo de comprobante (se filtró: ${reporte.filtro_tipo.nombre})`
    : 'Ventas por tipo de comprobante';
  seccion.font = { name: FUENTE, size: 11, bold: true, color: { argb: ARGB.marca } };
  seccion.fill = relleno(ARGB.acentoSuave);
  seccion.alignment = { vertical: 'middle', indent: 1 };
  ws.getRow(fila).height = 22;
  fila += 1;
  cabeceraTabla(ws, fila, [
    { titulo: 'Tipo de comprobante', ancho: 0 },
    { titulo: 'Importe', ancho: 0, alinear: 'right' },
    { titulo: 'Detalle', ancho: 0 },
  ]);
  if (!reporte.por_tipo.length) {
    escribir('Sin comprobantes en el periodo', null, '');
  } else {
    reporte.por_tipo.forEach((t, i) => {
      const parte = pct(t.total, reporte.total_bruto);
      const marcado = reporte.filtro_tipo?.id_tipo === t.id_tipo ? '  ◄ filtro aplicado' : '';
      escribir(
        t.tipo,
        t.total,
        `${t.cantidad} comprobante${t.cantidad === 1 ? '' : 's'}` +
          (parte === null ? '' : `  ·  ${(parte * 100).toFixed(1).replace('.', ',')} % de las ventas brutas`) +
          marcado,
        FORMATO_MONEDA,
        i,
      );
    });
  }

  // Cómo se calcula
  fila += 2;
  ws.mergeCells(fila, 1, fila, columnas.length);
  const nota = ws.getCell(fila, 1);
  nota.value = cabecera.nota ?? '';
  nota.font = { name: FUENTE, size: 9, italic: true, color: { argb: ARGB.gris } };
  nota.alignment = { vertical: 'top', wrapText: true };
  ws.getRow(fila).height = 30;

  configurarImpresion(ws, datos, 'portrait');
  ws.pageSetup.printTitlesRow = undefined;
}

export async function generarReporteVentasExcel(datos: DatosReporteVentas): Promise<Buffer> {
  const { reporte, cabecera } = datos;
  const wb = new ExcelJS.Workbook();
  wb.creator = cabecera.empresa;
  wb.lastModifiedBy = cabecera.empresa;
  wb.company = cabecera.empresa;
  wb.title = cabecera.titulo;
  wb.subject = `${cabecera.titulo} (${etiquetaPeriodo(reporte.periodo)})`;
  wb.created = new Date();
  wb.modified = new Date();

  const devueltos = reporte.productos_modo === 'devueltos';

  agregarResumen(wb, datos);

  agregarHoja(wb, datos, {
    nombre: 'Detalle',
    titulo: 'Detalle de comprobantes',
    columnas: [
      { titulo: 'N.º', ancho: 6, alinear: 'center', formato: FORMATO_ENTERO },
      { titulo: 'Fecha', ancho: 12, alinear: 'center', formato: FORMATO_FECHA },
      { titulo: 'Tipo', ancho: 17 },
      { titulo: 'Comprobante', ancho: 18 },
      { titulo: 'Cliente', ancho: 38 },
      { titulo: 'Documento', ancho: 15 },
      { titulo: 'Estado', ancho: 12 },
      { titulo: 'Total', ancho: 16, alinear: 'right', formato: FORMATO_MONEDA },
    ],
    filas: reporte.detalle.map((d, i) => [
      i + 1,
      aFecha(d.fecha),
      etiquetaTipoReporte(idTipoDeDetalle(d)),
      d.numero_formateado || `${d.serie ?? ''}-${d.numero ?? ''}`,
      d.cliente || '—',
      d.documento_cliente || '—',
      capitalizarEstado(d.estado),
      Number(d.total_vendido ?? 0),
    ]),
    vacio: 'Sin movimientos en el periodo seleccionado.',
    total: { etiqueta: 'Total neto', columna: 8, valor: reporte.total_vendido, formato: FORMATO_MONEDA },
  });

  agregarHoja(wb, datos, {
    nombre: 'Tendencia',
    titulo: 'Tendencia de ventas',
    orientacion: 'portrait',
    columnas: [
      { titulo: 'Tramo', ancho: 24 },
      { titulo: 'Comprobantes', ancho: 16, alinear: 'right', formato: FORMATO_ENTERO },
      { titulo: 'Importe', ancho: 18, alinear: 'right', formato: FORMATO_MONEDA },
    ],
    filas: (reporte.estadisticas.serie ?? []).map((p) => [p.etiqueta, p.cantidad, p.total]),
    vacio: 'Sin ventas en el periodo para graficar.',
    total: { etiqueta: 'Total del periodo', columna: 3, valor: reporte.total_vendido, formato: FORMATO_MONEDA },
  });

  agregarHoja(wb, datos, {
    nombre: devueltos ? 'Productos devueltos' : 'Productos vendidos',
    titulo: devueltos ? 'Productos con más devoluciones (notas de crédito)' : 'Productos más vendidos',
    columnas: [
      { titulo: '#', ancho: 5, alinear: 'center', formato: FORMATO_ENTERO },
      { titulo: 'Código', ancho: 16 },
      { titulo: 'Producto', ancho: 46 },
      { titulo: devueltos ? 'Cantidad devuelta' : 'Cantidad vendida', ancho: 17, alinear: 'right', formato: FORMATO_CANTIDAD },
      { titulo: 'Importe', ancho: 16, alinear: 'right', formato: FORMATO_MONEDA },
      { titulo: devueltos ? '% de lo devuelto' : '% de las ventas', ancho: 15, alinear: 'right', formato: FORMATO_PORCENTAJE },
      { titulo: 'Comprobantes', ancho: 14, alinear: 'right', formato: FORMATO_ENTERO },
    ],
    filas: reporte.top_productos_vendidos.map((p, i) => [
      i + 1,
      p.codigo || '—',
      p.producto,
      p.cantidad,
      p.total,
      devueltos ? null : pct(p.total, reporte.total_vendido),
      p.comprobantes,
    ]),
    vacio: devueltos ? 'Sin devoluciones en el periodo.' : 'Sin productos vendidos en el periodo.',
  });

  agregarHoja(wb, datos, {
    nombre: 'Productos cotizados',
    titulo: 'Productos más cotizados (cotizaciones no anuladas del periodo)',
    columnas: [
      { titulo: '#', ancho: 5, alinear: 'center', formato: FORMATO_ENTERO },
      { titulo: 'Código', ancho: 16 },
      { titulo: 'Producto', ancho: 46 },
      { titulo: 'Cotizaciones', ancho: 14, alinear: 'right', formato: FORMATO_ENTERO },
      { titulo: 'Cantidad cotizada', ancho: 17, alinear: 'right', formato: FORMATO_ENTERO },
      { titulo: 'Importe cotizado', ancho: 17, alinear: 'right', formato: FORMATO_MONEDA },
      { titulo: 'Convertidas en venta', ancho: 19, alinear: 'right', formato: FORMATO_ENTERO },
      { titulo: 'Conversión', ancho: 13, alinear: 'right', formato: FORMATO_PORCENTAJE },
    ],
    filas: reporte.top_productos_cotizados.map((p, i) => [
      i + 1,
      p.sku || '—',
      p.producto,
      p.cotizaciones,
      p.cantidad,
      p.total,
      p.convertidas,
      pct(p.convertidas, p.cotizaciones),
    ]),
    vacio: 'Sin cotizaciones en el periodo.',
  });

  agregarHoja(wb, datos, {
    nombre: 'Clientes',
    titulo: 'Clientes con mayor importe comprado',
    orientacion: 'portrait',
    columnas: [
      { titulo: '#', ancho: 5, alinear: 'center', formato: FORMATO_ENTERO },
      { titulo: 'Cliente', ancho: 42 },
      { titulo: 'Documento', ancho: 15 },
      { titulo: 'Comprobantes', ancho: 14, alinear: 'right', formato: FORMATO_ENTERO },
      { titulo: 'Importe', ancho: 16, alinear: 'right', formato: FORMATO_MONEDA },
      { titulo: '% del total', ancho: 12, alinear: 'right', formato: FORMATO_PORCENTAJE },
    ],
    filas: (reporte.estadisticas.top_clientes ?? []).map((c, i) => [
      i + 1,
      c.cliente,
      c.documento || '—',
      c.cantidad,
      c.total,
      pct(c.total, reporte.total_vendido),
    ]),
    vacio: 'Sin clientes en el periodo.',
  });

  const buffer = await wb.xlsx.writeBuffer();
  return Buffer.from(buffer as ArrayBuffer);
}

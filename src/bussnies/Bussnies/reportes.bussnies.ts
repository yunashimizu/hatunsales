import { Injectable, BadRequestException } from '@nestjs/common';
import { ReportesRepository } from '../../repository/Repository/reportes.repository';
import { IReportesBussniees } from '../Ibussnies/IReportesBussniees';
import {
  VentasEstadisticas,
  VentasReportDetalle,
  VentasReportResponse,
  VentasSeriePunto,
  VentasTopCliente,
} from '../../models/model/ventas-report.response';
import { CodigoError, cuerpoError } from '../../util/errores-operativos';
import { emisorConfig } from '../../config/emisor.config';
import {
  CabeceraReporte,
  FilaDetalleReporte,
  REPORTE_COLUMNAS_DETALLE,
  capitalizarEstado,
  etiquetaPeriodo,
  formatearMonedaEs,
  nombreArchivoReporte,
} from '../../util/reporte-export';
import {
  FechaLimaInvalidaError,
  aFechaLima,
  esFechaYmd,
  fechaHoraLimaLegible,
  finDiaLima,
  hoyLima,
  inicioAnioLima,
  inicioMesLima,
  inicioQuincenaLima,
  inicioSemanaLima,
  rangoDiaLima,
  rangoFechasLima,
  validarFechaYmd,
} from '../../util/fecha-lima';
import { TIPO_NOTA_CREDITO, TIPO_NOTA_DEBITO } from '../../util/fiscal/tipos-comprobante';
import { Dinero } from '../../caja/dominio/dinero';

type ReportesFilters = {
  fecha_inicio?: string;
  fecha_fin?: string;
  id_cliente?: number;
  id_tipo?: number;
  id_moneda?: number;
};

/**
 * Qué cuenta en el reporte de ventas y con qué signo.
 *
 * - Factura y boleta (y cualquier comprobante histórico que no sea nota) SUMAN.
 * - Nota de crédito (id_tipo 7) RESTA: devuelve o descuenta una venta que ya se contó.
 * - Nota de débito (id_tipo 8) SUMA: es un cargo adicional sobre una venta.
 * - NO cuentan: anulados (anulado = true, estado 'anulado' o baja aceptada 'ANULADO'),
 *   los de prueba (ambiente_fiscal 'beta'), los que quedaron en estado 'error' (nunca se
 *   emitieron) y los RECHAZADOS por SUNAT (no tienen validez).
 * - Los históricos emitidos con Nubefact (ambiente_fiscal nulo) cuentan como siempre.
 * Es el mismo criterio de "comprobante vigente" con el que las notas de crédito calculan
 * el saldo de una venta (no anulado, sin error, no rechazado), más la exclusión de BETA.
 */
export type ClaseReporte =
  | { cuenta: true; signo: 1 | -1; tipo: 'venta' | 'nota_credito' | 'nota_debito' }
  | { cuenta: false; motivo: 'anulado' | 'prueba' | 'error' | 'rechazado' };

export interface ComprobanteReporte {
  anulado?: boolean | null;
  estado?: string | null;
  estado_sunat?: string | null;
  ambiente_fiscal?: string | null;
  tipo?: { id_tipo?: number | null } | null;
  id_tipo?: number | null;
}

export function clasificarComprobanteReporte(c: ComprobanteReporte): ClaseReporte {
  const estado = String(c.estado ?? '').trim().toLowerCase();
  const estadoSunat = String(c.estado_sunat ?? '').trim().toUpperCase();
  if (c.anulado === true || estado === 'anulado' || estadoSunat === 'ANULADO') {
    return { cuenta: false, motivo: 'anulado' };
  }
  if (String(c.ambiente_fiscal ?? '').trim().toLowerCase() === 'beta') return { cuenta: false, motivo: 'prueba' };
  if (estado === 'error') return { cuenta: false, motivo: 'error' };
  if (estadoSunat === 'RECHAZADO') return { cuenta: false, motivo: 'rechazado' };

  const idTipo = Number(c.tipo?.id_tipo ?? c.id_tipo);
  if (idTipo === TIPO_NOTA_CREDITO) return { cuenta: true, signo: -1, tipo: 'nota_credito' };
  if (idTipo === TIPO_NOTA_DEBITO) return { cuenta: true, signo: 1, tipo: 'nota_debito' };
  return { cuenta: true, signo: 1, tipo: 'venta' };
}

/** Fila del detalle: total_vendido ya lleva el signo (la nota de crédito va en negativo). */
export interface DetalleReporteVentas extends VentasReportDetalle {
  tipo_documento: 'venta' | 'nota_credito' | 'nota_debito';
}

/** Respuesta con el neto y lo que lo explica (campos nuevos: un front anterior los ignora). */
export interface ReporteVentasNeto extends VentasReportResponse {
  detalle: DetalleReporteVentas[];
  /** Facturas y boletas más notas de débito, antes de restar las notas de crédito. */
  total_bruto: number;
  notas_credito: { cantidad: number; total: number };
  notas_debito: { cantidad: number; total: number };
  /** Comprobantes del periodo que no suman: anulados, con error o rechazados (sin pruebas BETA). */
  excluidos: { anulados: number; con_error: number; rechazados: number };
}

interface RangoReporte {
  /** 00:00 de Lima del primer día (inclusivo). */
  desde: Date;
  /** 00:00 de Lima del día siguiente al último (exclusivo, para el SQL). */
  hasta: Date;
  /** 23:59:59.999 de Lima del último día (para mostrar). */
  fin: Date;
}

const PATRON_DMY = /^(\d{2})[-/](\d{2})[-/](\d{4})$/;

/**
 * Día de Lima del comprobante ('YYYY-MM-DD'): su fecha de emisión si es legible (la
 * directa la guarda AAAA-MM-DD; la de Nubefact pudo ser DD-MM-AAAA) y, si no, el día de
 * Lima en que se registró. Nunca un instante UTC: a las 20:00 de Lima ya es "mañana" en UTC.
 */
export function diaLimaComprobante(c: { fecha_de_emision?: string | null; creado_en?: Date | string | null }): string {
  const texto = String(c.fecha_de_emision ?? '').trim().slice(0, 10);
  if (esFechaYmd(texto)) return texto;
  const dmy = PATRON_DMY.exec(texto);
  if (dmy && esFechaYmd(`${dmy[3]}-${dmy[2]}-${dmy[1]}`)) return `${dmy[3]}-${dmy[2]}-${dmy[1]}`;
  const instante = c.creado_en ? new Date(c.creado_en) : null;
  return instante && !Number.isNaN(instante.getTime()) ? aFechaLima(instante) : '';
}

/** 'YYYY-MM-DD' → 'dd/mm/aaaa' sin pasar por Date (no depende de la zona del servidor). */
function ymdLegible(ymd: string): string {
  return esFechaYmd(ymd) ? `${ymd.slice(8, 10)}/${ymd.slice(5, 7)}/${ymd.slice(0, 4)}` : ymd || '—';
}

const MESES_CORTOS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

const PERIODOS_VALIDOS = new Set(['diario', 'semana', 'quincenal', 'mensual', 'anual']);

const PLANES: Record<string, string> = {
  diario: 'Cierre del día: ventas de hoy para cuadrar caja y ver el ritmo actual.',
  semana: 'Semana laboral en curso (lunes a hoy): útil para seguimiento semanal del equipo.',
  quincenal: 'Quincena actual (1–15 o 16–fin de mes): ideal para avances de planilla o metas quincenales.',
  mensual: 'Mes en curso desde el día 1: panorama del mes para metas y comparación interna.',
  anual: 'Año calendario desde enero: visión de tendencia y estacionalidad.',
};

const EXCEL = {
  headerBg: '1F4E79',
  headerFg: 'FFFFFF',
  sectionBg: 'D6E3F0',
  kpiLabelBg: 'F2F2F2',
  altRow: 'F7F9FC',
  border: 'B0B0B0',
  titleFg: '1F4E79',
};

@Injectable()
export class ReportesBussnies implements IReportesBussniees {
  constructor(private readonly repo: ReportesRepository) {}

  /**
   * Ventas netas del periodo (días de Lima). total_vendido = facturas y boletas + notas de
   * débito − notas de crédito; cantidad_comprobantes y ticket_promedio son de los
   * comprobantes de venta (facturas y boletas). La regla está en clasificarComprobanteReporte.
   */
  async reporteVentas(
    periodo: string,
    filters: ReportesFilters,
  ): Promise<ReporteVentasNeto> {
    const periodoNormalizado = (periodo || 'diario').toLowerCase().trim();
    if (!filters.fecha_inicio && !filters.fecha_fin && !PERIODOS_VALIDOS.has(periodoNormalizado)) {
      throw new BadRequestException(
        cuerpoError(
          CodigoError.REPORTE_PERIODO_INVALIDO,
          'Período inválido. Use: diario, quincenal, mensual o anual',
        ),
      );
    }

    const rango = this.resolverRango(periodoNormalizado, filters);

    const lista = await this.repo.obtenerVentasPorPeriodo(rango.desde, rango.hasta, {
      id_cliente: filters.id_cliente,
      id_tipo: filters.id_tipo,
      id_moneda: filters.id_moneda,
    });

    const detalle: DetalleReporteVentas[] = [];
    const excluidos = { anulados: 0, con_error: 0, rechazados: 0 };
    let ventas = Dinero.cero();
    let notasCredito = Dinero.cero();
    let notasDebito = Dinero.cero();
    let cantidadVentas = 0;
    let cantidadNc = 0;
    let cantidadNd = 0;

    for (const item of lista) {
      const clase = clasificarComprobanteReporte(item);
      if (!clase.cuenta) {
        if (clase.motivo === 'anulado') excluidos.anulados += 1;
        else if (clase.motivo === 'error') excluidos.con_error += 1;
        else if (clase.motivo === 'rechazado') excluidos.rechazados += 1;
        continue;
      }

      const importe = Dinero.desdeBd(item.total);
      if (clase.tipo === 'nota_credito') {
        notasCredito = notasCredito.sumar(importe);
        cantidadNc += 1;
      } else if (clase.tipo === 'nota_debito') {
        notasDebito = notasDebito.sumar(importe);
        cantidadNd += 1;
      } else {
        ventas = ventas.sumar(importe);
        cantidadVentas += 1;
      }

      const serie = item.serie ?? '';
      const numero = Number(item.numero ?? 0);
      detalle.push({
        id_comprobante: item.id_comprobante,
        fecha: diaLimaComprobante(item),
        serie,
        numero,
        numero_formateado:
          serie && numero ? `${serie}-${String(numero).padStart(8, '0')}` : serie || String(numero || '—'),
        cliente: item.cliente_denominacion || '—',
        documento_cliente: item.cliente_numero_doc || '',
        estado: item.estado || 'emitido',
        anulado: false,
        cantidad_comprobantes: 1,
        total_vendido: clase.signo < 0 ? importe.negar().aNumero() : importe.aNumero(),
        tipo_documento: clase.tipo,
      });
    }

    const bruto = ventas.sumar(notasDebito);
    const neto = bruto.restar(notasCredito);
    const ticketPromedio = cantidadVentas > 0 ? Math.round(neto.centimos / cantidadVentas) / 100 : 0;

    return {
      periodo: periodoNormalizado,
      fecha_inicio: rango.desde.toISOString(),
      fecha_fin: rango.fin.toISOString(),
      cantidad_comprobantes: cantidadVentas,
      total_vendido: neto.aNumero(),
      ticket_promedio: ticketPromedio,
      detalle,
      estadisticas: this.construirEstadisticas(periodoNormalizado, detalle, excluidos),
      total_bruto: bruto.aNumero(),
      notas_credito: { cantidad: cantidadNc, total: notasCredito.aNumero() },
      notas_debito: { cantidad: cantidadNd, total: notasDebito.aNumero() },
      excluidos,
    };
  }

  async reportePorCategoria(filters: any = {}) {
    const report = await this.reporteVentas(filters?.periodo || 'mensual', filters);
    return {
      ...report,
      tipo: 'reporte_por_categoria',
      mensaje:
        'Para un reporte por categoría real, se recomienda usar una tabla de detalle de ventas por ítem o categoría en el modelo de comprobantes.',
    };
  }

  async exportVentasExcel(periodo: string, filters: any): Promise<{ buffer: Buffer; filename: string }> {
    try {
      const report = await this.reporteVentas(periodo, filters);
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const ExcelJS = require('exceljs');
      const wb = new ExcelJS.Workbook();
      wb.creator = emisorConfig.razon_social;
      wb.created = new Date();

      const ws = wb.addWorksheet('Ventas', {
        views: [{ state: 'frozen', ySplit: 12 }],
        properties: { defaultRowHeight: 18 },
      });

      const cabecera = this.armarCabecera(report);
      const filas = this.filasDetalle(report);
      const stats = report.estadisticas;
      const thin = {
        style: 'thin',
        color: { argb: `FF${EXCEL.border}` },
      };

      ws.mergeCells('A1:F1');
      const title = ws.getCell('A1');
      title.value = cabecera.empresa;
      title.font = { bold: true, size: 16, color: { argb: `FF${EXCEL.titleFg}` } };
      title.alignment = { vertical: 'middle', horizontal: 'left' };

      ws.mergeCells('A2:F2');
      ws.getCell('A2').value = `RUC ${cabecera.ruc}`;
      ws.getCell('A2').font = { size: 10, color: { argb: 'FF555555' } };

      ws.mergeCells('A3:F3');
      ws.getCell('A3').value = cabecera.titulo;
      ws.getCell('A3').font = { bold: true, size: 13, color: { argb: `FF${EXCEL.titleFg}` } };

      ws.mergeCells('A4:F4');
      ws.getCell('A4').value =
        `Periodo: ${etiquetaPeriodo(report.periodo)}  |  ${cabecera.fechaInicio} — ${cabecera.fechaFin}`;
      ws.getCell('A4').font = { size: 10 };

      ws.mergeCells('A5:F5');
      ws.getCell('A5').value = `Generado: ${cabecera.generadoEl}`;
      ws.getCell('A5').font = { size: 9, italic: true, color: { argb: 'FF666666' } };

      if (cabecera.nota) {
        ws.mergeCells('A6:F6');
        ws.getCell('A6').value = cabecera.nota;
        ws.getCell('A6').font = { size: 9, color: { argb: 'FF666666' } };
      }

      const kpiStart = 8;
      const kpis: Array<[string, string | number]> = [
        ['Total vendido', report.total_vendido],
        ['Ventas brutas', report.total_bruto],
        ['Notas de crédito', report.notas_credito.total ? -report.notas_credito.total : 0],
        ['Comprobantes', report.cantidad_comprobantes],
        ['Ticket promedio', report.ticket_promedio],
        ['Venta máxima', stats.venta_maxima],
        ['Venta mínima', stats.venta_minima],
        ['Emitidos', stats.emitidos],
        ['Anulados', stats.anulados],
        ['Con error', stats.con_error],
        ['Días con venta', stats.dias_con_venta],
      ];

      ws.getCell(`A${kpiStart}`).value = 'Resumen';
      ws.getCell(`A${kpiStart}`).font = { bold: true, size: 11 };
      ws.mergeCells(`A${kpiStart}:B${kpiStart}`);
      ws.getCell(`A${kpiStart}`).fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: `FF${EXCEL.sectionBg}` },
      };

      const kpiMoneda = new Set([
        'Total vendido', 'Ventas brutas', 'Notas de crédito', 'Ticket promedio', 'Venta máxima', 'Venta mínima',
      ]);
      kpis.forEach(([label, value], i) => {
        const row = kpiStart + 1 + i;
        const cLabel = ws.getCell(`A${row}`);
        const cVal = ws.getCell(`B${row}`);
        cLabel.value = label;
        cLabel.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: `FF${EXCEL.kpiLabelBg}` },
        };
        cLabel.border = { top: thin, left: thin, bottom: thin, right: thin };
        cVal.border = { top: thin, left: thin, bottom: thin, right: thin };
        cVal.value = value;
        if (kpiMoneda.has(label) && typeof value === 'number') {
          cVal.numFmt = '"S/"#,##0.00';
        }
        cVal.alignment = { horizontal: 'right' };
      });

      let rowIdx = kpiStart + 1 + kpis.length + 1;
      ws.mergeCells(`A${rowIdx}:F${rowIdx}`);
      ws.getCell(`A${rowIdx}`).value = 'Detalle de comprobantes';
      ws.getCell(`A${rowIdx}`).font = { bold: true, size: 11 };
      ws.getCell(`A${rowIdx}`).fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: `FF${EXCEL.sectionBg}` },
      };

      rowIdx += 1;
      const headerRow = ws.getRow(rowIdx);
      REPORTE_COLUMNAS_DETALLE.forEach((col, i) => {
        const cell = headerRow.getCell(i + 1);
        cell.value = col.label;
        cell.font = { bold: true, color: { argb: `FF${EXCEL.headerFg}` } };
        cell.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: `FF${EXCEL.headerBg}` },
        };
        cell.alignment = { vertical: 'middle', horizontal: i === 5 ? 'right' : 'left' };
        cell.border = { top: thin, left: thin, bottom: thin, right: thin };
      });
      headerRow.height = 20;
      const freezeAt = rowIdx;
      ws.views = [{ state: 'frozen', ySplit: freezeAt }];

      if (!filas.length) {
        rowIdx += 1;
        ws.mergeCells(`A${rowIdx}:F${rowIdx}`);
        ws.getCell(`A${rowIdx}`).value = 'Sin movimientos en el periodo seleccionado.';
        ws.getCell(`A${rowIdx}`).font = { italic: true, color: { argb: 'FF666666' } };
      } else {
        filas.forEach((f, idx) => {
          rowIdx += 1;
          const row = ws.getRow(rowIdx);
          const values = [f.comprobante, f.fecha, f.cliente, f.documento, f.estado, f.total];
          values.forEach((v, i) => {
            const cell = row.getCell(i + 1);
            cell.value = v;
            cell.border = { top: thin, left: thin, bottom: thin, right: thin };
            if (idx % 2 === 1) {
              cell.fill = {
                type: 'pattern',
                pattern: 'solid',
                fgColor: { argb: `FF${EXCEL.altRow}` },
              };
            }
            if (i === 5) {
              cell.numFmt = '"S/"#,##0.00';
              cell.alignment = { horizontal: 'right' };
            }
          });
        });
      }

      if (stats.serie?.length) {
        rowIdx += 2;
        ws.mergeCells(`A${rowIdx}:C${rowIdx}`);
        ws.getCell(`A${rowIdx}`).value = 'Serie temporal';
        ws.getCell(`A${rowIdx}`).font = { bold: true, size: 11 };
        ws.getCell(`A${rowIdx}`).fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: `FF${EXCEL.sectionBg}` },
        };
        rowIdx += 1;
        ['Etiqueta', 'Cantidad', 'Total'].forEach((label, i) => {
          const cell = ws.getRow(rowIdx).getCell(i + 1);
          cell.value = label;
          cell.font = { bold: true, color: { argb: `FF${EXCEL.headerFg}` } };
          cell.fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: `FF${EXCEL.headerBg}` },
          };
          cell.border = { top: thin, left: thin, bottom: thin, right: thin };
        });
        stats.serie.forEach((p) => {
          rowIdx += 1;
          const row = ws.getRow(rowIdx);
          row.getCell(1).value = p.etiqueta;
          row.getCell(2).value = p.cantidad;
          row.getCell(3).value = p.total;
          row.getCell(3).numFmt = '"S/"#,##0.00';
          for (let i = 1; i <= 3; i++) {
            row.getCell(i).border = { top: thin, left: thin, bottom: thin, right: thin };
          }
        });
      }

      if (stats.top_clientes?.length) {
        rowIdx += 2;
        ws.mergeCells(`A${rowIdx}:D${rowIdx}`);
        ws.getCell(`A${rowIdx}`).value = 'Top clientes';
        ws.getCell(`A${rowIdx}`).font = { bold: true, size: 11 };
        ws.getCell(`A${rowIdx}`).fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: `FF${EXCEL.sectionBg}` },
        };
        rowIdx += 1;
        ['Cliente', 'Documento', 'Cantidad', 'Total'].forEach((label, i) => {
          const cell = ws.getRow(rowIdx).getCell(i + 1);
          cell.value = label;
          cell.font = { bold: true, color: { argb: `FF${EXCEL.headerFg}` } };
          cell.fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: `FF${EXCEL.headerBg}` },
          };
          cell.border = { top: thin, left: thin, bottom: thin, right: thin };
        });
        stats.top_clientes.forEach((c) => {
          rowIdx += 1;
          const row = ws.getRow(rowIdx);
          row.getCell(1).value = c.cliente;
          row.getCell(2).value = c.documento || '';
          row.getCell(3).value = c.cantidad;
          row.getCell(4).value = c.total;
          row.getCell(4).numFmt = '"S/"#,##0.00';
          for (let i = 1; i <= 4; i++) {
            row.getCell(i).border = { top: thin, left: thin, bottom: thin, right: thin };
          }
        });
      }

      REPORTE_COLUMNAS_DETALLE.forEach((col, i) => {
        ws.getColumn(i + 1).width = col.excelWidth;
      });

      const buf = await wb.xlsx.writeBuffer();
      return {
        buffer: Buffer.from(buf),
        filename: nombreArchivoReporte('ventas', report.periodo, 'xlsx'),
      };
    } catch (e) {
      if (e instanceof BadRequestException) throw e;
      throw new BadRequestException(
        cuerpoError(
          CodigoError.REPORTE_EXPORT_FALLIDA,
          'No se pudo generar el Excel del reporte de ventas',
        ),
      );
    }
  }

  async exportVentasPdf(periodo: string, filters: any): Promise<{ buffer: Buffer; filename: string }> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const PDFDocument = require('pdfkit');
      const report = await this.reporteVentas(periodo, filters);
      const cabecera = this.armarCabecera(report);
      const filas = this.filasDetalle(report);
      const stats = report.estadisticas;

      const doc = new PDFDocument({
        size: 'A4',
        margin: 40,
        bufferPages: true,
        info: {
          Title: cabecera.titulo,
          Author: cabecera.empresa,
        },
      });
      const chunks: Uint8Array[] = [];
      doc.on('data', (chunk: Uint8Array) => chunks.push(chunk));

      const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
      const left = doc.page.margins.left;
      const bottomLimit = doc.page.height - 50;

      doc.fillColor('#1F4E79').font('Helvetica-Bold').fontSize(16).text(cabecera.empresa, left, 40, {
        width: pageWidth,
      });
      doc.fillColor('#555555').font('Helvetica').fontSize(9).text(`RUC ${cabecera.ruc}`, { width: pageWidth });
      doc.moveDown(0.4);
      doc.fillColor('#1F4E79').font('Helvetica-Bold').fontSize(13).text(cabecera.titulo, { width: pageWidth });
      doc.fillColor('#333333').font('Helvetica').fontSize(9);
      doc.text(
        `Periodo: ${etiquetaPeriodo(report.periodo)}   |   ${cabecera.fechaInicio} — ${cabecera.fechaFin}`,
      );
      doc.fillColor('#666666').fontSize(8).text(`Generado: ${cabecera.generadoEl}`);
      if (cabecera.nota) {
        doc.text(cabecera.nota);
      }
      doc.moveDown(0.6);

      doc.fillColor('#333333').font('Helvetica-Bold').fontSize(10).text('Resumen');
      doc.moveDown(0.2);
      doc.font('Helvetica').fontSize(9);
      const kpiLines = [
        `Total vendido: ${formatearMonedaEs(report.total_vendido)}`,
        `Ventas brutas: ${formatearMonedaEs(report.total_bruto)}   |   Notas de crédito (${report.notas_credito.cantidad}): ${formatearMonedaEs(report.notas_credito.total ? -report.notas_credito.total : 0)}`,
        `Comprobantes: ${report.cantidad_comprobantes}   |   Ticket promedio: ${formatearMonedaEs(report.ticket_promedio)}`,
        `Máx / Mín: ${formatearMonedaEs(stats.venta_maxima)} / ${formatearMonedaEs(stats.venta_minima)}`,
        `Emitidos: ${stats.emitidos}   |   Anulados: ${stats.anulados}   |   Con error: ${stats.con_error}`,
      ];
      kpiLines.forEach((line) => doc.text(line));
      doc.moveDown(0.7);

      const colWidths = REPORTE_COLUMNAS_DETALLE.map((c) => c.pdfWidth);
      const rowH = 18;

      const dibujarHeaderTabla = () => {
        const y = doc.y;
        doc.save();
        doc.rect(left, y, pageWidth, rowH).fill('#1F4E79');
        doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(8);
        let x = left;
        REPORTE_COLUMNAS_DETALLE.forEach((col, i) => {
          const align = i === 5 ? 'right' : 'left';
          doc.text(col.label, x + 3, y + 5, { width: colWidths[i] - 6, align });
          x += colWidths[i];
        });
        doc.restore();
        doc.y = y + rowH;
      };

      const asegurarEspacio = (alto: number) => {
        if (doc.y + alto > bottomLimit) {
          doc.addPage();
          dibujarHeaderTabla();
        }
      };

      doc.fillColor('#333333').font('Helvetica-Bold').fontSize(10).text('Detalle de comprobantes');
      doc.moveDown(0.3);
      dibujarHeaderTabla();

      if (!filas.length) {
        asegurarEspacio(24);
        doc.fillColor('#666666').font('Helvetica-Oblique').fontSize(9)
          .text('Sin movimientos en el periodo seleccionado.', left + 4, doc.y + 6);
        doc.moveDown(1);
      } else {
        filas.forEach((f, idx) => {
          asegurarEspacio(rowH);
          const y = doc.y;
          if (idx % 2 === 1) {
            doc.save();
            doc.rect(left, y, pageWidth, rowH).fill('#F7F9FC');
            doc.restore();
          }
          doc.save();
          doc.strokeColor('#B0B0B0').lineWidth(0.4);
          doc.rect(left, y, pageWidth, rowH).stroke();
          doc.restore();

          const cells = [
            f.comprobante,
            f.fecha,
            f.cliente,
            f.documento,
            f.estado,
            formatearMonedaEs(f.total),
          ];
          doc.fillColor('#222222').font('Helvetica').fontSize(8);
          let x = left;
          cells.forEach((text, i) => {
            const align = i === 5 ? 'right' : 'left';
            const maxLen = i === 2 ? 28 : 40;
            const t = String(text || '—');
            doc.text(t.length > maxLen ? `${t.slice(0, maxLen - 1)}…` : t, x + 3, y + 5, {
              width: colWidths[i] - 6,
              align,
              lineBreak: false,
            });
            x += colWidths[i];
          });
          doc.y = y + rowH;
        });
      }

      if (stats.top_clientes?.length) {
        doc.moveDown(0.8);
        asegurarEspacio(40);
        doc.fillColor('#333333').font('Helvetica-Bold').fontSize(10).text('Top clientes');
        doc.moveDown(0.2);
        doc.font('Helvetica').fontSize(8).fillColor('#222222');
        stats.top_clientes.forEach((c, i) => {
          asegurarEspacio(14);
          doc.text(
            `${i + 1}. ${c.cliente}${c.documento ? ` (${c.documento})` : ''} — ${c.cantidad} doc. — ${formatearMonedaEs(c.total)}`,
          );
        });
      }

      const range = doc.bufferedPageRange();
      for (let i = 0; i < range.count; i++) {
        doc.switchToPage(range.start + i);
        const pieY = doc.page.height - 32;
        doc.font('Helvetica').fontSize(8).fillColor('#666666');
        doc.text(
          `${cabecera.empresa} · Reporte de ventas`,
          left,
          pieY,
          { width: pageWidth / 2, align: 'left', lineBreak: false },
        );
        doc.text(
          `Página ${i + 1} de ${range.count}`,
          left + pageWidth / 2,
          pieY,
          { width: pageWidth / 2, align: 'right', lineBreak: false },
        );
      }

      doc.end();
      await new Promise<void>((resolve, reject) => {
        doc.on('end', () => resolve());
        doc.on('error', reject);
      });

      return {
        buffer: Buffer.concat(chunks.map((c) => Buffer.from(c))),
        filename: nombreArchivoReporte('ventas', report.periodo, 'pdf'),
      };
    } catch (e) {
      if (e instanceof BadRequestException) throw e;
      throw new BadRequestException(
        cuerpoError(
          CodigoError.REPORTE_EXPORT_FALLIDA,
          'No se pudo generar el PDF del reporte de ventas',
        ),
      );
    }
  }

  private armarCabecera(report: VentasReportResponse): CabeceraReporte {
    return {
      empresa: emisorConfig.razon_social || 'HATUNSALES S.A.C.',
      ruc: emisorConfig.ruc || '—',
      titulo: 'Reporte de ventas',
      periodo: report.periodo,
      // Días y hora de Lima: el servidor corre en UTC.
      fechaInicio: ymdLegible(aFechaLima(new Date(report.fecha_inicio))),
      fechaFin: ymdLegible(aFechaLima(new Date(report.fecha_fin))),
      generadoEl: fechaHoraLimaLegible(new Date()),
      nota:
        'Ventas netas: facturas y boletas más notas de débito, menos notas de crédito. ' +
        'No incluye anulados, rechazados por SUNAT, con error ni pruebas BETA.',
    };
  }

  private filasDetalle(report: VentasReportResponse): FilaDetalleReporte[] {
    return (report.detalle || []).map((d) => ({
      comprobante:
        d.numero_formateado ||
        (d.serie || d.numero != null ? `${d.serie ?? ''}-${d.numero ?? ''}` : '—'),
      fecha: ymdLegible(d.fecha),
      cliente: d.cliente || '—',
      documento: d.documento_cliente || '—',
      estado: capitalizarEstado(d.estado),
      total: Number(d.total_vendido ?? 0),
    }));
  }

  private construirEstadisticas(
    periodo: string,
    detalle: DetalleReporteVentas[],
    excluidos: { anulados: number; con_error: number; rechazados: number },
  ): VentasEstadisticas {
    // Máximo, mínimo y días con venta miran solo facturas y boletas: una nota no es una venta.
    const ventas = detalle.filter((d) => d.tipo_documento === 'venta');
    const totales = ventas.map((d) => Number(d.total_vendido ?? 0));
    const ventaMaxima = totales.length ? Math.max(...totales) : 0;
    const ventaMinima = totales.length ? Math.min(...totales) : 0;

    const serie = this.agruparSerie(periodo, detalle);
    const topClientes = this.topClientes(detalle, 5);
    const diasConVenta = new Set(ventas.map((d) => d.fecha).filter(Boolean)).size;

    return {
      venta_maxima: ventaMaxima,
      venta_minima: ventaMinima,
      emitidos: detalle.length,
      anulados: excluidos.anulados,
      con_error: excluidos.con_error + excluidos.rechazados,
      dias_con_venta: diasConVenta,
      serie,
      top_clientes: topClientes,
      plan: PLANES[periodo] || 'Resumen del periodo seleccionado.',
    };
  }

  /** Neto por día de Lima (por mes de Lima en el anual). */
  private agruparSerie(periodo: string, detalle: DetalleReporteVentas[]): VentasSeriePunto[] {
    const mapa = new Map<string, { total: Dinero; cantidad: number; etiqueta: string }>();
    const porMes = periodo === 'anual';

    for (const d of detalle) {
      const dia = d.fecha;
      let clave: string;
      let etiqueta: string;

      if (!esFechaYmd(dia)) {
        clave = dia || 'sin-fecha';
        etiqueta = clave;
      } else if (porMes) {
        clave = dia.slice(0, 7);
        etiqueta = `${MESES_CORTOS[Number(dia.slice(5, 7)) - 1]} ${dia.slice(0, 4)}`;
      } else {
        clave = dia;
        etiqueta = `${dia.slice(8, 10)} ${MESES_CORTOS[Number(dia.slice(5, 7)) - 1]}`;
      }

      const actual = mapa.get(clave) ?? { total: Dinero.cero(), cantidad: 0, etiqueta };
      actual.total = actual.total.sumar(Dinero.desdeNumeroRedondeado(Number(d.total_vendido ?? 0)));
      actual.cantidad += 1;
      mapa.set(clave, actual);
    }

    return Array.from(mapa.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([clave, v]) => ({
        clave,
        etiqueta: v.etiqueta,
        total: v.total.aNumero(),
        cantidad: v.cantidad,
      }));
  }

  /** Neto por cliente: sus notas de crédito restan de lo que compró. */
  private topClientes(detalle: DetalleReporteVentas[], limite: number): VentasTopCliente[] {
    const mapa = new Map<string, { cliente: string; documento: string; total: Dinero; cantidad: number }>();

    for (const d of detalle) {
      const nombre = (d.cliente || '—').trim() || '—';
      const key = `${nombre}|${d.documento_cliente || ''}`;
      const actual = mapa.get(key) ?? {
        cliente: nombre,
        documento: d.documento_cliente || '',
        total: Dinero.cero(),
        cantidad: 0,
      };
      actual.total = actual.total.sumar(Dinero.desdeNumeroRedondeado(Number(d.total_vendido ?? 0)));
      actual.cantidad += 1;
      mapa.set(key, actual);
    }

    return Array.from(mapa.values())
      .map((c) => ({ ...c, total: c.total.aNumero() }))
      .sort((a, b) => b.total - a.total)
      .slice(0, limite);
  }

  /**
   * Rango del periodo en días de Lima. Antes se usaba setHours sobre la hora del servidor
   * (UTC): el "diario" iba de las 19:00 de ayer a las 18:59 de hoy en Lima y las ventas de
   * la noche caían en el día siguiente.
   */
  private resolverRango(periodo: string, filters: ReportesFilters): RangoReporte {
    const ahora = new Date();

    if (filters.fecha_inicio && filters.fecha_fin) {
      try {
        const desdeYmd = validarFechaYmd(filters.fecha_inicio, 'fecha_inicio');
        const hastaYmd = validarFechaYmd(filters.fecha_fin, 'fecha_fin');
        const { desde, hasta } = rangoFechasLima(desdeYmd, hastaYmd);
        return { desde, hasta, fin: finDiaLima(hastaYmd) };
      } catch (error) {
        if (error instanceof FechaLimaInvalidaError) {
          throw new BadRequestException(
            cuerpoError(
              CodigoError.REPORTE_FECHA_INVALIDA,
              error.campo === 'desde'
                ? 'La fecha de inicio no puede ser posterior a la fecha de fin'
                : `Formato de fecha inválido en ${error.campo}: use AAAA-MM-DD`,
            ),
          );
        }
        throw error;
      }
    }

    const hoy = hoyLima(ahora);
    const hasta = rangoDiaLima(hoy).hasta;
    const fin = finDiaLima(hoy);

    switch (periodo) {
      case 'diario':
        return { desde: rangoDiaLima(hoy).desde, hasta, fin };
      case 'semana':
        return { desde: inicioSemanaLima(ahora), hasta, fin };
      case 'quincenal':
        return { desde: inicioQuincenaLima(ahora), hasta, fin };
      case 'mensual':
        return { desde: inicioMesLima(ahora), hasta, fin };
      case 'anual':
        return { desde: inicioAnioLima(ahora), hasta, fin };
      default:
        throw new BadRequestException(
          cuerpoError(
            CodigoError.REPORTE_PERIODO_INVALIDO,
            'Período inválido. Use: diario, quincenal, mensual o anual',
          ),
        );
    }
  }
}

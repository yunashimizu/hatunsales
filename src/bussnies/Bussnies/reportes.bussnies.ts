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
  formatearFechaEs,
  formatearFechaHoraEs,
  formatearMonedaEs,
  nombreArchivoReporte,
} from '../../util/reporte-export';

type ReportesFilters = {
  fecha_inicio?: string;
  fecha_fin?: string;
  id_cliente?: number;
  id_tipo?: number;
  id_moneda?: number;
};

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

  async reporteVentas(
    periodo: string,
    filters: ReportesFilters,
  ): Promise<VentasReportResponse> {
    const periodoNormalizado = (periodo || 'diario').toLowerCase().trim();
    if (!filters.fecha_inicio && !filters.fecha_fin && !PERIODOS_VALIDOS.has(periodoNormalizado)) {
      throw new BadRequestException(
        cuerpoError(
          CodigoError.REPORTE_PERIODO_INVALIDO,
          'Período inválido. Use: diario, quincenal, mensual o anual',
        ),
      );
    }

    const { fechaInicio, fechaFin } = this.resolverRango(periodoNormalizado, filters);

    const lista = await this.repo.obtenerVentasPorPeriodo(fechaInicio, fechaFin, {
      id_cliente: filters.id_cliente,
      id_tipo: filters.id_tipo,
      id_moneda: filters.id_moneda,
    });

    const detalle: VentasReportDetalle[] = lista.map((item) => {
      const serie = item.serie ?? '';
      const numero = Number(item.numero ?? 0);
      return {
        id_comprobante: item.id_comprobante,
        fecha: item.fecha_de_emision || (item.creado_en ? new Date(item.creado_en).toISOString() : ''),
        serie,
        numero,
        numero_formateado:
          serie && numero ? `${serie}-${String(numero).padStart(8, '0')}` : serie || String(numero || '—'),
        cliente: item.cliente_denominacion || '—',
        documento_cliente: item.cliente_numero_doc || '',
        estado: item.anulado ? 'anulado' : item.estado || 'emitido',
        anulado: Boolean(item.anulado),
        cantidad_comprobantes: 1,
        total_vendido: Number(item.total ?? 0),
      };
    });

    const totalVendido = detalle.reduce((sum, item) => sum + Number(item.total_vendido ?? 0), 0);
    const cantidadComprobantes = detalle.length;
    const ticketPromedio = cantidadComprobantes > 0 ? totalVendido / cantidadComprobantes : 0;

    return {
      periodo: periodoNormalizado,
      fecha_inicio: fechaInicio.toISOString(),
      fecha_fin: fechaFin.toISOString(),
      cantidad_comprobantes: cantidadComprobantes,
      total_vendido: Number(totalVendido.toFixed(2)),
      ticket_promedio: Number(ticketPromedio.toFixed(2)),
      detalle,
      estadisticas: this.construirEstadisticas(periodoNormalizado, detalle),
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

      const kpiMoneda = new Set(['Total vendido', 'Ticket promedio', 'Venta máxima', 'Venta mínima']);
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
      fechaInicio: formatearFechaEs(report.fecha_inicio),
      fechaFin: formatearFechaEs(report.fecha_fin),
      generadoEl: formatearFechaHoraEs(new Date()),
      nota: 'Incluye comprobantes no anulados del periodo.',
    };
  }

  private filasDetalle(report: VentasReportResponse): FilaDetalleReporte[] {
    return (report.detalle || []).map((d) => ({
      comprobante:
        d.numero_formateado ||
        (d.serie || d.numero != null ? `${d.serie ?? ''}-${d.numero ?? ''}` : '—'),
      fecha: formatearFechaEs(d.fecha),
      cliente: d.cliente || '—',
      documento: d.documento_cliente || '—',
      estado: capitalizarEstado(d.estado),
      total: Number(d.total_vendido ?? 0),
    }));
  }

  private construirEstadisticas(periodo: string, detalle: VentasReportDetalle[]): VentasEstadisticas {
    const totales = detalle.map((d) => Number(d.total_vendido ?? 0));
    const ventaMaxima = totales.length ? Math.max(...totales) : 0;
    const ventaMinima = totales.length ? Math.min(...totales) : 0;

    let emitidos = 0;
    let anulados = 0;
    let conError = 0;

    for (const d of detalle) {
      const estado = String(d.estado || '').toLowerCase();
      if (d.anulado || estado === 'anulado') anulados += 1;
      else if (estado === 'error') conError += 1;
      else emitidos += 1;
    }

    const serie = this.agruparSerie(periodo, detalle);
    const topClientes = this.topClientes(detalle, 5);
    const diasConVenta = new Set(
      detalle.map((d) => String(d.fecha || '').slice(0, 10)).filter((f) => f.length >= 8),
    ).size;

    return {
      venta_maxima: Number(ventaMaxima.toFixed(2)),
      venta_minima: Number(ventaMinima.toFixed(2)),
      emitidos,
      anulados,
      con_error: conError,
      dias_con_venta: diasConVenta,
      serie,
      top_clientes: topClientes,
      plan: PLANES[periodo] || 'Resumen del periodo seleccionado.',
    };
  }

  private agruparSerie(periodo: string, detalle: VentasReportDetalle[]): VentasSeriePunto[] {
    const mapa = new Map<string, { total: number; cantidad: number; etiqueta: string }>();
    const porMes = periodo === 'anual';

    for (const d of detalle) {
      const fecha = new Date(d.fecha);
      let clave: string;
      let etiqueta: string;

      if (Number.isNaN(fecha.getTime())) {
        clave = String(d.fecha || 'sin-fecha').slice(0, 10);
        etiqueta = clave;
      } else if (porMes) {
        const mes = fecha.getMonth() + 1;
        clave = `${fecha.getFullYear()}-${String(mes).padStart(2, '0')}`;
        etiqueta = fecha.toLocaleDateString('es-PE', { month: 'short', year: 'numeric' });
      } else {
        clave = fecha.toISOString().slice(0, 10);
        etiqueta = fecha.toLocaleDateString('es-PE', { day: '2-digit', month: 'short' });
      }

      const actual = mapa.get(clave) ?? { total: 0, cantidad: 0, etiqueta };
      actual.total += Number(d.total_vendido ?? 0);
      actual.cantidad += 1;
      mapa.set(clave, actual);
    }

    return Array.from(mapa.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([clave, v]) => ({
        clave,
        etiqueta: v.etiqueta,
        total: Number(v.total.toFixed(2)),
        cantidad: v.cantidad,
      }));
  }

  private topClientes(detalle: VentasReportDetalle[], limite: number): VentasTopCliente[] {
    const mapa = new Map<string, VentasTopCliente>();

    for (const d of detalle) {
      const nombre = (d.cliente || '—').trim() || '—';
      const key = `${nombre}|${d.documento_cliente || ''}`;
      const actual = mapa.get(key) ?? {
        cliente: nombre,
        documento: d.documento_cliente || '',
        total: 0,
        cantidad: 0,
      };
      actual.total += Number(d.total_vendido ?? 0);
      actual.cantidad += 1;
      mapa.set(key, actual);
    }

    return Array.from(mapa.values())
      .map((c) => ({ ...c, total: Number(c.total.toFixed(2)) }))
      .sort((a, b) => b.total - a.total)
      .slice(0, limite);
  }

  private resolverRango(periodo: string, filters: ReportesFilters): { fechaInicio: Date; fechaFin: Date } {
    const ahora = new Date();
    let fechaInicio: Date;
    let fechaFin = new Date(ahora);

    if (filters.fecha_inicio && filters.fecha_fin) {
      fechaInicio = new Date(filters.fecha_inicio);
      fechaFin = new Date(filters.fecha_fin);
      if (Number.isNaN(fechaInicio.getTime()) || Number.isNaN(fechaFin.getTime())) {
        throw new BadRequestException(
          cuerpoError(CodigoError.REPORTE_FECHA_INVALIDA, 'Formato de fecha inválido'),
        );
      }
      fechaInicio.setHours(0, 0, 0, 0);
      fechaFin.setHours(23, 59, 59, 999);
      return { fechaInicio, fechaFin };
    }

    switch (periodo) {
      case 'diario':
        fechaInicio = new Date(ahora);
        fechaInicio.setHours(0, 0, 0, 0);
        break;
      case 'semana':
        fechaInicio = new Date(ahora);
        const diaSemana = ahora.getDay();
        fechaInicio.setDate(ahora.getDate() - diaSemana + (diaSemana === 0 ? -6 : 1));
        fechaInicio.setHours(0, 0, 0, 0);
        break;
      case 'quincenal':
        fechaInicio = new Date(ahora);
        if (ahora.getDate() <= 15) {
          fechaInicio.setDate(1);
        } else {
          fechaInicio.setDate(16);
        }
        fechaInicio.setHours(0, 0, 0, 0);
        break;
      case 'mensual':
        fechaInicio = new Date(ahora.getFullYear(), ahora.getMonth(), 1);
        fechaInicio.setHours(0, 0, 0, 0);
        break;
      case 'anual':
        fechaInicio = new Date(ahora.getFullYear(), 0, 1);
        fechaInicio.setHours(0, 0, 0, 0);
        break;
      default:
        throw new BadRequestException(
          cuerpoError(
            CodigoError.REPORTE_PERIODO_INVALIDO,
            'Período inválido. Use: diario, quincenal, mensual o anual',
          ),
        );
    }

    fechaFin.setHours(23, 59, 59, 999);
    return { fechaInicio, fechaFin };
  }
}

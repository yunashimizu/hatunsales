import { Injectable, BadRequestException } from '@nestjs/common';
import { ReportesRepository } from '../../repository/Repository/reportes.repository';
import { IReportesBussniees } from '../Ibussnies/IReportesBussniees';
import { VentasReportResponse } from '../../models/model/ventas-report.response';
// exceljs is required dynamically inside the method to avoid build-time type resolution when not installed

type ReportesFilters = {
  fecha_inicio?: string;
  fecha_fin?: string;
  id_cliente?: number;
  id_tipo?: number;
  id_moneda?: number;
};

@Injectable()
export class ReportesBussnies implements IReportesBussniees {
  constructor(private readonly repo: ReportesRepository) {}

  async reporteVentas(
    periodo: string,
    filters: ReportesFilters,
  ): Promise<VentasReportResponse> {
    const ahora = new Date();
    let fechaInicio: Date;
    let fechaFin = new Date(ahora);

    if (filters.fecha_inicio && filters.fecha_fin) {
      fechaInicio = new Date(filters.fecha_inicio);
      fechaFin = new Date(filters.fecha_fin);
      if (Number.isNaN(fechaInicio.getTime()) || Number.isNaN(fechaFin.getTime())) {
        throw new BadRequestException('Formato de fecha inválido');
      }
      fechaInicio.setHours(0, 0, 0, 0);
      fechaFin.setHours(23, 59, 59, 999);
    } else {
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
          break;
        default:
          throw new BadRequestException('Período inválido');
      }
    }

    const lista = await this.repo.obtenerVentasPorPeriodo(fechaInicio, fechaFin, {
      id_cliente: filters.id_cliente,
      id_tipo: filters.id_tipo,
      id_moneda: filters.id_moneda,
    });
    const totalVendido = lista.reduce((sum, item) => sum + Number(item.total ?? 0), 0);
    const cantidadComprobantes = lista.length;

    return {
      periodo,
      fecha_inicio: fechaInicio.toISOString(),
      fecha_fin: fechaFin.toISOString(),
      cantidad_comprobantes: cantidadComprobantes,
      total_vendido: totalVendido,
      detalle: lista.map((item) => ({
        fecha: item.fecha_de_emision,
        cantidad_comprobantes: 1,
        total_vendido: Number(item.total ?? 0),
      })),
    };
  }

  async reportePorCategoria(filters: any = {}) {
    const report = await this.reporteVentas('mensual', filters);
    return {
      ...report,
      tipo: 'reporte_por_categoria',
      mensaje: 'Para un reporte por categoría real, se recomienda usar una tabla de detalle de ventas por ítem o categoría en el modelo de comprobantes.',
    };
  }

  async exportVentasExcel(periodo: string, filters: any): Promise<Buffer> {
    const report = await this.reporteVentas(periodo, filters);
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Ventas');
    ws.addRow(['Periodo', report.periodo]);
    ws.addRow(['Fecha Inicio', report.fecha_inicio]);
    ws.addRow(['Fecha Fin', report.fecha_fin]);
    ws.addRow([]);
    ws.addRow(['Fecha', 'Cantidad Comprobantes', 'Total Vendido']);
    report.detalle.forEach((d) => {
      ws.addRow([d.fecha, d.cantidad_comprobantes, d.total_vendido]);
    });
    ws.addRow([]);
    ws.addRow(['Cantidad Comprobantes', report.cantidad_comprobantes]);
    ws.addRow(['Total Vendido', report.total_vendido]);
    const buf = await wb.xlsx.writeBuffer();
    return Buffer.from(buf);
  }

  async exportVentasPdf(periodo: string, filters: any): Promise<Buffer> {
    // lazy require to avoid build-time dependency issues
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const PDFDocument = require('pdfkit');
    const report = await this.reporteVentas(periodo, filters);
    const doc = new PDFDocument({ size: 'A4', margin: 40 });
    const chunks: Uint8Array[] = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    const title = `Reporte de Ventas - ${report.periodo}`;
    doc.fontSize(16).text(title, { align: 'center' });
    doc.moveDown();
    doc.fontSize(10).text(`Desde: ${report.fecha_inicio}`);
    doc.text(`Hasta: ${report.fecha_fin}`);
    doc.moveDown();
    // table header
    doc.fontSize(11).text('Fecha', { continued: true, width: 200 });
    doc.text('Cant', { continued: true, align: 'center' });
    doc.text('Total', { align: 'right' });
    doc.moveDown(0.5);
    report.detalle.forEach((d) => {
      doc.text(String(d.fecha), { continued: true, width: 200 });
      doc.text(String(d.cantidad_comprobantes), { continued: true, align: 'center' });
      doc.text(String(d.total_vendido), { align: 'right' });
    });
    doc.moveDown();
    doc.text(`Cantidad Comprobantes: ${report.cantidad_comprobantes}`);
    doc.text(`Total Vendido: ${report.total_vendido}`);
    doc.end();
    await new Promise((res) => doc.on('end', res));
    return Buffer.concat(chunks.map((c) => Buffer.from(c)));
  }
}

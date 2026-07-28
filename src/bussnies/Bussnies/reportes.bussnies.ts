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

@Injectable()
export class ReportesBussnies implements IReportesBussniees {
  constructor(private readonly repo: ReportesRepository) {}

  async reporteVentas(
    periodo: string,
    filters: ReportesFilters,
  ): Promise<VentasReportResponse> {
    const periodoNormalizado = (periodo || 'diario').toLowerCase().trim();
    if (!filters.fecha_inicio && !filters.fecha_fin && !PERIODOS_VALIDOS.has(periodoNormalizado)) {
      throw new BadRequestException('Período inválido. Use: diario, quincenal, mensual o anual');
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
        numero_formateado: serie && numero ? `${serie}-${String(numero).padStart(8, '0')}` : serie || String(numero || '—'),
        cliente: item.cliente_denominacion || '—',
        documento_cliente: item.cliente_numero_doc || '',
        estado: item.anulado ? 'anulado' : (item.estado || 'emitido'),
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
      mensaje: 'Para un reporte por categoría real, se recomienda usar una tabla de detalle de ventas por ítem o categoría en el modelo de comprobantes.',
    };
  }

  async exportVentasExcel(periodo: string, filters: any): Promise<Buffer> {
    const report = await this.reporteVentas(periodo, filters);
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Ventas');
    const stats = report.estadisticas;

    ws.addRow(['Periodo', report.periodo]);
    ws.addRow(['Plan', stats.plan]);
    ws.addRow(['Fecha Inicio', report.fecha_inicio]);
    ws.addRow(['Fecha Fin', report.fecha_fin]);
    ws.addRow(['Total vendido', report.total_vendido]);
    ws.addRow(['Comprobantes', report.cantidad_comprobantes]);
    ws.addRow(['Ticket promedio', report.ticket_promedio]);
    ws.addRow(['Venta máxima', stats.venta_maxima]);
    ws.addRow(['Venta mínima', stats.venta_minima]);
    ws.addRow(['Emitidos', stats.emitidos]);
    ws.addRow(['Con error', stats.con_error]);
    ws.addRow([]);
    ws.addRow(['Comprobante', 'Fecha', 'Cliente', 'Documento', 'Estado', 'Total']);

    report.detalle.forEach((d) => {
      ws.addRow([
        d.numero_formateado || `${d.serie ?? ''}-${d.numero ?? ''}`,
        d.fecha,
        d.cliente || '—',
        d.documento_cliente || '',
        d.estado || '',
        d.total_vendido,
      ]);
    });

    if (stats.serie.length) {
      ws.addRow([]);
      ws.addRow(['Serie temporal']);
      ws.addRow(['Etiqueta', 'Cantidad', 'Total']);
      stats.serie.forEach((p) => ws.addRow([p.etiqueta, p.cantidad, p.total]));
    }

    if (stats.top_clientes.length) {
      ws.addRow([]);
      ws.addRow(['Top clientes']);
      ws.addRow(['Cliente', 'Documento', 'Cantidad', 'Total']);
      stats.top_clientes.forEach((c) => ws.addRow([c.cliente, c.documento || '', c.cantidad, c.total]));
    }

    const buf = await wb.xlsx.writeBuffer();
    return Buffer.from(buf);
  }

  async exportVentasPdf(periodo: string, filters: any): Promise<Buffer> {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const PDFDocument = require('pdfkit');
    const report = await this.reporteVentas(periodo, filters);
    const doc = new PDFDocument({ size: 'A4', margin: 40 });
    const chunks: Uint8Array[] = [];
    doc.on('data', (chunk: Uint8Array) => chunks.push(chunk));

    doc.fontSize(16).text(`Reporte de ventas — ${report.periodo}`, { align: 'center' });
    doc.moveDown();
    doc.fontSize(10).text(report.estadisticas.plan);
    doc.moveDown(0.5);
    doc.text(`Desde: ${report.fecha_inicio}`);
    doc.text(`Hasta: ${report.fecha_fin}`);
    doc.text(`Total vendido: ${report.total_vendido}`);
    doc.text(`Comprobantes: ${report.cantidad_comprobantes}`);
    doc.text(`Ticket promedio: ${report.ticket_promedio}`);
    doc.text(`Máx / Mín: ${report.estadisticas.venta_maxima} / ${report.estadisticas.venta_minima}`);
    doc.moveDown();

    doc.fontSize(10).text('Comprobante', 40, doc.y, { continued: true, width: 110 });
    doc.text('Fecha', { continued: true, width: 90 });
    doc.text('Cliente', { continued: true, width: 160 });
    doc.text('Total', { align: 'right' });
    doc.moveDown(0.4);

    report.detalle.forEach((d) => {
      if (doc.y > 750) doc.addPage();
      doc.fontSize(9).text(String(d.numero_formateado || '—'), 40, doc.y, { continued: true, width: 110 });
      doc.text(String(d.fecha || '').slice(0, 10), { continued: true, width: 90 });
      doc.text(String(d.cliente || '—').slice(0, 28), { continued: true, width: 160 });
      doc.text(String(Number(d.total_vendido).toFixed(2)), { align: 'right' });
    });

    doc.end();
    await new Promise((res) => doc.on('end', res));
    return Buffer.concat(chunks.map((c) => Buffer.from(c)));
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
        throw new BadRequestException('Formato de fecha inválido');
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
        throw new BadRequestException('Período inválido');
    }

    fechaFin.setHours(23, 59, 59, 999);
    return { fechaInicio, fechaFin };
  }
}

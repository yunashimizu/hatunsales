import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { ReportesRepository } from '../../repository/Repository/reportes.repository';
import { IReportesBussniees } from '../Ibussnies/IReportesBussniees';
import {
  VentasEstadisticas,
  VentasPorTipo,
  VentasReportDetalle,
  VentasReportResponse,
  VentasSeriePunto,
  VentasTopCliente,
  VentasTopProducto,
  VentasTopProductoCotizado,
} from '../../models/model/ventas-report.response';
import { CodigoError, cuerpoError } from '../../util/errores-operativos';
import { emisorConfig } from '../../config/emisor.config';
import {
  CabeceraReporte,
  REPORTE_TIPOS,
  claveTipoReporte,
  etiquetaPeriodo,
  etiquetaTipoReporte,
  nombreArchivoReporte,
} from '../../util/reporte-export';
import { generarReporteVentasExcel } from '../../util/documentos/reporte-ventas-excel';
import { generarReporteVentasPdf } from '../../util/documentos/reporte-ventas-pdf';
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

/** Cuántas filas de cada ranking: la pantalla y el PDF muestran pocas; el Excel lleva más. */
interface OpcionesReporte {
  limiteProductos?: number;
  limiteClientes?: number;
}

const LIMITE_PRODUCTOS_PANTALLA = 10;
const LIMITE_PRODUCTOS_EXPORT = 50;
const LIMITE_CLIENTES_PANTALLA = 5;
const LIMITE_CLIENTES_EXPORT = 20;

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

/** Identificador de `tipos_comprobante` del comprobante (NaN si no se pudo leer). */
function idTipoDe(c: ComprobanteReporte): number {
  return Number(c.tipo?.id_tipo ?? c.id_tipo);
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
  /** Tipo de comprobante (1 factura, 2 boleta, 7 nota de crédito, 8 nota de débito). */
  id_tipo?: number;
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
  /** Reparto por tipo de comprobante: siempre de TODOS los tipos, aunque se filtre por uno. */
  por_tipo: VentasPorTipo[];
  /** Tipo por el que se filtró; null = todos. */
  filtro_tipo: { id_tipo: number; nombre: string } | null;
  /** «vendidos»; «devueltos» cuando el reporte es solo de notas de crédito. */
  productos_modo: 'vendidos' | 'devueltos';
  /** Ranking neto de lo vendido (con el mismo filtro de tipo del reporte). */
  top_productos_vendidos: VentasTopProducto[];
  /** Ranking de las cotizaciones del periodo (no depende del tipo de comprobante). */
  top_productos_cotizados: VentasTopProductoCotizado[];
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

@Injectable()
export class ReportesBussnies implements IReportesBussniees {
  private readonly logger = new Logger(ReportesBussnies.name);

  constructor(private readonly repo: ReportesRepository) {}

  /**
   * Ventas netas del periodo (días de Lima). total_vendido = facturas y boletas + notas de
   * débito − notas de crédito; cantidad_comprobantes y ticket_promedio son de los
   * comprobantes de venta (facturas y boletas). La regla está en clasificarComprobanteReporte.
   */
  async reporteVentas(
    periodo: string,
    filters: ReportesFilters,
    opciones: OpcionesReporte = {},
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
    const limiteProductos = opciones.limiteProductos ?? LIMITE_PRODUCTOS_PANTALLA;
    const limiteClientes = opciones.limiteClientes ?? LIMITE_CLIENTES_PANTALLA;
    // Solo un id entero y positivo filtra por tipo; cualquier otra cosa (NaN, 0) es «todos los tipos».
    const idTipoFiltro =
      Number.isInteger(filters.id_tipo) && Number(filters.id_tipo) > 0 ? Number(filters.id_tipo) : undefined;

    // El tipo se filtra aquí y no en SQL: así se puede repartir lo vendido entre TODOS los tipos.
    const lista = await this.repo.obtenerVentasPorPeriodo(rango.desde, rango.hasta, {
      id_cliente: filters.id_cliente,
      id_moneda: filters.id_moneda,
    });

    const detalle: DetalleReporteVentas[] = [];
    const excluidos = { anulados: 0, con_error: 0, rechazados: 0 };
    const porTipo = new Map<number, { cantidad: number; total: Dinero }>();
    let ventas = Dinero.cero();
    let notasCredito = Dinero.cero();
    let notasDebito = Dinero.cero();
    let cantidadVentas = 0;
    let cantidadNc = 0;
    let cantidadNd = 0;

    for (const item of lista) {
      const clase = clasificarComprobanteReporte(item);
      const idTipo = idTipoDe(item);
      const importe = clase.cuenta ? Dinero.desdeBd(item.total) : Dinero.cero();

      if (clase.cuenta) {
        const clave = Number.isFinite(idTipo) ? idTipo : 0;
        const acumulado = porTipo.get(clave) ?? { cantidad: 0, total: Dinero.cero() };
        acumulado.cantidad += 1;
        acumulado.total = acumulado.total.sumar(clase.signo < 0 ? importe.negar() : importe);
        porTipo.set(clave, acumulado);
      }

      if (idTipoFiltro !== undefined && idTipo !== idTipoFiltro) continue;

      if (!clase.cuenta) {
        if (clase.motivo === 'anulado') excluidos.anulados += 1;
        else if (clase.motivo === 'error') excluidos.con_error += 1;
        else if (clase.motivo === 'rechazado') excluidos.rechazados += 1;
        continue;
      }

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
        id_tipo: Number.isFinite(idTipo) ? idTipo : undefined,
      });
    }

    const bruto = ventas.sumar(notasDebito);
    const neto = bruto.restar(notasCredito);
    const ticketPromedio = cantidadVentas > 0 ? Math.round(neto.centimos / cantidadVentas) / 100 : 0;
    const productos = await this.rankingsProductos(
      detalle.map((d) => d.id_comprobante),
      rango,
      idTipoFiltro,
      limiteProductos,
      filters.id_cliente,
    );

    return {
      periodo: periodoNormalizado,
      fecha_inicio: rango.desde.toISOString(),
      fecha_fin: rango.fin.toISOString(),
      cantidad_comprobantes: cantidadVentas,
      total_vendido: neto.aNumero(),
      ticket_promedio: ticketPromedio,
      detalle,
      estadisticas: this.construirEstadisticas(periodoNormalizado, detalle, excluidos, limiteClientes),
      total_bruto: bruto.aNumero(),
      notas_credito: { cantidad: cantidadNc, total: notasCredito.aNumero() },
      notas_debito: { cantidad: cantidadNd, total: notasDebito.aNumero() },
      excluidos,
      por_tipo: this.armarPorTipo(porTipo, idTipoFiltro),
      filtro_tipo:
        idTipoFiltro === undefined
          ? null
          : { id_tipo: idTipoFiltro, nombre: etiquetaTipoReporte(idTipoFiltro, true) },
      productos_modo: idTipoFiltro === TIPO_NOTA_CREDITO ? 'devueltos' : 'vendidos',
      top_productos_vendidos: productos.vendidos,
      top_productos_cotizados: productos.cotizados,
    };
  }

  /** Reparto por tipo en el orden factura, boleta, nota de crédito, nota de débito (y otros al final). */
  private armarPorTipo(
    porTipo: Map<number, { cantidad: number; total: Dinero }>,
    idTipoFiltro?: number,
  ): VentasPorTipo[] {
    const ids = new Set<number>(porTipo.keys());
    if (idTipoFiltro !== undefined) ids.add(idTipoFiltro);
    const orden = (id: number) => {
      const i = REPORTE_TIPOS.findIndex((t) => t.id_tipo === id);
      return i < 0 ? REPORTE_TIPOS.length : i;
    };
    return Array.from(ids)
      .sort((a, b) => orden(a) - orden(b) || a - b)
      .map((id) => {
        const acumulado = porTipo.get(id);
        return {
          id_tipo: id,
          tipo: etiquetaTipoReporte(id, true),
          cantidad: acumulado?.cantidad ?? 0,
          total: acumulado ? acumulado.total.aNumero() : 0,
        };
      });
  }

  /**
   * Rankings de productos del periodo: lo VENDIDO (neto, con el mismo filtro de tipo del
   * reporte) y lo COTIZADO (proformas no anuladas). Son un complemento: si alguna consulta
   * falla se registra y el reporte de ventas sale completo, con los rankings vacíos.
   */
  private async rankingsProductos(
    idsComprobante: Array<number | undefined>,
    rango: RangoReporte,
    idTipoFiltro: number | undefined,
    limite: number,
    idCliente?: number,
  ): Promise<{ vendidos: VentasTopProducto[]; cotizados: VentasTopProductoCotizado[] }> {
    const ids = idsComprobante.filter((id): id is number => typeof id === 'number');
    try {
      const [vendidos, cotizados] = await Promise.all([
        this.repo.obtenerProductosVendidos(ids, limite, idTipoFiltro === TIPO_NOTA_CREDITO),
        this.repo.obtenerProductosCotizados(rango.desde, rango.hasta, limite, idCliente),
      ]);
      return {
        vendidos: vendidos
          .map((f) => ({
            id_producto: f.id_producto === null || f.id_producto === undefined ? null : Number(f.id_producto),
            codigo: String(f.codigo ?? '').trim(),
            producto: String(f.descripcion ?? '').trim() || 'Producto sin descripción',
            cantidad: Number(f.cantidad ?? 0),
            total: Dinero.desdeBd(f.total).aNumero(),
            comprobantes: Number(f.comprobantes ?? 0),
          }))
          .filter((p) => p.cantidad > 0 || p.total > 0),
        cotizados: cotizados.map((f) => ({
          id_producto: f.id_producto === null || f.id_producto === undefined ? null : Number(f.id_producto),
          sku: String(f.sku ?? '').trim(),
          producto: String(f.descripcion ?? '').trim() || 'Producto sin descripción',
          cotizaciones: Number(f.cotizaciones ?? 0),
          cantidad: Number(f.cantidad ?? 0),
          total: Dinero.desdeBd(f.total).aNumero(),
          convertidas: Number(f.convertidas ?? 0),
        })),
      };
    } catch (error) {
      this.logger.warn(
        `No se pudieron calcular los rankings de productos del reporte: ${error instanceof Error ? error.message : String(error)}`,
      );
      return { vendidos: [], cotizados: [] };
    }
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

  /** Excel profesional del reporte (varias hojas). Respeta periodo, rango y tipo de comprobante. */
  async exportVentasExcel(periodo: string, filters: ReportesFilters = {}): Promise<{ buffer: Buffer; filename: string }> {
    try {
      const report = await this.reporteVentas(periodo, filters, {
        limiteProductos: LIMITE_PRODUCTOS_EXPORT,
        limiteClientes: LIMITE_CLIENTES_EXPORT,
      });
      const buffer = await generarReporteVentasExcel({ cabecera: this.armarCabecera(report), reporte: report });
      return {
        buffer,
        filename: nombreArchivoReporte('ventas', report.periodo, 'xlsx', claveTipoReporte(report.filtro_tipo?.id_tipo)),
      };
    } catch (e) {
      if (e instanceof BadRequestException) throw e;
      this.logger.error(`No se pudo generar el Excel del reporte de ventas: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
      throw new BadRequestException(
        cuerpoError(
          CodigoError.REPORTE_EXPORT_FALLIDA,
          'No se pudo generar el Excel del reporte de ventas',
        ),
      );
    }
  }

  /** PDF profesional del reporte. Respeta periodo, rango y tipo de comprobante. */
  async exportVentasPdf(periodo: string, filters: ReportesFilters = {}): Promise<{ buffer: Buffer; filename: string }> {
    try {
      const report = await this.reporteVentas(periodo, filters, {
        limiteProductos: LIMITE_PRODUCTOS_PANTALLA,
        limiteClientes: LIMITE_CLIENTES_PANTALLA * 2,
      });
      const buffer = await generarReporteVentasPdf({ cabecera: this.armarCabecera(report), reporte: report });
      return {
        buffer,
        filename: nombreArchivoReporte('ventas', report.periodo, 'pdf', claveTipoReporte(report.filtro_tipo?.id_tipo)),
      };
    } catch (e) {
      if (e instanceof BadRequestException) throw e;
      this.logger.error(`No se pudo generar el PDF del reporte de ventas: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
      throw new BadRequestException(
        cuerpoError(
          CodigoError.REPORTE_EXPORT_FALLIDA,
          'No se pudo generar el PDF del reporte de ventas',
        ),
      );
    }
  }

  private armarCabecera(report: ReporteVentasNeto): CabeceraReporte {
    // Días y hora de Lima: el servidor corre en UTC.
    const fechaInicio = ymdLegible(aFechaLima(new Date(report.fecha_inicio)));
    const fechaFin = ymdLegible(aFechaLima(new Date(report.fecha_fin)));
    const tipo = report.filtro_tipo ? report.filtro_tipo.nombre : 'Todos los comprobantes';
    return {
      empresa: emisorConfig.razon_social || 'HATUNSALES S.A.C.',
      ruc: emisorConfig.ruc || '—',
      direccion: [emisorConfig.direccion, emisorConfig.ubicacion].filter(Boolean).join(' · '),
      titulo: report.filtro_tipo ? `Reporte de ventas · ${tipo}` : 'Reporte de ventas',
      periodo: report.periodo,
      fechaInicio,
      fechaFin,
      generadoEl: fechaHoraLimaLegible(new Date()),
      nota:
        'Ventas netas: facturas y boletas más notas de débito, menos notas de crédito. ' +
        'No incluye anulados, rechazados por SUNAT, con error ni pruebas BETA.',
      filtros: [
        { etiqueta: 'Periodo', valor: etiquetaPeriodo(report.periodo) },
        { etiqueta: 'Rango', valor: `${fechaInicio} — ${fechaFin}` },
        { etiqueta: 'Tipo', valor: tipo },
      ],
    };
  }

  private construirEstadisticas(
    periodo: string,
    detalle: DetalleReporteVentas[],
    excluidos: { anulados: number; con_error: number; rechazados: number },
    limiteClientes = LIMITE_CLIENTES_PANTALLA,
  ): VentasEstadisticas {
    // Máximo, mínimo y días con venta miran solo facturas y boletas: una nota no es una venta.
    const ventas = detalle.filter((d) => d.tipo_documento === 'venta');
    const totales = ventas.map((d) => Number(d.total_vendido ?? 0));
    const ventaMaxima = totales.length ? Math.max(...totales) : 0;
    const ventaMinima = totales.length ? Math.min(...totales) : 0;

    const serie = this.agruparSerie(periodo, detalle);
    const topClientes = this.topClientes(detalle, limiteClientes);
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

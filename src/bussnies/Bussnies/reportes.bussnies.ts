import { Injectable, BadRequestException, Logger, Optional, ServiceUnavailableException } from '@nestjs/common';
import { FilaComprobanteRvie, ReportesRepository } from '../../repository/Repository/reportes.repository';
import { ConfiguracionRepository } from '../../repository/Repository/configuracion.repository';
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
import { obtenerLogoEmisor } from '../../util/documentos/logo-emisor';
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
  horaLima,
  hoyLima,
  inicioAnioLima,
  inicioMesLima,
  inicioQuincenaLima,
  inicioSemanaLima,
  rangoDiaLima,
  rangoFechasLima,
  diasEntreYmd,
  sumarDiasYmd,
  validarFechaYmd,
} from '../../util/fecha-lima';
import { TIPO_NOTA_CREDITO, TIPO_NOTA_DEBITO } from '../../util/fiscal/tipos-comprobante';
import { Dinero } from '../../caja/dominio/dinero';
import {
  AVISO_ESTRUCTURA_RVIE,
  construirCsvRvie,
  construirTxtRvie,
  FilaRvie,
  nombreArchivoRvie,
  nombreCsvRvie,
  periodoRvieValido,
} from '../../util/fiscal/rvie';
import { tipoComprobanteSunat } from '../../util/fiscal/tipos-comprobante';

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

/** Lo que quedó fuera del Registro de Ventas (SIRE) y por qué: para que el contador sepa qué esperar. */
export interface ResumenRegistroVentas {
  periodo: string;
  /** Filas del archivo (aceptados y anulados). */
  filas: number;
  anulados: number;
  /** Facturas y boletas, notas de crédito y de débito del archivo. */
  por_tipo: { factura: number; boleta: number; nota_credito: number; nota_debito: number };
  /** Comprobantes en dólares: el sistema no guarda el tipo de cambio y esa columna queda vacía. */
  en_dolares: number;
  omitidos: { pruebas: number; con_error: number; rechazados: number; sin_aceptar: number; anulados_sin_sunat: number };
  aviso: string;
}

export interface RegistroVentasArchivo {
  contenido: string;
  nombre: string;
  tipo: string;
  resumen: ResumenRegistroVentas;
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

export interface VentasPorHora {
  /** Hora de Lima, 0..23. */
  hora: number;
  /** Ventas netas en soles (2 decimales). */
  total: number;
  /** Cantidad de comprobantes de venta (facturas y boletas). */
  ventas: number;
}

export interface VentasPorHoraResponse {
  fecha: string;
  horas: VentasPorHora[];
  /** El mismo día de la semana anterior (fecha − 7 días). */
  comparacion: { fecha: string; horas: VentasPorHora[] };
}

interface RangoReporte {
  /** 00:00 de Lima del primer día (inclusivo). */
  desde: Date;
  /** 00:00 de Lima del día siguiente al último (exclusivo, para el SQL). */
  hasta: Date;
  /** 23:59:59.999 de Lima del último día (para mostrar). */
  fin: Date;
}

// ── Fase F: rentabilidad, estancados, mapa de calor ─────────────────────────

export interface FilaRentabilidad {
  id_producto: number | null;
  codigo: string;
  producto: string;
  categoria: string;
  cantidad: number;
  /** Total cobrado, con IGV. */
  ingreso: number;
  /** Venta sin IGV: la base del margen. */
  ingreso_sin_igv: number;
  costo: number;
  /** ingreso_sin_igv − costo (soles). */
  margen: number;
  /** margen / ingreso_sin_igv × 100, 2 decimales; null si la venta sin IGV es 0. */
  margen_pct: number | null;
  /** Día de Lima del último comprobante de venta del rango (null si solo hubo notas de crédito). */
  ultima_venta: string | null;
  /** El producto no tiene precio de compra registrado: su costo y su margen no son confiables. */
  sin_costo: boolean;
}

export interface FilaRentabilidadCategoria {
  categoria: string;
  productos: number;
  cantidad: number;
  ingreso: number;
  ingreso_sin_igv: number;
  costo: number;
  margen: number;
  margen_pct: number | null;
}

export interface RentabilidadResponse {
  fecha_inicio: string;
  fecha_fin: string;
  productos: FilaRentabilidad[];
  categorias: FilaRentabilidadCategoria[];
  totales: { productos: number; cantidad: number; ingreso: number; ingreso_sin_igv: number; costo: number; margen: number; margen_pct: number | null };
  /** true si hubo más productos de los que se devuelven (se muestran los de mayor ingreso). */
  recortado: boolean;
  /** Cómo se calculó el costo, para mostrarlo junto a la tabla. */
  nota_costo: string;
}

export interface FilaEstancado {
  id_producto: number;
  codigo: string;
  producto: string;
  categoria: string;
  stock: number;
  precio_compra: number;
  /** stock × precio de compra vigente. */
  valorizado: number;
  /** Día de Lima de la última venta; null = nunca se vendió. */
  ultima_venta: string | null;
  /** Días desde la última venta (null si nunca se vendió). */
  dias_sin_venta: number | null;
}

export interface EstancadosResponse {
  dias: number;
  productos: FilaEstancado[];
  total_productos: number;
  valorizado_total: number;
  recortado: boolean;
}

export interface CeldaMapaCalor {
  /** 0 = domingo … 6 = sábado. */
  dia: number;
  /** Hora de Lima 0..23. */
  hora: number;
  total: number;
  ventas: number;
}

export interface MapaCalorResponse {
  desde: string;
  hasta: string;
  semanas: number;
  /** Siempre las 168 celdas (7 días × 24 horas), con 0 donde no hubo ventas. */
  celdas: CeldaMapaCalor[];
  /** La franja de dos horas seguidas con más ventas netas; null si no hubo ventas. */
  mejor: { dia: number; hora_inicio: number; hora_fin: number; total: number } | null;
}

export interface ResumenDia {
  fecha: string;
  /** Ventas netas del día en soles. */
  total: number;
  /** Cantidad de facturas y boletas. */
  ventas: number;
  ticket_promedio: number;
}

const LIMITE_RENTABILIDAD = 500;
const LIMITE_ESTANCADOS = 200;
const DIAS_ESTANCADO_VALIDOS = [30, 60, 90];
const SEMANAS_MAPA_MIN = 1;
const SEMANAS_MAPA_MAX = 12;
export const NOTA_COSTO_RENTABILIDAD =
  'Margen = venta sin IGV − costo. El costo es la cantidad vendida por el precio de compra actual de cada producto ' +
  '(el sistema no guarda el costo de cada venta). Si los precios de compra incluyen IGV, el margen real es algo mayor.';

/** Día de la semana (0 = domingo) de un 'YYYY-MM-DD', sin depender de la zona del servidor. */
function diaSemanaYmd(ymd: string): number {
  return new Date(Date.UTC(Number(ymd.slice(0, 4)), Number(ymd.slice(5, 7)) - 1, Number(ymd.slice(8, 10)))).getUTCDay();
}

function porcentaje(margen: Dinero, ingreso: Dinero): number | null {
  return ingreso.esCero() ? null : Math.round((margen.centimos / ingreso.centimos) * 10000) / 100;
}

function ultimaVentaLima(valor: Date | string | null | undefined): string | null {
  if (!valor) return null;
  const d = new Date(valor);
  return Number.isNaN(d.getTime()) ? null : aFechaLima(d);
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

/** 'YYYY-MM-DD' desde una fecha guardada como AAAA-MM-DD o DD-MM-AAAA (vacío si no se entiende). */
function ymdDe(valor: unknown): string {
  const texto = String(valor ?? '').trim().slice(0, 10);
  if (esFechaYmd(texto)) return texto;
  const dmy = PATRON_DMY.exec(texto);
  return dmy && esFechaYmd(`${dmy[3]}-${dmy[2]}-${dmy[1]}`) ? `${dmy[3]}-${dmy[2]}-${dmy[1]}` : '';
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

  constructor(
    private readonly repo: ReportesRepository,
    /** Para leer el «Logo para documentos» del panel; sin él se usa el de la configuración de entorno. */
    @Optional() private readonly config?: ConfiguracionRepository,
  ) {}

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

  // ── Registro de ventas para el SIRE (RVIE) ─────────────────────────────────

  /** TXT del Registro de Ventas e Ingresos Electrónico del mes `periodo` (AAAAMM). Ver util/fiscal/rvie.ts. */
  async registroVentasRvie(periodo: string): Promise<RegistroVentasArchivo> {
    const { filas, resumen, datos } = await this.armarRegistroVentas(periodo);
    return {
      contenido: construirTxtRvie(filas, datos),
      nombre: nombreArchivoRvie(datos.ruc, datos.periodo, filas.length > 0),
      tipo: 'text/plain; charset=utf-8',
      resumen,
    };
  }

  /** Las mismas filas en CSV con cabeceras, para que el contador las revise en Excel. */
  async registroVentasRvieCsv(periodo: string): Promise<RegistroVentasArchivo> {
    const { filas, resumen, datos } = await this.armarRegistroVentas(periodo);
    return {
      contenido: construirCsvRvie(filas, datos),
      nombre: nombreCsvRvie(datos.ruc, datos.periodo),
      tipo: 'text/csv; charset=utf-8',
      resumen,
    };
  }

  private async armarRegistroVentas(periodo: string): Promise<{
    filas: FilaRvie[];
    resumen: ResumenRegistroVentas;
    datos: { ruc: string; razonSocial: string; periodo: string };
  }> {
    const texto = String(periodo ?? '').trim();
    if (!periodoRvieValido(texto)) {
      throw new BadRequestException(cuerpoError(CodigoError.REPORTE_PERIODO_INVALIDO, 'Periodo inválido: use el mes en formato AAAAMM (por ejemplo 202610).'));
    }
    if (texto > hoyLima().slice(0, 7).replace('-', '')) {
      throw new BadRequestException(cuerpoError(CodigoError.REPORTE_PERIODO_INVALIDO, 'Ese mes todavía no ha empezado: elija el mes actual o uno anterior.'));
    }

    let lista: FilaComprobanteRvie[];
    try {
      lista = await this.repo.obtenerComprobantesRvie(texto);
    } catch (error) {
      this.logger.error(`No se pudo leer el registro de ventas ${texto}: ${error instanceof Error ? error.message : String(error)}`);
      throw new ServiceUnavailableException('No se pudo leer el registro de ventas. Aplique las migraciones de notas de crédito (sql/fase9_sunat_directo.sql) y vuelva a intentar.');
    }

    const resumen: ResumenRegistroVentas = {
      periodo: texto,
      filas: 0,
      anulados: 0,
      por_tipo: { factura: 0, boleta: 0, nota_credito: 0, nota_debito: 0 },
      en_dolares: 0,
      omitidos: { pruebas: 0, con_error: 0, rechazados: 0, sin_aceptar: 0, anulados_sin_sunat: 0 },
      aviso: AVISO_ESTRUCTURA_RVIE,
    };
    const filas: FilaRvie[] = [];
    for (const c of lista) {
      const fecha = diaLimaComprobante(c);
      if (fecha.slice(0, 4) + fecha.slice(5, 7) !== texto) continue;
      const decision = this.decidirParaRvie(c);
      if (decision.omitir) {
        resumen.omitidos[decision.omitir] += 1;
        continue;
      }
      const tipo = tipoComprobanteSunat(c.id_tipo);
      if (!tipo) continue;
      const fila = this.filaRvie(c, tipo, fecha, decision.estado);
      filas.push(fila);
      resumen.filas += 1;
      if (fila.estado === 'anulado') resumen.anulados += 1;
      if (fila.moneda === 'USD') resumen.en_dolares += 1;
      resumen.por_tipo[tipo === '01' ? 'factura' : tipo === '03' ? 'boleta' : tipo === '07' ? 'nota_credito' : 'nota_debito'] += 1;
    }
    filas.sort((a, b) => a.fecha.localeCompare(b.fecha) || a.tipo.localeCompare(b.tipo) || a.serie.localeCompare(b.serie) || a.numero - b.numero);

    return { filas, resumen, datos: { ruc: emisorConfig.ruc, razonSocial: emisorConfig.razon_social, periodo: texto } };
  }

  /**
   * Qué entra al registro: lo que SUNAT ya tiene aceptado y lo que dio de baja (en cero). Quedan fuera las pruebas BETA,
   * los errores, los rechazados, lo que aún no aceptó SUNAT y lo anulado solo en el sistema (SUNAT nunca lo recibió).
   * Una factura "anulada" con nota de crédito sigue aceptada en SUNAT: entra completa y su nota entra en negativo.
   */
  private decidirParaRvie(c: FilaComprobanteRvie):
    | { omitir: keyof ResumenRegistroVentas['omitidos'] }
    | { omitir?: undefined; estado: 'aceptado' | 'anulado' } {
    const estado = String(c.estado ?? '').trim().toLowerCase();
    const estadoSunat = String(c.estado_sunat ?? '').trim().toUpperCase();
    if (String(c.ambiente_fiscal ?? '').trim().toLowerCase() === 'beta') return { omitir: 'pruebas' };
    if (estado === 'error') return { omitir: 'con_error' };
    if (estadoSunat === 'RECHAZADO') return { omitir: 'rechazados' };
    if (estadoSunat === 'ANULADO') return { estado: 'anulado' };
    const historico = !c.ambiente_fiscal && !estadoSunat && c.aceptada_sunat !== false;
    const aceptado = c.aceptada_sunat === true || estadoSunat === 'ACEPTADO' || estadoSunat === 'ACEPTADO_OBS' || historico;
    if (!aceptado) return { omitir: c.anulado === true || estado === 'anulado' ? 'anulados_sin_sunat' : 'sin_aceptar' };
    return { estado: 'aceptado' };
  }

  private filaRvie(c: FilaComprobanteRvie, tipo: string, fecha: string, estado: 'aceptado' | 'anulado'): FilaRvie {
    const n = (v: unknown) => Number(v ?? 0) || 0;
    return {
      fecha,
      vencimiento: ymdDe(c.fecha_de_vencimiento),
      tipo,
      serie: String(c.serie ?? ''),
      numero: n(c.numero),
      clienteTipoDoc: String(c.cliente_tipo_doc ?? ''),
      clienteNumeroDoc: String(c.cliente_numero_doc ?? ''),
      clienteNombre: String(c.cliente_denominacion ?? ''),
      gravada: n(c.total_gravada),
      igv: n(c.total_igv),
      exonerada: n(c.total_exonerada),
      inafecta: n(c.total_inafecta),
      total: n(c.total),
      moneda: n(c.id_moneda) === 2 ? 'USD' : 'PEN',
      modificadoFecha: ymdDe(c.fecha_doc_modificado),
      modificadoTipo: String(c.doc_modificado_tipo ?? ''),
      modificadoSerie: String(c.doc_modificado_serie ?? ''),
      modificadoNumero: c.doc_modificado_numero === null || c.doc_modificado_numero === undefined ? null : n(c.doc_modificado_numero),
      estado,
    };
  }

  /**
   * Ventas netas por hora de Lima de un día (`fecha` 'YYYY-MM-DD'; por omisión, hoy en Lima) y
   * del mismo día de la semana anterior (fecha − 7 días). Siempre 24 horas (0 si no hubo
   * ventas). Misma regla que reporteVentas (clasificarComprobanteReporte): factura, boleta y
   * nota de débito suman, la nota de crédito resta; no cuentan anulados, errores, rechazados
   * ni pruebas BETA. `ventas` = cantidad de comprobantes de venta (facturas y boletas).
   * La hora es la del registro (creado_en) en Lima: el servidor corre en UTC. Solo lectura.
   */
  async ventasPorHora(fecha?: string): Promise<VentasPorHoraResponse> {
    const texto = typeof fecha === 'string' ? fecha.trim() : '';
    if (texto && !esFechaYmd(texto)) {
      throw new BadRequestException(
        cuerpoError(CodigoError.REPORTE_FECHA_INVALIDA, 'Formato de fecha inválido en fecha: use AAAA-MM-DD'),
      );
    }
    const dia = texto || hoyLima();
    const anterior = sumarDiasYmd(dia, -7);

    const [actual, comparacion] = await Promise.all([this.horasDelDia(dia), this.horasDelDia(anterior)]);
    return { fecha: dia, horas: actual, comparacion: { fecha: anterior, horas: comparacion } };
  }

  private async horasDelDia(ymd: string): Promise<VentasPorHora[]> {
    const { desde, hasta } = rangoDiaLima(ymd);
    const lista = await this.repo.obtenerVentasPorPeriodo(desde, hasta, {});
    const totales = Array.from({ length: 24 }, () => Dinero.cero());
    const cantidades = new Array<number>(24).fill(0);

    for (const item of lista) {
      const clase = clasificarComprobanteReporte(item);
      if (!clase.cuenta) continue;
      const instante = item.creado_en ? new Date(item.creado_en) : null;
      if (!instante || Number.isNaN(instante.getTime()) || aFechaLima(instante) !== ymd) continue;
      const hora = Number(horaLima(instante).slice(0, 2));
      const importe = Dinero.desdeBd(item.total);
      totales[hora] = totales[hora].sumar(clase.signo < 0 ? importe.negar() : importe);
      if (clase.tipo === 'venta') cantidades[hora] += 1;
    }

    return totales.map((total, hora) => ({ hora, total: total.aNumero(), ventas: cantidades[hora] }));
  }

  /** Ventas netas, cantidad de facturas/boletas y ticket promedio de un día de Lima (resumen diario). */
  async resumenDia(ymd: string): Promise<ResumenDia> {
    const horas = await this.horasDelDia(ymd);
    const total = horas.reduce((acc, h) => acc.sumar(Dinero.desdeNumeroRedondeado(h.total)), Dinero.cero());
    const ventas = horas.reduce((acc, h) => acc + h.ventas, 0);
    return {
      fecha: ymd,
      total: total.aNumero(),
      ventas,
      ticket_promedio: ventas > 0 ? Math.round(total.centimos / ventas) / 100 : 0,
    };
  }

  /**
   * Rentabilidad por producto en el rango del reporte (mismo criterio de comprobantes que reporteVentas: las notas de
   * crédito restan; no cuentan anulados, errores, rechazados ni pruebas BETA). Por producto: cantidad, ingreso, costo
   * (cantidad × precio de compra vigente, ver NOTA_COSTO_RENTABILIDAD), margen y última venta; y el mismo reparto por
   * categoría. Sin fechas, el mes en curso. Solo lectura.
   */
  async rentabilidadProductos(filters: { fecha_inicio?: string; fecha_fin?: string } = {}): Promise<RentabilidadResponse> {
    const rango = this.resolverRango('mensual', filters);
    const lista = await this.repo.obtenerVentasPorPeriodo(rango.desde, rango.hasta, {});
    const ids = lista.filter((c) => clasificarComprobanteReporte(c).cuenta).map((c) => c.id_comprobante);
    const filas = await this.repo.obtenerRentabilidadProductos(ids, LIMITE_RENTABILIDAD + 1);

    const productos: FilaRentabilidad[] = filas
      .map((f) => {
        const ingreso = Dinero.desdeBd(f.ingreso);
        const sinIgv = Dinero.desdeBd(f.ingreso_sin_igv ?? f.ingreso);
        const costo = Dinero.desdeBd(f.costo);
        const margen = sinIgv.restar(costo);
        return {
          id_producto: f.id_producto === null || f.id_producto === undefined ? null : Number(f.id_producto),
          codigo: String(f.codigo ?? '').trim(),
          producto: String(f.producto ?? '').trim() || 'Producto sin descripción',
          categoria: String(f.categoria ?? '').trim() || 'Sin categoría',
          cantidad: Number(f.cantidad ?? 0),
          ingreso: ingreso.aNumero(),
          ingreso_sin_igv: sinIgv.aNumero(),
          costo: costo.aNumero(),
          margen: margen.aNumero(),
          margen_pct: porcentaje(margen, sinIgv),
          ultima_venta: ultimaVentaLima(f.ultima_venta),
          sin_costo: f.sin_costo === true,
        };
      })
      .filter((p) => p.cantidad !== 0 || p.ingreso !== 0);
    const recortado = productos.length > LIMITE_RENTABILIDAD;
    const visibles = productos.slice(0, LIMITE_RENTABILIDAD);

    const porCategoria = new Map<string, { productos: number; cantidad: number; ingreso: Dinero; sinIgv: Dinero; costo: Dinero }>();
    let ingresoTotal = Dinero.cero();
    let sinIgvTotal = Dinero.cero();
    let costoTotal = Dinero.cero();
    let cantidadTotal = 0;
    for (const p of visibles) {
      const ingreso = Dinero.desdeNumeroRedondeado(p.ingreso);
      const sinIgv = Dinero.desdeNumeroRedondeado(p.ingreso_sin_igv);
      const costo = Dinero.desdeNumeroRedondeado(p.costo);
      const acc = porCategoria.get(p.categoria) ?? { productos: 0, cantidad: 0, ingreso: Dinero.cero(), sinIgv: Dinero.cero(), costo: Dinero.cero() };
      acc.productos += 1;
      acc.cantidad += p.cantidad;
      acc.ingreso = acc.ingreso.sumar(ingreso);
      acc.sinIgv = acc.sinIgv.sumar(sinIgv);
      acc.costo = acc.costo.sumar(costo);
      porCategoria.set(p.categoria, acc);
      ingresoTotal = ingresoTotal.sumar(ingreso);
      sinIgvTotal = sinIgvTotal.sumar(sinIgv);
      costoTotal = costoTotal.sumar(costo);
      cantidadTotal += p.cantidad;
    }
    const categorias: FilaRentabilidadCategoria[] = Array.from(porCategoria.entries())
      .map(([categoria, a]) => {
        const margen = a.sinIgv.restar(a.costo);
        return {
          categoria,
          productos: a.productos,
          cantidad: a.cantidad,
          ingreso: a.ingreso.aNumero(),
          ingreso_sin_igv: a.sinIgv.aNumero(),
          costo: a.costo.aNumero(),
          margen: margen.aNumero(),
          margen_pct: porcentaje(margen, a.sinIgv),
        };
      })
      .sort((a, b) => b.ingreso_sin_igv - a.ingreso_sin_igv || a.categoria.localeCompare(b.categoria, 'es'));
    const margenTotal = sinIgvTotal.restar(costoTotal);

    return {
      fecha_inicio: aFechaLima(rango.desde),
      fecha_fin: aFechaLima(rango.fin),
      productos: visibles,
      categorias,
      totales: {
        productos: visibles.length,
        cantidad: cantidadTotal,
        ingreso: ingresoTotal.aNumero(),
        ingreso_sin_igv: sinIgvTotal.aNumero(),
        costo: costoTotal.aNumero(),
        margen: margenTotal.aNumero(),
        margen_pct: porcentaje(margenTotal, sinIgvTotal),
      },
      recortado,
      nota_costo: NOTA_COSTO_RENTABILIDAD,
    };
  }

  /**
   * Productos activos con existencias que no se venden hace `dias` días (30, 60 o 90; otro valor se lleva al más cercano
   * permitido) o que nunca se vendieron y ya tienen esa antigüedad. Los más caros de tener parados primero. Solo lectura.
   */
  async productosEstancados(dias?: number | string): Promise<EstancadosResponse> {
    const pedido = Number(dias);
    const objetivo = Number.isFinite(pedido) && pedido > 0 ? pedido : 30;
    const valido = DIAS_ESTANCADO_VALIDOS.reduce(
      (mejor, d) => (Math.abs(d - objetivo) < Math.abs(mejor - objetivo) ? d : mejor),
      DIAS_ESTANCADO_VALIDOS[0],
    );
    const ahora = new Date();
    const corte = new Date(ahora.getTime() - valido * 86_400_000);
    const filas = await this.repo.obtenerProductosEstancados(corte, LIMITE_ESTANCADOS);
    const hoy = hoyLima(ahora);

    const productos: FilaEstancado[] = filas.map((f) => {
      const stock = Number(f.stock ?? 0);
      const precio = Dinero.desdeBd(f.precio_compra);
      const ultima = ultimaVentaLima(f.ultima_venta);
      return {
        id_producto: Number(f.id_producto),
        codigo: String(f.codigo ?? '').trim(),
        producto: String(f.producto ?? '').trim() || 'Producto sin nombre',
        categoria: String(f.categoria ?? '').trim() || 'Sin categoría',
        stock,
        precio_compra: precio.aNumero(),
        valorizado: Dinero.desdeNumeroRedondeado(stock * precio.aNumero()).aNumero(),
        ultima_venta: ultima,
        dias_sin_venta: ultima ? diasEntreYmd(ultima, hoy) : null,
      };
    });
    const total = filas.length ? Number(filas[0].total_filas ?? filas.length) : 0;
    const valorizado = productos.reduce((acc, p) => acc.sumar(Dinero.desdeNumeroRedondeado(p.valorizado)), Dinero.cero());
    return {
      dias: valido,
      productos,
      total_productos: total,
      valorizado_total: valorizado.aNumero(),
      recortado: total > productos.length,
    };
  }

  /**
   * Mapa de calor hora × día de la semana: ventas netas (misma regla que ventasPorHora) de las últimas `semanas`
   * semanas completas de 7 días terminando hoy (hora y día de Lima). `mejor` es la franja de dos horas seguidas, dentro
   * de un mismo día, con más ventas. Solo lectura.
   */
  async ventasMapaCalor(semanas?: number | string): Promise<MapaCalorResponse> {
    const pedido = Math.trunc(Number(semanas));
    const n = Number.isFinite(pedido) && pedido >= SEMANAS_MAPA_MIN ? Math.min(pedido, SEMANAS_MAPA_MAX) : 4;
    const hasta = hoyLima();
    const desde = sumarDiasYmd(hasta, -(n * 7 - 1));
    const rango = rangoFechasLima(desde, hasta);
    const lista = await this.repo.obtenerVentasPorPeriodo(rango.desde, rango.hasta, {});

    const totales = Array.from({ length: 7 * 24 }, () => Dinero.cero());
    const cantidades = new Array<number>(7 * 24).fill(0);
    for (const item of lista) {
      const clase = clasificarComprobanteReporte(item);
      if (!clase.cuenta) continue;
      const instante = item.creado_en ? new Date(item.creado_en) : null;
      if (!instante || Number.isNaN(instante.getTime())) continue;
      const dia = aFechaLima(instante);
      if (dia < desde || dia > hasta) continue;
      const celda = diaSemanaYmd(dia) * 24 + Number(horaLima(instante).slice(0, 2));
      const importe = Dinero.desdeBd(item.total);
      totales[celda] = totales[celda].sumar(clase.signo < 0 ? importe.negar() : importe);
      if (clase.tipo === 'venta') cantidades[celda] += 1;
    }

    let mejor: MapaCalorResponse['mejor'] = null;
    let mejorCentimos = 0;
    for (let dia = 0; dia < 7; dia++) {
      for (let hora = 0; hora < 23; hora++) {
        const suma = totales[dia * 24 + hora].centimos + totales[dia * 24 + hora + 1].centimos;
        if (suma > mejorCentimos) {
          mejorCentimos = suma;
          mejor = { dia, hora_inicio: hora, hora_fin: hora + 2, total: suma / 100 };
        }
      }
    }

    return {
      desde,
      hasta,
      semanas: n,
      celdas: totales.map((t, i) => ({ dia: Math.floor(i / 24), hora: i % 24, total: t.aNumero(), ventas: cantidades[i] })),
      mejor,
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

  /** Excel profesional del reporte (varias hojas). Respeta periodo, rango y tipo de comprobante. */
  async exportVentasExcel(periodo: string, filters: ReportesFilters = {}): Promise<{ buffer: Buffer; filename: string }> {
    try {
      const report = await this.reporteVentas(periodo, filters, {
        limiteProductos: LIMITE_PRODUCTOS_EXPORT,
        limiteClientes: LIMITE_CLIENTES_EXPORT,
      });
      const buffer = await generarReporteVentasExcel({ cabecera: await this.armarCabecera(report), reporte: report });
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
      const buffer = await generarReporteVentasPdf({ cabecera: await this.armarCabecera(report), reporte: report });
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

  private async armarCabecera(report: ReporteVentasNeto): Promise<CabeceraReporte> {
    // Días y hora de Lima: el servidor corre en UTC.
    const fechaInicio = ymdLegible(aFechaLima(new Date(report.fecha_inicio)));
    const fechaFin = ymdLegible(aFechaLima(new Date(report.fecha_fin)));
    const tipo = report.filtro_tipo ? report.filtro_tipo.nombre : 'Todos los comprobantes';
    // El logo es decorativo: obtenerLogoEmisor no lanza (devuelve null si no se puede leer).
    const configurado = await this.config
      ?.obtenerVarias(['emisor_logo_url'])
      .then((valores) => String(valores.emisor_logo_url ?? '').trim())
      .catch(() => '');
    const logo = await obtenerLogoEmisor(configurado || emisorConfig.logo_url).catch(() => null);
    return {
      logo,
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

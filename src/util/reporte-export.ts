/**
 * Formato y metadatos compartidos para exportes de reportes (Excel / PDF).
 * Solo presentación; la lógica de datos sigue en ReportesBussnies.
 */
import type { ReporteVentasNeto } from '../bussnies/Bussnies/reportes.bussnies';
import { hoyLima } from './fecha-lima';
import {
  TIPO_BOLETA,
  TIPO_FACTURA,
  TIPO_NOTA_CREDITO,
  TIPO_NOTA_DEBITO,
} from './fiscal/tipos-comprobante';

export const REPORTE_COLUMNAS_DETALLE = [
  { key: 'comprobante', label: 'Comprobante', excelWidth: 18, pdfWidth: 90 },
  { key: 'fecha', label: 'Fecha', excelWidth: 12, pdfWidth: 70 },
  { key: 'cliente', label: 'Cliente', excelWidth: 32, pdfWidth: 150 },
  { key: 'documento', label: 'Documento', excelWidth: 14, pdfWidth: 70 },
  { key: 'estado', label: 'Estado', excelWidth: 12, pdfWidth: 55 },
  { key: 'total', label: 'Total', excelWidth: 14, pdfWidth: 65 },
] as const;

export type FilaDetalleReporte = {
  comprobante: string;
  fecha: string;
  cliente: string;
  documento: string;
  estado: string;
  total: number;
};

export type CabeceraReporte = {
  empresa: string;
  ruc: string;
  direccion?: string;
  titulo: string;
  periodo: string;
  fechaInicio: string;
  fechaFin: string;
  generadoEl: string;
  nota?: string;
  /** Filtros aplicados (periodo, rango, tipo…), listos para rotularlos en el documento. */
  filtros?: Array<{ etiqueta: string; valor: string }>;
};

/** Todo lo que necesitan los generadores de Excel y PDF del reporte de ventas. */
export interface DatosReporteVentas {
  cabecera: CabeceraReporte;
  reporte: ReporteVentasNeto;
}

/** Tipos de comprobante que distingue el reporte (tabla `tipos_comprobante`). */
export const REPORTE_TIPOS = [
  { id_tipo: TIPO_FACTURA, clave: 'facturas', singular: 'Factura', plural: 'Facturas' },
  { id_tipo: TIPO_BOLETA, clave: 'boletas', singular: 'Boleta', plural: 'Boletas' },
  { id_tipo: TIPO_NOTA_CREDITO, clave: 'notas-de-credito', singular: 'Nota de crédito', plural: 'Notas de crédito' },
  { id_tipo: TIPO_NOTA_DEBITO, clave: 'notas-de-debito', singular: 'Nota de débito', plural: 'Notas de débito' },
] as const;

/** «Boleta» / «Boletas»; un tipo que el reporte no conoce se rotula «Otros». */
export function etiquetaTipoReporte(idTipo?: number | null, plural = false): string {
  const tipo = REPORTE_TIPOS.find((t) => t.id_tipo === Number(idTipo));
  if (!tipo) return 'Otros';
  return plural ? tipo.plural : tipo.singular;
}

/** Tipo de una fila del detalle: su `id_tipo`; si falta, el que se deduce de si es nota de crédito o de débito. */
export function idTipoDeDetalle(d: { id_tipo?: number | null; tipo_documento?: string }): number | undefined {
  if (d.id_tipo !== undefined && d.id_tipo !== null) return Number(d.id_tipo);
  if (d.tipo_documento === 'nota_credito') return TIPO_NOTA_CREDITO;
  if (d.tipo_documento === 'nota_debito') return TIPO_NOTA_DEBITO;
  return undefined;
}

/** Fragmento para el nombre del archivo: «boletas», «facturas»… (vacío = todos los tipos). */
export function claveTipoReporte(idTipo?: number | null): string {
  return REPORTE_TIPOS.find((t) => t.id_tipo === Number(idTipo))?.clave ?? '';
}

export function formatearFechaEs(valor?: string | Date | null): string {
  if (!valor) return '—';
  const d = valor instanceof Date ? valor : new Date(valor);
  if (Number.isNaN(d.getTime())) {
    const s = String(valor);
    return s.length >= 10 ? s.slice(0, 10) : s || '—';
  }
  return d.toLocaleDateString('es-PE', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
}

export function formatearFechaHoraEs(valor?: string | Date | null): string {
  if (!valor) return '—';
  const d = valor instanceof Date ? valor : new Date(valor);
  if (Number.isNaN(d.getTime())) return formatearFechaEs(valor);
  return d.toLocaleString('es-PE', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatearMonedaEs(valor: number | string | null | undefined): string {
  const n = Number(valor ?? 0);
  return n.toLocaleString('es-PE', {
    style: 'currency',
    currency: 'PEN',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function etiquetaPeriodo(periodo: string): string {
  const map: Record<string, string> = {
    diario: 'Diario',
    semana: 'Semanal',
    quincenal: 'Quincenal',
    mensual: 'Mensual',
    anual: 'Anual',
  };
  return map[(periodo || '').toLowerCase()] || periodo || '—';
}

/**
 * «ventas_boletas_mensual_20261025.xlsx». El día es el de Lima (el servidor corre en UTC:
 * con la fecha del servidor, un reporte de las 20:00 salía con la fecha de mañana).
 */
export function nombreArchivoReporte(
  base: string,
  periodo: string,
  extension: 'xlsx' | 'pdf',
  tipo?: string,
): string {
  const per = (periodo || 'reporte').toLowerCase().replace(/[^a-z0-9_-]/g, '');
  const sufijoTipo = tipo ? `_${tipo.toLowerCase().replace(/[^a-z0-9_-]/g, '')}` : '';
  return `${base}${sufijoTipo}_${per}_${hoyLima().replace(/-/g, '')}.${extension}`;
}

export function capitalizarEstado(estado?: string): string {
  const s = String(estado || 'emitido').trim().toLowerCase();
  if (!s) return 'Emitido';
  return s.charAt(0).toUpperCase() + s.slice(1);
}

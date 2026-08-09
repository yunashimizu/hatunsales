/**
 * Formato y metadatos compartidos para exportes de reportes (Excel / PDF).
 * Solo presentación; la lógica de datos sigue en ReportesBussnies.
 */

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
  titulo: string;
  periodo: string;
  fechaInicio: string;
  fechaFin: string;
  generadoEl: string;
  nota?: string;
};

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

export function nombreArchivoReporte(
  base: string,
  periodo: string,
  extension: 'xlsx' | 'pdf',
): string {
  const ahora = new Date();
  const y = ahora.getFullYear();
  const m = String(ahora.getMonth() + 1).padStart(2, '0');
  const d = String(ahora.getDate()).padStart(2, '0');
  const per = (periodo || 'reporte').toLowerCase().replace(/[^a-z0-9_-]/g, '');
  return `${base}_${per}_${y}${m}${d}.${extension}`;
}

export function capitalizarEstado(estado?: string): string {
  const s = String(estado || 'emitido').trim().toLowerCase();
  if (!s) return 'Emitido';
  return s.charAt(0).toUpperCase() + s.slice(1);
}

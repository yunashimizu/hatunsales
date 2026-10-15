/**
 * Fechas fiscales en hora de Perú (America/Lima, UTC−5 sin horario de verano).
 * Las fechas se manejan como texto yyyy-mm-dd: es el formato del XML UBL y
 * evita los corrimientos de zona horaria de `Date` al comparar días.
 */

export const ZONA_HORARIA_PERU = 'America/Lima';
const MS_POR_DIA = 24 * 60 * 60 * 1000;

const PATRON_FECHA_ISO = /^(\d{4})-(\d{2})-(\d{2})$/;
const PATRON_HORA = /^([01]\d|2[0-3]):[0-5]\d:[0-5]\d$/;

// Los formateadores de Intl son costosos de crear: se reutilizan.
const formatoFechaLima = new Intl.DateTimeFormat('en-CA', {
  timeZone: ZONA_HORARIA_PERU,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
const formatoHoraLima = new Intl.DateTimeFormat('en-GB', {
  timeZone: ZONA_HORARIA_PERU,
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

function parte(partes: Intl.DateTimeFormatPart[], tipo: Intl.DateTimeFormatPartTypes): string {
  return partes.find((p) => p.type === tipo)?.value ?? '00';
}

/** Fecha calendario en Lima del instante indicado (por omisión, ahora). */
export function fechaLima(instante: Date = new Date()): string {
  const partes = formatoFechaLima.formatToParts(instante);
  return `${parte(partes, 'year')}-${parte(partes, 'month')}-${parte(partes, 'day')}`;
}

/** Hora en Lima (HH:mm:ss) del instante indicado. */
export function horaLima(instante: Date = new Date()): string {
  const partes = formatoHoraLima.formatToParts(instante);
  return `${parte(partes, 'hour')}:${parte(partes, 'minute')}:${parte(partes, 'second')}`;
}

/** true si es una fecha yyyy-mm-dd que existe en el calendario. */
export function esFechaIso(valor: unknown): valor is string {
  if (typeof valor !== 'string') return false;
  const m = PATRON_FECHA_ISO.exec(valor);
  if (!m) return false;
  const [anio, mes, dia] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const fecha = new Date(Date.UTC(anio, mes - 1, dia));
  return fecha.getUTCFullYear() === anio && fecha.getUTCMonth() === mes - 1 && fecha.getUTCDate() === dia;
}

export function esHoraValida(valor: unknown): valor is string {
  return typeof valor === 'string' && PATRON_HORA.test(valor);
}

function aMilisegundosUtc(fecha: string): number {
  const m = PATRON_FECHA_ISO.exec(fecha);
  if (!m || !esFechaIso(fecha)) throw new Error(`Fecha inválida (se espera yyyy-mm-dd): ${fecha}`);
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

/** Días calendario de `desde` a `hasta` (negativo si `hasta` es anterior). */
export function diasEntre(desde: string, hasta: string): number {
  return Math.round((aMilisegundosUtc(hasta) - aMilisegundosUtc(desde)) / MS_POR_DIA);
}

export function sumarDias(fecha: string, dias: number): string {
  return new Date(aMilisegundosUtc(fecha) + dias * MS_POR_DIA).toISOString().slice(0, 10);
}

/** yyyy-mm-dd → yyyymmdd (formato de los identificadores RC y RA). */
export function compactarFecha(fecha: string): string {
  aMilisegundosUtc(fecha);
  return fecha.replace(/-/g, '');
}

/** Normaliza el "hoy" de referencia: texto yyyy-mm-dd, un Date (se toma su día en Lima) u hoy en Lima. */
export function resolverHoy(hoy?: string | Date | null): string {
  if (hoy === undefined || hoy === null) return fechaLima();
  if (hoy instanceof Date) return fechaLima(hoy);
  if (esFechaIso(hoy)) return hoy;
  throw new Error(`Fecha de referencia inválida (se espera yyyy-mm-dd): ${String(hoy)}`);
}

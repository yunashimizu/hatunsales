/**
 * Fechas en hora de Lima (America/Lima) sin depender de la zona horaria del proceso.
 *
 * Reglas del proyecto:
 * - Perú usa UTC−5 fijo (sin horario de verano desde 1994): el desfase es constante, así que
 *   todo se calcula con aritmética exacta y el resultado es igual en Railway (UTC) y en una PC
 *   de desarrollo en Lima.
 * - La BD está en Etc/UTC y las columnas `timestamp without time zone` guardan la hora UTC
 *   (se escriben con NOW()). NO se debe definir TZ=America/Lima en el servidor: node-postgres
 *   leería esos timestamp como hora local y los desplazaría 5 h.
 * - Para filtrar un día de Lima:
 *     · en SQL (recomendado): usar sqlInicioDiaLima('$1') / sqlFinExclusivoDiaLima('$2') con
 *       parámetros 'YYYY-MM-DD' (no dependen de la zona de la sesión de PostgreSQL);
 *     · en JS: rangoDiaLima / rangoFechasLima devuelven instantes `Date`; contra columnas sin
 *       zona pásalos como texto con aTimestampUtc(instante), nunca como `Date` suelto.
 *   Los rangos son medio abiertos: `col >= desde AND col < hasta`.
 */

export const ZONA_LIMA = 'America/Lima';
/** Desfase de Lima respecto de UTC, en minutos. */
export const DESFASE_LIMA_MINUTOS = -300;

const DESFASE_MS = DESFASE_LIMA_MINUTOS * 60_000;
const MS_DIA = 86_400_000;
const PATRON_YMD = /^(\d{4})-(\d{2})-(\d{2})$/;
const PATRON_PARAMETRO_SQL = /^(\$\d{1,3}|:[A-Za-z_][A-Za-z0-9_]*)$/;

/** Fecha mal escrita o inexistente. El campo indica qué filtro la trajo. */
export class FechaLimaInvalidaError extends Error {
  constructor(
    readonly campo: string,
    readonly valor: unknown,
    mensaje?: string,
  ) {
    super(mensaje ?? `La fecha "${campo}" debe tener el formato AAAA-MM-DD y existir en el calendario.`);
    this.name = 'FechaLimaInvalidaError';
  }
}

/** Rango medio abierto [desde, hasta) en instantes UTC. */
export interface RangoLima {
  /** 00:00:00.000 de Lima del primer día (inclusivo). */
  desde: Date;
  /** 00:00:00.000 de Lima del día siguiente al último (EXCLUSIVO: usar `< hasta`). */
  hasta: Date;
}

export interface FiltroFechasLima {
  /** 'YYYY-MM-DD' validado, o undefined si no llegó. */
  desde?: string;
  hasta?: string;
  /** Instante de inicio (inclusivo) si llegó `desde`. */
  desdeInstante?: Date;
  /** Instante de fin EXCLUSIVO (inicio del día siguiente a `hasta`) si llegó `hasta`. */
  hastaExclusivo?: Date;
}

interface PartesLima {
  anio: number;
  mes: number;
  dia: number;
  /** 0 = domingo … 6 = sábado. */
  diaSemana: number;
}

function dos(n: number): string {
  return String(n).padStart(2, '0');
}

function cuatro(n: number): string {
  return String(n).padStart(4, '0');
}

function validarInstante(instante: Date, campo = 'fecha'): Date {
  if (!(instante instanceof Date) || Number.isNaN(instante.getTime())) {
    throw new FechaLimaInvalidaError(campo, instante, `La fecha "${campo}" no es un instante válido.`);
  }
  return instante;
}

function partesLima(instante: Date): PartesLima {
  const d = new Date(validarInstante(instante).getTime() + DESFASE_MS);
  return {
    anio: d.getUTCFullYear(),
    mes: d.getUTCMonth() + 1,
    dia: d.getUTCDate(),
    diaSemana: d.getUTCDay(),
  };
}

function ymdDe(anio: number, mes: number, dia: number): string {
  return `${cuatro(anio)}-${dos(mes)}-${dos(dia)}`;
}

/** Milisegundos UTC de la medianoche de Lima del día indicado. */
function msInicioDia(anio: number, mes: number, dia: number): number {
  return Date.UTC(anio, mes - 1, dia) - DESFASE_MS;
}

/** true si es 'YYYY-MM-DD' y la fecha existe en el calendario (rechaza 2026-02-30). */
export function esFechaYmd(valor: unknown): valor is string {
  if (typeof valor !== 'string') return false;
  const m = PATRON_YMD.exec(valor);
  if (!m) return false;
  const [anio, mes, dia] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (anio < 1900 || anio > 9999) return false;
  const d = new Date(Date.UTC(anio, mes - 1, dia));
  return d.getUTCFullYear() === anio && d.getUTCMonth() === mes - 1 && d.getUTCDate() === dia;
}

/** Devuelve la fecha si es válida; si no, lanza FechaLimaInvalidaError con el nombre del campo. */
export function validarFechaYmd(valor: unknown, campo = 'fecha'): string {
  const texto = typeof valor === 'string' ? valor.trim() : valor;
  if (!esFechaYmd(texto)) throw new FechaLimaInvalidaError(campo, valor);
  return texto;
}

function partesYmd(ymd: string, campo = 'fecha'): [number, number, number] {
  const valida = validarFechaYmd(ymd, campo);
  const m = PATRON_YMD.exec(valida)!;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** Día calendario en Lima ('YYYY-MM-DD') del instante indicado. */
export function aFechaLima(instante: Date): string {
  const p = partesLima(instante);
  return ymdDe(p.anio, p.mes, p.dia);
}

/** Alias con el nombre que usa la tarea de reportes (E1). */
export const ymdLima = aFechaLima;

/** Hoy en Lima, 'YYYY-MM-DD'. */
export function hoyLima(ahora: Date = new Date()): string {
  return aFechaLima(ahora);
}

/** Mes de Lima del instante, 'YYYY-MM' (para agrupar series anuales). */
export function mesLima(instante: Date): string {
  const p = partesLima(instante);
  return `${cuatro(p.anio)}-${dos(p.mes)}`;
}

/** Hora de Lima 'HH:mm:ss' del instante (para impresión). */
export function horaLima(instante: Date): string {
  const d = new Date(validarInstante(instante).getTime() + DESFASE_MS);
  return `${dos(d.getUTCHours())}:${dos(d.getUTCMinutes())}:${dos(d.getUTCSeconds())}`;
}

/** 'dd/mm/aaaa HH:mm' en hora de Lima (para documentos impresos). */
export function fechaHoraLimaLegible(instante: Date): string {
  const p = partesLima(instante);
  return `${dos(p.dia)}/${dos(p.mes)}/${cuatro(p.anio)} ${horaLima(instante).slice(0, 5)}`;
}

/** Instante de las 00:00:00.000 de Lima del día indicado. */
export function inicioDiaLima(ymd: string): Date {
  const [anio, mes, dia] = partesYmd(ymd);
  return new Date(msInicioDia(anio, mes, dia));
}

/** Instante de las 23:59:59.999 de Lima del día indicado (para rangos cerrados). */
export function finDiaLima(ymd: string): Date {
  return new Date(inicioDiaLima(ymd).getTime() + MS_DIA - 1);
}

/** Rango [00:00 de ese día, 00:00 del día siguiente) en hora de Lima. */
export function rangoDiaLima(ymd: string): RangoLima {
  const desde = inicioDiaLima(ymd);
  return { desde, hasta: new Date(desde.getTime() + MS_DIA) };
}

/** Rango que cubre los días completos de `desdeYmd` a `hastaYmd` (ambos incluidos). */
export function rangoFechasLima(desdeYmd: string, hastaYmd: string): RangoLima {
  const desde = inicioDiaLima(desdeYmd);
  const hasta = rangoDiaLima(hastaYmd).hasta;
  if (hasta.getTime() <= desde.getTime()) {
    throw new FechaLimaInvalidaError('desde', desdeYmd, 'La fecha "desde" no puede ser posterior a "hasta".');
  }
  return { desde, hasta };
}

/** Suma (o resta) días a una fecha 'YYYY-MM-DD'. */
export function sumarDiasYmd(ymd: string, dias: number): string {
  if (!Number.isInteger(dias)) throw new FechaLimaInvalidaError('dias', dias, 'Los días a sumar deben ser un entero.');
  const [anio, mes, dia] = partesYmd(ymd);
  const d = new Date(Date.UTC(anio, mes - 1, dia) + dias * MS_DIA);
  return ymdDe(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

/** Días calendario de `desde` a `hasta` (negativo si `hasta` es anterior). */
export function diasEntreYmd(desde: string, hasta: string): number {
  const [a1, m1, d1] = partesYmd(desde, 'desde');
  const [a2, m2, d2] = partesYmd(hasta, 'hasta');
  return Math.round((Date.UTC(a2, m2 - 1, d2) - Date.UTC(a1, m1 - 1, d1)) / MS_DIA);
}

/** Lunes 00:00 de Lima de la semana del instante. */
export function inicioSemanaLima(instante: Date = new Date()): Date {
  const p = partesLima(instante);
  const retroceso = (p.diaSemana + 6) % 7; // lunes = 0
  return new Date(msInicioDia(p.anio, p.mes, p.dia) - retroceso * MS_DIA);
}

/** Día 1 o 16 (00:00 de Lima) de la quincena del instante. */
export function inicioQuincenaLima(instante: Date = new Date()): Date {
  const p = partesLima(instante);
  return new Date(msInicioDia(p.anio, p.mes, p.dia <= 15 ? 1 : 16));
}

/** Día 1 del mes (00:00 de Lima) del instante. */
export function inicioMesLima(instante: Date = new Date()): Date {
  const p = partesLima(instante);
  return new Date(msInicioDia(p.anio, p.mes, 1));
}

/** 1 de enero (00:00 de Lima) del año del instante. */
export function inicioAnioLima(instante: Date = new Date()): Date {
  const p = partesLima(instante);
  return new Date(msInicioDia(p.anio, 1, 1));
}

/**
 * Texto 'YYYY-MM-DD HH:MM:SS.mmm' en UTC, sin zona. Es el formato para pasar un instante como
 * parámetro contra columnas `timestamp without time zone` que guardan hora UTC, sin depender de
 * cómo node-postgres serializa un `Date` (lo hace en la hora local del proceso).
 */
export function aTimestampUtc(instante: Date): string {
  return validarInstante(instante).toISOString().replace('T', ' ').replace('Z', '');
}

function vacio(valor: unknown): boolean {
  return valor === undefined || valor === null || (typeof valor === 'string' && valor.trim() === '');
}

/**
 * Valida los filtros `desde`/`hasta` ('YYYY-MM-DD', días de Lima) que llegan por query.
 * Vacíos se ignoran. Lanza FechaLimaInvalidaError si el formato es malo, si `desde` > `hasta`
 * o si el rango supera `maxDias` (cuando se indica).
 */
export function parsearFiltroFechasLima(
  filtro: { desde?: unknown; hasta?: unknown },
  opciones: { maxDias?: number } = {},
): FiltroFechasLima {
  const resultado: FiltroFechasLima = {};
  if (!vacio(filtro.desde)) {
    resultado.desde = validarFechaYmd(filtro.desde, 'desde');
    resultado.desdeInstante = inicioDiaLima(resultado.desde);
  }
  if (!vacio(filtro.hasta)) {
    resultado.hasta = validarFechaYmd(filtro.hasta, 'hasta');
    resultado.hastaExclusivo = rangoDiaLima(resultado.hasta).hasta;
  }
  if (resultado.desde && resultado.hasta) {
    const dias = diasEntreYmd(resultado.desde, resultado.hasta);
    if (dias < 0) {
      throw new FechaLimaInvalidaError('desde', filtro.desde, 'La fecha "desde" no puede ser posterior a "hasta".');
    }
    if (opciones.maxDias !== undefined && dias + 1 > opciones.maxDias) {
      throw new FechaLimaInvalidaError(
        'hasta',
        filtro.hasta,
        `El rango de fechas no puede superar ${opciones.maxDias} días.`,
      );
    }
  }
  return resultado;
}

function parametroSql(parametro: string): string {
  if (!PATRON_PARAMETRO_SQL.test(parametro)) {
    // Solo marcadores ($1, :desde): nunca valores interpolados.
    throw new Error(`Marcador de parámetro SQL inválido: ${parametro}`);
  }
  return parametro;
}

/**
 * Expresión SQL del inicio (00:00 de Lima) del día `parametro` ('YYYY-MM-DD'), convertido a
 * timestamp UTC sin zona. Usa CAST(... AS date) porque TypeORM confunde `:desde::date`.
 */
export function sqlInicioDiaLima(parametro: string): string {
  return `(CAST(${parametroSql(parametro)} AS date)::timestamp AT TIME ZONE '${ZONA_LIMA}' AT TIME ZONE 'UTC')`;
}

/** Expresión SQL del inicio del día SIGUIENTE a `parametro` (fin exclusivo del día, en UTC). */
export function sqlFinExclusivoDiaLima(parametro: string): string {
  return `((CAST(${parametroSql(parametro)} AS date) + 1)::timestamp AT TIME ZONE '${ZONA_LIMA}' AT TIME ZONE 'UTC')`;
}

/** Hoy en Lima como `date` de PostgreSQL (sustituye a CURRENT_DATE, que va en UTC). */
export const SQL_HOY_LIMA = `(now() AT TIME ZONE '${ZONA_LIMA}')::date`;

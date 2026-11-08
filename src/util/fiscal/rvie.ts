/**
 * Registro de Ventas e Ingresos Electrónico (RVIE) del SIRE: archivo de texto con las ventas de un mes
 * para que el contador las compare con la propuesta de SUNAT (o la reemplace).
 *
 * Qué viene de la fuente oficial y qué es un supuesto:
 * - NOMBRE del archivo: oficial. Manual de servicios Web API de SIRE Ventas v22 (cpe.sunat.gob.pe, leído el 8/11/2026),
 *   que cita la tabla 6 del Anexo 1 de la RS 112-2021/SUNAT: `LERRRRRRRRRRRAAAAMM0014040002OIM2.txt`
 *   = LE + RUC + año y mes + `00` + libro `140400` + oportunidad `02` (reemplazo de la propuesta) + O (operaciones)
 *   + I (con/sin información) + M (moneda: 1 soles) + `2` (generado por el sistema nuevo).
 * - COLUMNAS: [SUPUESTO] el Anexo 3 de la RS 112-2021 (estructura del archivo de reemplazo) no se pudo abrir
 *   (cpe.sunat.gob.pe y sunat.gob.pe/legislacion responden 403/404 desde aquí). Las 34 columnas y su orden salen de una guía
 *   no oficial que reproduce la propuesta descargada (siresunat.com, «Cómo crear el RVIE de SIRE») y coinciden con las
 *   del Registro de Ventas PLE 14.1. El contador DEBE validar el primer archivo contra la propuesta de SUNAT.
 * - Anulados: [SUPUESTO] fila con importes en cero, documento de cliente `0|0` y la razón social «ANULADO»
 *   (convención del registro de ventas del PLE).
 * - Boletas: una fila por boleta (número inicial = número; el rango final queda vacío). SUNAT también acepta rangos.
 * - CAR SUNAT: se deja vacío (lo asigna SUNAT a lo que ya recibió; un documento sin CAR se toma como nuevo).
 */

export const AVISO_ESTRUCTURA_RVIE =
  'Estructura basada en PLE 14.1; el contador debe validar el primer archivo contra la propuesta SIRE.';

/** Código del libro RVIE en el nombre del archivo (RS 112-2021). */
export const CODIGO_LIBRO_RVIE = '140400';
/** Oportunidad 02: el archivo reemplaza la propuesta de SUNAT. */
export const CODIGO_OPORTUNIDAD_RVIE = '02';

export const CABECERAS_RVIE = [
  'RUC',
  'Razón social del contribuyente',
  'Periodo',
  'CAR SUNAT',
  'Fecha de emisión',
  'Fecha de vencimiento o pago',
  'Tipo de comprobante',
  'Serie',
  'Número inicial',
  'Número final (rango)',
  'Tipo de documento del cliente',
  'Número de documento del cliente',
  'Apellidos y nombres o razón social del cliente',
  'Valor facturado de exportación',
  'Base imponible gravada',
  'Descuento de la base imponible gravada',
  'IGV',
  'Descuento del IGV',
  'Importe exonerado',
  'Importe inafecto',
  'ISC',
  'Base imponible IVAP',
  'IVAP',
  'ICBPER',
  'Otros conceptos o tributos',
  'Importe total',
  'Moneda',
  'Tipo de cambio',
  'Fecha del documento que modifica',
  'Tipo del documento que modifica',
  'Serie del documento que modifica',
  'Número del documento que modifica',
  'Identificación del proyecto',
  'Campo de libre utilización',
] as const;

export const COLUMNAS_RVIE = CABECERAS_RVIE.length;

export type EstadoFilaRvie = 'aceptado' | 'anulado';

export interface FilaRvie {
  /** yyyy-mm-dd */
  fecha: string;
  /** yyyy-mm-dd o vacío */
  vencimiento: string;
  /** Catálogo 01: 01, 03, 07 u 08. */
  tipo: string;
  serie: string;
  numero: number;
  clienteTipoDoc: string;
  clienteNumeroDoc: string;
  clienteNombre: string;
  gravada: number;
  igv: number;
  exonerada: number;
  inafecta: number;
  total: number;
  moneda: 'PEN' | 'USD';
  /** Solo notas. */
  modificadoFecha: string;
  modificadoTipo: string;
  modificadoSerie: string;
  modificadoNumero: number | null;
  estado: EstadoFilaRvie;
}

/** dd/mm/aaaa desde yyyy-mm-dd (vacío si no es una fecha). */
export function fechaRvie(ymd: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd ?? ''));
  return m ? `${m[3]}/${m[2]}/${m[1]}` : '';
}

/** Importe con punto y dos decimales; -0 sale como 0.00. */
export function importeRvie(valor: number): string {
  const n = Math.round((Number(valor) || 0) * 100) / 100;
  return (Object.is(n, -0) ? 0 : n).toFixed(2);
}

/** Texto libre sin el separador, sin saltos de línea ni caracteres de control, y en una línea. */
export function textoRvie(valor: unknown): string {
  // eslint-disable-next-line no-control-regex
  return String(valor ?? '').replace(/[\u0000-\u001f\u007f|]/g, ' ').replace(/\s+/g, ' ').trim();
}

const TIPOS_DOC_CLIENTE = new Set(['0', '1', '4', '6', '7', 'A']);

/** Los importes de una nota de crédito van en negativo; los de un anulado, en cero. */
function firma(fila: FilaRvie): number {
  if (fila.estado === 'anulado') return 0;
  return fila.tipo === '07' ? -1 : 1;
}

export interface DatosArchivoRvie {
  ruc: string;
  razonSocial: string;
  /** AAAAMM */
  periodo: string;
}

export function columnasDeFila(fila: FilaRvie, datos: DatosArchivoRvie): string[] {
  const s = firma(fila);
  const anulado = fila.estado === 'anulado';
  const monto = (v: number) => importeRvie(s === 0 ? 0 : s * Math.abs(Number(v) || 0));
  const tipoDocCliente = String(fila.clienteTipoDoc ?? '').trim().toUpperCase();
  const numeroDocCliente = textoRvie(fila.clienteNumeroDoc);
  const sinDocumento = !TIPOS_DOC_CLIENTE.has(tipoDocCliente) || !numeroDocCliente;
  const esNota = fila.tipo === '07' || fila.tipo === '08';

  return [
    datos.ruc,
    textoRvie(datos.razonSocial),
    datos.periodo,
    '',
    fechaRvie(fila.fecha),
    fechaRvie(fila.vencimiento),
    fila.tipo,
    textoRvie(fila.serie),
    String(fila.numero),
    '',
    anulado || sinDocumento ? '0' : tipoDocCliente,
    anulado || sinDocumento ? (anulado ? '0' : '-') : numeroDocCliente,
    anulado ? 'ANULADO' : textoRvie(fila.clienteNombre),
    importeRvie(0),
    monto(fila.gravada),
    importeRvie(0),
    monto(fila.igv),
    importeRvie(0),
    monto(fila.exonerada),
    monto(fila.inafecta),
    importeRvie(0),
    importeRvie(0),
    importeRvie(0),
    importeRvie(0),
    importeRvie(0),
    monto(fila.total),
    fila.moneda,
    '',
    esNota ? fechaRvie(fila.modificadoFecha) : '',
    esNota ? textoRvie(fila.modificadoTipo) : '',
    esNota ? textoRvie(fila.modificadoSerie) : '',
    esNota && fila.modificadoNumero ? String(fila.modificadoNumero) : '',
    '',
    '',
  ];
}

/** `LE<RUC><AAAAMM>00140400 02 O I M 2.txt`; I = 0 cuando el mes no tiene información. */
export function nombreArchivoRvie(ruc: string, periodo: string, conInformacion: boolean, moneda: 1 | 2 = 1): string {
  return `LE${ruc}${periodo}00${CODIGO_LIBRO_RVIE}${CODIGO_OPORTUNIDAD_RVIE}1${conInformacion ? 1 : 0}${moneda}2.txt`;
}

export function nombreCsvRvie(ruc: string, periodo: string): string {
  return `registro-ventas-sire-${ruc}-${periodo}.csv`;
}

/** TXT: una línea por comprobante, columnas separadas por «|» y fin de línea CRLF. Sin información = archivo vacío. */
export function construirTxtRvie(filas: FilaRvie[], datos: DatosArchivoRvie): string {
  return filas.map((fila) => columnasDeFila(fila, datos).join('|')).map((linea) => `${linea}\r\n`).join('');
}

function celdaCsv(valor: string): string {
  return /[",\r\n]/.test(valor) ? `"${valor.replace(/"/g, '""')}"` : valor;
}

/** CSV para el contador: con cabeceras, comas, UTF-8 con BOM (para que Excel lea bien las tildes) y la columna «Estado». */
export function construirCsvRvie(filas: FilaRvie[], datos: DatosArchivoRvie): string {
  const cabecera = [...CABECERAS_RVIE, 'Estado'].map(celdaCsv).join(',');
  const cuerpo = filas.map((fila) =>
    [...columnasDeFila(fila, datos), fila.estado === 'anulado' ? 'Anulado' : 'Aceptado'].map(celdaCsv).join(','),
  );
  return `﻿${[cabecera, ...cuerpo].join('\r\n')}\r\n`;
}

/** AAAAMM válido (2020-01 en adelante). */
export function periodoRvieValido(periodo: unknown): periodo is string {
  if (typeof periodo !== 'string') return false;
  const m = /^(\d{4})(\d{2})$/.exec(periodo);
  if (!m) return false;
  const anio = Number(m[1]);
  const mes = Number(m[2]);
  return anio >= 2020 && mes >= 1 && mes <= 12;
}

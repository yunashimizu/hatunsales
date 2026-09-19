/**
 * Convierte un importe a la frase "IMPORTE EN LETRAS" que imprime el
 * comprobante, por ejemplo: CIENTO DIECIOCHO CON 00/100 SOLES.
 *
 * Se escribe sin tildes a propósito: es el formato que usa la representación
 * impresa de SUNAT y evita problemas de codificación en el PDF.
 */

const UNIDADES = [
  '', 'UNO', 'DOS', 'TRES', 'CUATRO', 'CINCO', 'SEIS', 'SIETE', 'OCHO', 'NUEVE',
  'DIEZ', 'ONCE', 'DOCE', 'TRECE', 'CATORCE', 'QUINCE', 'DIECISEIS',
  'DIECISIETE', 'DIECIOCHO', 'DIECINUEVE', 'VEINTE',
];

const DECENAS = [
  '', '', 'VEINTE', 'TREINTA', 'CUARENTA', 'CINCUENTA',
  'SESENTA', 'SETENTA', 'OCHENTA', 'NOVENTA',
];

const CENTENAS = [
  '', 'CIENTO', 'DOSCIENTOS', 'TRESCIENTOS', 'CUATROCIENTOS', 'QUINIENTOS',
  'SEISCIENTOS', 'SETECIENTOS', 'OCHOCIENTOS', 'NOVECIENTOS',
];

const NOMBRE_MONEDA: Record<number, string> = {
  1: 'SOLES',
  2: 'DOLARES AMERICANOS',
  3: 'EUROS',
  4: 'LIBRAS ESTERLINAS',
};

function decenasALetras(n: number): string {
  if (n <= 20) return UNIDADES[n];
  if (n < 30) return n === 20 ? 'VEINTE' : `VEINTI${UNIDADES[n - 20].toLowerCase().toUpperCase()}`;

  const decena = Math.floor(n / 10);
  const unidad = n % 10;
  return unidad === 0 ? DECENAS[decena] : `${DECENAS[decena]} Y ${UNIDADES[unidad]}`;
}

function centenasALetras(n: number): string {
  if (n === 100) return 'CIEN';
  const centena = Math.floor(n / 100);
  const resto = n % 100;
  const partes = [CENTENAS[centena], decenasALetras(resto)].filter(Boolean);
  return partes.join(' ');
}

function grupoALetras(n: number): string {
  if (n === 0) return '';
  if (n < 100) return decenasALetras(n);
  return centenasALetras(n);
}

/**
 * Delante de MIL y MILLONES el "UNO" final se apocopa: VEINTIUN MIL,
 * TREINTA Y UN MILLONES, DOSCIENTOS UN MIL (nunca "VEINTIUNO MIL").
 */
function apocopar(texto: string): string {
  return texto.endsWith('UNO') ? texto.slice(0, -1) : texto;
}

/** 0 … 999 999, con apócope opcional del último "UNO". */
function hastaMillonALetras(n: number, conApocope: boolean): string {
  const miles = Math.floor(n / 1000);
  const resto = n % 1000;
  const partes: string[] = [];

  if (miles === 1) partes.push('MIL');
  else if (miles > 1) partes.push(`${apocopar(grupoALetras(miles))} MIL`);

  if (resto > 0) {
    const textoResto = grupoALetras(resto);
    partes.push(conApocope ? apocopar(textoResto) : textoResto);
  }
  return partes.join(' ');
}

/** Parte entera en letras (hasta 999 999 999 999). */
export function enteroALetras(entero: number): string {
  const n = Math.floor(Math.abs(Number(entero) || 0));
  if (n === 0) return 'CERO';

  const millones = Math.floor(n / 1_000_000);
  const resto = n % 1_000_000;

  const partes: string[] = [];

  if (millones === 1) {
    partes.push('UN MILLON');
  } else if (millones > 1) {
    partes.push(`${hastaMillonALetras(millones, true)} MILLONES`);
  }
  if (resto > 0) {
    partes.push(hastaMillonALetras(resto, false));
  }

  return partes.join(' ').replace(/\s+/g, ' ').trim();
}

/** Separa un importe en entero y céntimos sin errores de coma flotante. */
function partesImporte(monto: number): { entero: number; centimos: number } {
  const totalCentimos = Math.round(Math.abs(Number(monto) || 0) * 100);
  return {
    entero: Math.floor(totalCentimos / 100),
    centimos: totalCentimos % 100,
  };
}

export function numeroALetras(monto: number, idMoneda = 1): string {
  const { entero, centimos } = partesImporte(monto);
  const moneda = NOMBRE_MONEDA[idMoneda] ?? NOMBRE_MONEDA[1];
  const centimosTexto = String(centimos).padStart(2, '0');

  return `${enteroALetras(entero)} CON ${centimosTexto}/100 ${moneda}`;
}

/**
 * Formato de proformas y cotizaciones: "CIENTO CUARENTA Y CUATRO Y 00/100 SOLES".
 * (El comprobante electrónico sigue usando numeroALetras con "CON").
 */
export function montoEnLetras(monto: number, idMoneda = 1): string {
  const { entero, centimos } = partesImporte(monto);
  const moneda = NOMBRE_MONEDA[idMoneda] ?? NOMBRE_MONEDA[1];
  return `${enteroALetras(entero)} Y ${String(centimos).padStart(2, '0')}/100 ${moneda}`;
}

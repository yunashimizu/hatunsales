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

function enteroALetras(entero: number): string {
  if (entero === 0) return 'CERO';

  const millones = Math.floor(entero / 1_000_000);
  const miles = Math.floor((entero % 1_000_000) / 1000);
  const resto = entero % 1000;

  const partes: string[] = [];

  if (millones > 0) {
    partes.push(millones === 1 ? 'UN MILLON' : `${grupoALetras(millones)} MILLONES`);
  }
  if (miles > 0) {
    partes.push(miles === 1 ? 'MIL' : `${grupoALetras(miles)} MIL`);
  }
  if (resto > 0) {
    partes.push(grupoALetras(resto));
  }

  return partes.join(' ').replace(/\s+/g, ' ').trim();
}

export function numeroALetras(monto: number, idMoneda = 1): string {
  const valor = Math.abs(Number(monto) || 0);
  const entero = Math.floor(valor);
  const centimos = Math.round((valor - entero) * 100);

  // Redondear los céntimos puede empujar el entero, por ejemplo 9.999 -> 10.00
  const enteroFinal = centimos === 100 ? entero + 1 : entero;
  const centimosFinal = centimos === 100 ? 0 : centimos;

  const moneda = NOMBRE_MONEDA[idMoneda] ?? NOMBRE_MONEDA[1];
  const centimosTexto = String(centimosFinal).padStart(2, '0');

  return `${enteroALetras(enteroFinal)} CON ${centimosTexto}/100 ${moneda}`;
}

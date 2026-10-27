/**
 * Variantes equivalentes de un código de barras para buscarlo en la base.
 * - UPC-A (12 dígitos) es un EAN-13 con un 0 delante: se busca también con el 0.
 * - EAN-13 que empieza en 0 equivale a un UPC-A: se busca también sin él.
 * - Cualquier otro código se busca solo tal cual.
 * El primer elemento siempre es el código recibido.
 */
export function variantesCodigo(codigo: string): string[] {
  const valor = String(codigo ?? '').trim();
  if (!valor) return [];
  if (/^\d{12}$/.test(valor)) return [valor, `0${valor}`];
  if (/^0\d{12}$/.test(valor)) return [valor, valor.slice(1)];
  return [valor];
}

/**
 * Dígito verificador EAN-13 de los 12 primeros dígitos: se suman los dígitos de posición par
 * (2.ª, 4.ª…) por 3 y los de posición impar por 1; el verificador completa hasta el múltiplo de 10.
 */
export function digitoVerificadorEan13(doceDigitos: string): number {
  if (!/^\d{12}$/.test(String(doceDigitos ?? ''))) {
    throw new Error('Se necesitan exactamente 12 dígitos para calcular el verificador EAN-13');
  }
  let suma = 0;
  for (let i = 0; i < 12; i++) {
    suma += Number(doceDigitos[i]) * (i % 2 === 0 ? 1 : 3);
  }
  return (10 - (suma % 10)) % 10;
}

/** `true` si son 13 dígitos y el último es el verificador correcto. */
export function esEan13Valido(codigo: string): boolean {
  const valor = String(codigo ?? '');
  if (!/^\d{13}$/.test(valor)) return false;
  return digitoVerificadorEan13(valor.slice(0, 12)) === Number(valor[12]);
}

/** Máximo número de secuencia que cabe en los 11 dígitos del código interno. */
export const MAX_SECUENCIA_INTERNA = 99_999_999_999;

/**
 * Código interno EAN-13: «2» (rango de uso interno) + secuencia en 11 dígitos con ceros a la izquierda
 * + dígito verificador.
 */
export function ean13Interno(numeroSecuencia: number): string {
  if (!Number.isSafeInteger(numeroSecuencia) || numeroSecuencia < 0 || numeroSecuencia > MAX_SECUENCIA_INTERNA) {
    throw new Error(`El número de secuencia ${numeroSecuencia} no cabe en 11 dígitos`);
  }
  const base = `2${String(numeroSecuencia).padStart(11, '0')}`;
  return `${base}${digitoVerificadorEan13(base)}`;
}

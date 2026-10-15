import { CATALOGO_06_TIPOS_VALIDOS } from '../catalogos/sunat.catalogos';

/** Pesos del dígito verificador del RUC (módulo 11). */
const PESOS_RUC = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2] as const;
const PREFIJOS_RUC = ['10', '15', '16', '17', '20'];

/**
 * RUC válido: 11 dígitos, prefijo de contribuyente (10, 15, 16, 17 o 20) y
 * dígito verificador correcto (dv = 11 − suma ponderada % 11; 10 → 0, 11 → 1).
 */
export function esRucValido(ruc: string | null | undefined): boolean {
  const valor = String(ruc ?? '').trim();
  if (!/^\d{11}$/.test(valor) || !PREFIJOS_RUC.includes(valor.slice(0, 2))) return false;
  const suma = PESOS_RUC.reduce((acumulado, peso, i) => acumulado + peso * Number(valor[i]), 0);
  const resto = 11 - (suma % 11);
  const digito = resto === 10 ? 0 : resto === 11 ? 1 : resto;
  return digito === Number(valor[10]);
}

export function esDniValido(dni: string | null | undefined): boolean {
  return /^\d{8}$/.test(String(dni ?? '').trim());
}

/**
 * Valida el número según el tipo del catálogo 06. Devuelve el motivo del
 * error en español o null si el número es válido.
 */
export function errorDocumentoIdentidad(tipoDoc: string, numDoc: string): string | null {
  const tipo = String(tipoDoc ?? '').trim();
  const numero = String(numDoc ?? '').trim();

  if (!CATALOGO_06_TIPOS_VALIDOS.has(tipo)) {
    return `el tipo de documento "${tipo}" no existe en el catálogo 06 de SUNAT`;
  }
  switch (tipo) {
    case '0':
      return numero.length >= 1 && numero.length <= 15 ? null : 'sin documento: use "-" o un número de hasta 15 caracteres';
    case '1':
      return esDniValido(numero) ? null : `el DNI "${numero}" debe tener 8 dígitos`;
    case '6':
      return esRucValido(numero) ? null : `el RUC "${numero}" no es válido (11 dígitos con dígito verificador correcto)`;
    case '4':
    case '7':
      return /^[A-Z0-9-]{1,12}$/i.test(numero) ? null : `el documento "${numero}" debe tener de 1 a 12 caracteres alfanuméricos`;
    default:
      return /^[A-Z0-9-]{1,15}$/i.test(numero) ? null : `el documento "${numero}" debe tener de 1 a 15 caracteres alfanuméricos`;
  }
}

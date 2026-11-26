/**
 * Fase 2.8: SKU sugerido = prefijo de la categoría + correlativo. Utilidad pura (sin base).
 *  - Prefijo: las tres primeras letras del nombre de la categoría, sin tildes ni signos, en mayúsculas
 *    («Herramientas» → HER, «Ñandú» → NAN). Con menos de tres letras se completa con X; sin categoría, GEN.
 *  - Correlativo: el siguiente al mayor número ya usado con ese prefijo (HER-0007, HER7, her-12 cuentan),
 *    con al menos 4 dígitos.
 */
export const PREFIJO_SIN_CATEGORIA = 'GEN';
export const DIGITOS_CORRELATIVO = 4;

export function prefijoDeCategoria(nombre: string | null | undefined): string {
  const letras = String(nombre ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z]/g, '');
  if (!letras) return PREFIJO_SIN_CATEGORIA;
  return (letras + 'XX').slice(0, 3);
}

/** Expresión (para `~*` de PostgreSQL y para JS) de los SKU con ese prefijo y un número. */
export function patronSku(prefijo: string): string {
  if (!/^[A-Z]{3}$/.test(prefijo)) throw new Error('Prefijo de SKU no válido');
  return `^${prefijo}-?([0-9]{1,9})$`;
}

/** Número del SKU si sigue el patrón del prefijo (sin distinguir mayúsculas ni espacios al borde); si no, null. */
export function correlativoDeSku(sku: string | null | undefined, prefijo: string): number | null {
  const m = new RegExp(patronSku(prefijo), 'i').exec(String(sku ?? '').trim());
  return m ? Number(m[1]) : null;
}

export function formatearSku(prefijo: string, correlativo: number): string {
  return `${prefijo}-${String(correlativo).padStart(DIGITOS_CORRELATIVO, '0')}`;
}

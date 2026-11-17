/**
 * Búsqueda de productos que perdona tildes, mayúsculas y el orden de las palabras
 * («cana pescar» encuentra «Caña para pescar»), igual que el buscador del panel
 * (ferreteria/src/app/shared/utils/texto-busqueda.ts).
 *
 * Sin extensiones de PostgreSQL: las tildes se quitan con `translate`, que es estándar.
 * Todo valor del usuario viaja como parámetro; aquí solo se arma texto SQL con
 * marcadores `$n` y constantes.
 */

const CON_TILDE = 'áàäâéèëêíìïîóòöôúùüûñ';
const SIN_TILDE = 'aaaaeeeeiiiioooouuuun';

/** Más palabras que esto se ignoran: una búsqueda de caja no necesita más y acota el SQL. */
export const MAXIMO_PALABRAS_BUSQUEDA = 6;

/** Minúsculas, sin tildes y con espacios simples. Igual que `normalizarBusqueda` del panel. */
export function normalizarTextoBusqueda(texto: string | null | undefined): string {
  return String(texto ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** Palabras de la consulta ya normalizadas, sin repetidas y acotadas. */
export function palabrasDeBusqueda(texto: string | null | undefined): string[] {
  const palabras = normalizarTextoBusqueda(texto).split(' ').filter(Boolean);
  return [...new Set(palabras)].slice(0, MAXIMO_PALABRAS_BUSQUEDA);
}

/** Patrón de LIKE que busca la palabra tal cual: `%`, `_` y `\` escritos por el usuario no son comodines. */
export function patronPalabra(palabra: string): string {
  return `%${palabra.replace(/[\\%_]/g, '\\$&')}%`;
}

/** Expresión SQL con nombre y SKU del producto, en minúsculas y sin tildes. */
export function sqlTextoProducto(alias = 'p'): string {
  return `translate(LOWER(${alias}.nombre || ' ' || COALESCE(${alias}.sku, '')), '${CON_TILDE}', '${SIN_TILDE}')`;
}

export interface CondicionBusquedaProductos {
  /** Condición lista para el WHERE (entre paréntesis). */
  sql: string;
  /** Valores de los marcadores, en orden. El primero corresponde a `primerMarcador`. */
  params: string[];
}

/**
 * Condición del WHERE: todas las palabras están en el nombre o SKU, o el texto escrito está en el
 * código de barras. Sin palabras (texto vacío) no filtra nada.
 * @param primerMarcador número del primer `$n` libre en la consulta que la usa.
 */
export function condicionBusquedaProductos(
  texto: string,
  primerMarcador: number,
  alias = 'p',
): CondicionBusquedaProductos {
  const palabras = palabrasDeBusqueda(texto);
  if (!palabras.length) return { sql: 'TRUE', params: [] };

  const params: string[] = [];
  const porPalabra = palabras.map((palabra) => {
    params.push(patronPalabra(palabra));
    return `${sqlTextoProducto(alias)} LIKE $${primerMarcador + params.length - 1} ESCAPE '\\'`;
  });
  params.push(patronPalabra(texto.trim().toLowerCase()));
  const barras = `COALESCE(${alias}.codigo_barras, '') LIKE $${primerMarcador + params.length - 1} ESCAPE '\\'`;

  return { sql: `((${porPalabra.join(' AND ')}) OR ${barras})`, params };
}

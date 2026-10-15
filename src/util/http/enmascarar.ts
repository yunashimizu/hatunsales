/**
 * Quita datos personales y secretos de lo que se escribe en logs o se devuelve
 * en errores: DNI (8 dígitos), RUC (11), teléfonos y tarjetas (secuencias de
 * 8 o más dígitos), correos y tokens largos.
 */

const CORREO = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const DIGITOS_LARGOS = /\d{8,}/g;
const TOKEN_LARGO = /[A-Za-z0-9_-]{32,}/g;
const LITERAL_SQL = /'(?:[^']|'')*'/g;
const LITERAL_EN_MENSAJE_PG = /:\s*"(?:[^"\\]|\\.)*"/g;
const ESPACIOS = /\s+/g;

export const LARGO_MAXIMO_RUTA = 200;
export const LARGO_MAXIMO_SQL = 300;

/** Recorta a `maximo` caracteres agregando '…' si hizo falta. */
export function recortar(texto: string, maximo: number): string {
  const limpio = String(texto ?? '');
  return limpio.length > maximo ? `${limpio.slice(0, Math.max(0, maximo - 1))}…` : limpio;
}

/** Enmascara correos y secuencias de 8 o más dígitos (DNI, RUC, teléfonos, tarjetas). */
export function enmascararDatosPersonales(texto: string): string {
  return String(texto ?? '').replace(CORREO, '***@***').replace(DIGITOS_LARGOS, '***');
}

/** Como `enmascararDatosPersonales`, y además oculta tokens opacos largos (32+ caracteres). */
export function enmascararTexto(texto: string): string {
  return enmascararDatosPersonales(String(texto ?? '').replace(TOKEN_LARGO, '***'));
}

function decodificarSeguro(texto: string): string {
  try {
    return decodeURI(texto);
  } catch {
    return texto;
  }
}

/** Ruta de la URL sin query string, decodificada, enmascarada y recortada. */
export function rutaSegura(url: string | undefined | null): string {
  const sinQuery = String(url ?? '').split(/[?#]/, 1)[0] || '/';
  return recortar(enmascararTexto(decodificarSeguro(sinQuery)), LARGO_MAXIMO_RUTA);
}

/**
 * SQL apto para log: una sola línea, sin literales de texto (pueden llevar DNI,
 * correos o hashes si algún código antiguo interpola valores) y recortado.
 * Los parámetros ($1, $2…) nunca se registran.
 */
export function sqlSeguro(sql: string | undefined | null): string {
  const unaLinea = String(sql ?? '').replace(ESPACIOS, ' ').trim().replace(LITERAL_SQL, "'…'");
  return recortar(enmascararDatosPersonales(unaLinea), LARGO_MAXIMO_SQL);
}

/**
 * Mensaje de PostgreSQL apto para log: PostgreSQL cita el valor rechazado
 * después de dos puntos (`invalid input syntax for type integer: "abc"`); ese
 * valor se oculta. Los identificadores (`relation "x"`) se conservan.
 */
export function mensajePgSeguro(mensaje: string | undefined | null): string {
  const sinValores = String(mensaje ?? '').replace(LITERAL_EN_MENSAJE_PG, ': "…"');
  return recortar(enmascararDatosPersonales(sinValores), LARGO_MAXIMO_SQL);
}

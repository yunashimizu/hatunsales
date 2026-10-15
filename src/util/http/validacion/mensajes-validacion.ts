import type { ValidationError } from '@nestjs/common';

/**
 * Traduce al español los mensajes por defecto (en inglés) de class-validator.
 * Los mensajes personalizados de los DTO (`{ message: '...' }`) pasan intactos.
 */

type Traduccion = (m: RegExpMatchArray) => string;

const NUMERO = '(-?\\d+(?:\\.\\d+)?(?:e[+-]?\\d+)?)';

/** Predicado en inglés (lo que va después del nombre del campo) → predicado en español. */
const PREDICADOS: ReadonlyArray<readonly [RegExp, Traduccion]> = [
  [/^should not be empty$/, () => 'es obligatorio'],
  [/^should not be null or undefined$/, () => 'es obligatorio'],
  [/^must be a string$/, () => 'debe ser texto'],
  [/^must be a number conforming to the specified constraints$/, () => 'debe ser un número'],
  [/^must be an integer number$/, () => 'debe ser un número entero'],
  [/^must be a positive number$/, () => 'debe ser mayor que cero'],
  [/^must be a negative number$/, () => 'debe ser menor que cero'],
  [new RegExp(`^must not be less than ${NUMERO}$`, 'i'), (m) => `no puede ser menor que ${m[1]}`],
  [new RegExp(`^must not be greater than ${NUMERO}$`, 'i'), (m) => `no puede ser mayor que ${m[1]}`],
  [new RegExp(`^must be divisible by ${NUMERO}$`, 'i'), (m) => `debe ser múltiplo de ${m[1]}`],
  [
    /^must be longer than or equal to (\d+) and shorter than or equal to (\d+) characters$/,
    (m) => `debe tener entre ${m[1]} y ${m[2]} caracteres`,
  ],
  [/^must be longer than or equal to (\d+) characters$/, (m) => `debe tener al menos ${m[1]} caracteres`],
  [/^must be shorter than or equal to (\d+) characters$/, (m) => `debe tener como máximo ${m[1]} caracteres`],
  [/^must be an email$/, () => 'debe ser un correo electrónico válido'],
  [/^must be a boolean value$/, () => 'debe ser verdadero o falso'],
  [/^must be a boolean string$/, () => 'debe ser "true" o "false"'],
  [/^must be a valid ISO 8601 date string$/, () => 'debe ser una fecha válida (AAAA-MM-DD)'],
  [/^must be RFC 3339 date$/, () => 'debe ser una fecha válida'],
  [/^must be a Date instance$/, () => 'debe ser una fecha válida'],
  [/^must be a valid representation of military time in the format HH:MM$/, () => 'debe ser una hora válida (HH:MM)'],
  [/^must be an array$/, () => 'debe ser una lista'],
  [/^must contain at least (\d+) elements$/, (m) => `debe tener al menos ${m[1]} elemento(s)`],
  [/^must contain no more than (\d+) elements$/, (m) => `no puede tener más de ${m[1]} elemento(s)`],
  [/^must be one of the following values: ?(.*)$/, (m) => `debe ser uno de estos valores: ${m[1] || '(ninguno)'}`],
  [/^should not be one of the following values: ?(.*)$/, (m) => `no puede ser ninguno de estos valores: ${m[1]}`],
  [/^must match .+ regular expression$/, () => 'no tiene el formato correcto'],
  [/^must be an object$/, () => 'debe ser un objeto'],
  [/^must be a non-empty object$/, () => 'debe ser un objeto con datos'],
  [/^must be an instance of \S+$/, () => 'no tiene el formato correcto'],
  [/^must be a UUID$/, () => 'debe ser un identificador válido'],
  [/^must be a URL address$/, () => 'debe ser una dirección web válida'],
  [/^must be a number string$/, () => 'debe contener solo números'],
  [/^must be a (valid )?phone number$/, () => 'debe ser un teléfono válido'],
  [/^must be a postal code$/, () => 'debe ser un código postal válido'],
  [/^must be a json string$/, () => 'debe ser un JSON válido'],
  [/^must be base64 encoded$/, () => 'debe estar codificado en base64'],
  [/^must be an ip address$/, () => 'debe ser una dirección IP válida'],
  [/^must be a currency$/, () => 'debe ser un monto válido'],
  [/^must be uppercase$/, () => 'debe estar en mayúsculas'],
  [/^must be a lowercase string$/, () => 'debe estar en minúsculas'],
  [/^must contain only letters and numbers$/, () => 'solo puede contener letras y números'],
  [/^must contain only letters \(a-zA-Z\)$/, () => 'solo puede contener letras'],
  [/^must be equal to (.+)$/, (m) => `debe ser igual a ${m[1]}`],
  [/^should not be equal to (.+)$/, (m) => `no puede ser igual a ${m[1]}`],
  [/^must be empty$/, () => 'debe estar vacío'],
  [/^is not a valid decimal number\.?$/, () => 'debe ser un número decimal válido'],
  [/^is not strong enough$/, () => 'no es suficientemente segura'],
];

/** Predicado traducido o null si no es un mensaje conocido de class-validator. */
export function traducirPredicado(predicado: string): string | null {
  const limpio = String(predicado ?? '').trim();
  for (const [patron, traducir] of PREDICADOS) {
    const m = limpio.match(patron);
    if (m) return traducir(m);
  }
  return null;
}

const ES_INDICE = /^\d+$/;
const legible = (texto: string): string => texto.replace(/_/g, ' ');

/** `items.0.cantidad` → `«cantidad» (fila 1 de «items»)`; `nombre` → `«nombre»`. */
export function etiquetaCampo(ruta: string): string {
  const partes = String(ruta ?? '').split('.').filter(Boolean);
  if (!partes.length) return '«dato»';
  const nombre = partes[partes.length - 1];

  if (ES_INDICE.test(nombre)) {
    const lista = partes.length > 1 ? partes[partes.length - 2] : 'lista';
    return `«${legible(lista)}» (fila ${Number(nombre) + 1})`;
  }
  for (let i = partes.length - 2; i >= 1; i--) {
    if (ES_INDICE.test(partes[i])) {
      return `«${legible(nombre)}» (fila ${Number(partes[i]) + 1} de «${legible(partes[i - 1])}»)`;
    }
  }
  return `«${legible(partes.join('.'))}»`;
}

/** Traduce un mensaje de class-validator del campo `propiedad` (cuya ruta completa es `ruta`). */
export function traducirMensajeValidacion(mensaje: string, propiedad: string, ruta: string): string {
  const texto = String(mensaje ?? '').trim();
  const etiqueta = etiquetaCampo(ruta || propiedad);

  if (texto === `nested property ${propiedad} must be either object or array`) {
    return `El campo ${etiqueta} debe ser un objeto o una lista.`;
  }
  if (texto === `property ${propiedad} should not exist`) {
    return `El campo ${etiqueta} no está permitido.`;
  }
  if (texto === 'an unknown value was passed to the validate function') {
    return 'Se envió un dato que no corresponde a esta operación.';
  }

  const prefijoCada = `each value in ${propiedad} `;
  if (texto.startsWith(prefijoCada)) {
    const predicado = traducirPredicado(texto.slice(prefijoCada.length));
    return predicado ? `Cada valor de ${etiqueta} ${predicado}.` : `Uno de los valores de ${etiqueta} no es válido.`;
  }

  if (texto.startsWith(`${propiedad} `)) {
    const resto = texto.slice(propiedad.length + 1);
    const predicado = traducirPredicado(resto);
    if (predicado) return `El campo ${etiqueta} ${predicado}.`;
    if (/^(must|should|is not)\b/.test(resto)) return `El campo ${etiqueta} no es válido.`;
  }
  return texto;
}

const MENSAJE_SUELTO = /^(?:each value in |nested property |property )?(\S+) (?:must|should|is not)\b/;

/**
 * Traduce un mensaje de class-validator que ya viene aplanado con su ruta
 * (`items.0.cantidad must not be less than 1`), como los que arma el
 * ValidationPipe por defecto de Nest. Si no lo reconoce lo devuelve igual.
 */
export function traducirMensajeSuelto(texto: string): string {
  const limpio = String(texto ?? '').trim();
  const m = MENSAJE_SUELTO.exec(limpio);
  return m ? traducirMensajeValidacion(limpio, m[1], m[1]) : limpio;
}

export interface ErrorDeCampo {
  /** Ruta del campo, p. ej. `items.0.cantidad`. */
  readonly ruta: string;
  readonly mensajes: readonly string[];
}

/** Aplana los errores anidados (DTO dentro de DTO o de listas) con su ruta completa. */
export function aplanarErroresValidacion(errores: readonly ValidationError[], prefijo = ''): ErrorDeCampo[] {
  const resultado: ErrorDeCampo[] = [];
  for (const error of errores ?? []) {
    const ruta = prefijo ? `${prefijo}.${error.property}` : String(error.property ?? '');
    const mensajes = Object.values(error.constraints ?? {}).map((m) =>
      traducirMensajeValidacion(m, String(error.property ?? ''), ruta),
    );
    if (mensajes.length) resultado.push({ ruta, mensajes });
    if (error.children?.length) resultado.push(...aplanarErroresValidacion(error.children, ruta));
  }
  return resultado;
}

export const CODIGO_VALIDACION = 'VALIDACION';
const MENSAJE_GENERICO = 'Los datos enviados no son válidos.';

export interface CuerpoErrorValidacion {
  readonly statusCode: 400;
  readonly message: string[];
  readonly error: string;
  readonly codigo: typeof CODIGO_VALIDACION;
  /** Rutas de los campos con error, para resaltarlos en el formulario. */
  readonly campos: string[];
}

/** Cuerpo del 400 de validación: `message` sigue siendo un arreglo, como en Nest. */
export function cuerpoErrorValidacion(errores: readonly ValidationError[]): CuerpoErrorValidacion {
  const porCampo = aplanarErroresValidacion(errores);
  const mensajes = Array.from(new Set(porCampo.flatMap((c) => c.mensajes)));
  return {
    statusCode: 400,
    message: mensajes.length ? mensajes : [MENSAJE_GENERICO],
    error: 'Solicitud inválida',
    codigo: CODIGO_VALIDACION,
    campos: Array.from(new Set(porCampo.map((c) => c.ruta))),
  };
}

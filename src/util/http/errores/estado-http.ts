/** Frases, códigos y mensajes por defecto de cada estado HTTP, en español. */

const FRASES: Readonly<Record<number, string>> = {
  400: 'Solicitud inválida',
  401: 'No autenticado',
  402: 'Pago requerido',
  403: 'Sin permiso',
  404: 'No encontrado',
  405: 'Método no permitido',
  406: 'No aceptable',
  408: 'Tiempo de espera agotado',
  409: 'Conflicto',
  410: 'Ya no disponible',
  411: 'Falta la longitud del contenido',
  412: 'Condición previa fallida',
  413: 'Contenido demasiado grande',
  414: 'Dirección demasiado larga',
  415: 'Tipo de contenido no soportado',
  422: 'Datos no procesables',
  423: 'Recurso bloqueado',
  428: 'Se requiere una condición previa',
  429: 'Demasiadas solicitudes',
  431: 'Cabeceras demasiado grandes',
  500: 'Error interno del servidor',
  501: 'No implementado',
  502: 'Error en un servicio externo',
  503: 'Servicio no disponible',
  504: 'Tiempo de espera agotado',
};

const CODIGOS: Readonly<Record<number, string>> = {
  400: 'SOLICITUD_INVALIDA',
  401: 'NO_AUTENTICADO',
  403: 'SIN_PERMISO',
  404: 'NO_ENCONTRADO',
  405: 'METODO_NO_PERMITIDO',
  406: 'NO_ACEPTABLE',
  408: 'TIEMPO_AGOTADO',
  409: 'CONFLICTO',
  410: 'NO_DISPONIBLE',
  413: 'ARCHIVO_MUY_GRANDE',
  414: 'SOLICITUD_INVALIDA',
  415: 'TIPO_NO_SOPORTADO',
  422: 'DATOS_NO_PROCESABLES',
  429: 'DEMASIADAS_SOLICITUDES',
  500: 'ERROR_SERVIDOR',
  501: 'NO_IMPLEMENTADO',
  502: 'SERVICIO_EXTERNO_NO_DISPONIBLE',
  503: 'SERVICIO_NO_DISPONIBLE',
  504: 'TIEMPO_AGOTADO',
};

const MENSAJES: Readonly<Record<number, string>> = {
  400: 'La solicitud no es válida.',
  401: 'Tu sesión no es válida o expiró. Inicia sesión nuevamente.',
  403: 'No tienes permiso para realizar esta acción.',
  404: 'No se encontró lo solicitado.',
  405: 'Esta operación no está permitida en esta ruta.',
  406: 'El servidor no puede responder en el formato solicitado.',
  408: 'La solicitud tardó demasiado en llegar. Intente de nuevo.',
  409: 'La operación entra en conflicto con el estado actual de los datos.',
  410: 'Lo solicitado ya no está disponible.',
  413: 'Los datos o el archivo enviados superan el tamaño permitido.',
  414: 'La dirección de la solicitud es demasiado larga.',
  415: 'El tipo de contenido enviado no es compatible.',
  422: 'Los datos enviados no se pueden procesar.',
  429: 'Demasiadas solicitudes seguidas. Espere unos segundos e intente de nuevo.',
  500: 'Ocurrió un error interno. Intente de nuevo; si continúa, avise a sistemas con el código de soporte.',
  501: 'Esta función aún no está disponible.',
  502: 'Un servicio externo respondió con un error. Intente de nuevo en unos segundos.',
  503: 'El servicio no está disponible en este momento. Intente de nuevo en unos segundos.',
  504: 'Un servicio tardó demasiado en responder. Intente de nuevo en unos segundos.',
};

/** El estado como número válido de error (400-599); cualquier otra cosa es 500. */
export function estadoDeError(estado: unknown): number {
  const n = typeof estado === 'number' ? estado : Number(estado);
  return Number.isInteger(n) && n >= 400 && n <= 599 ? n : 500;
}

export function fraseEstado(estado: number): string {
  return FRASES[estado] ?? (estado >= 500 ? FRASES[500] : FRASES[400]);
}

export function codigoPorEstado(estado: number): string {
  return CODIGOS[estado] ?? (estado >= 500 ? CODIGOS[500] : CODIGOS[400]);
}

export function mensajePorEstado(estado: number): string {
  return MENSAJES[estado] ?? (estado >= 500 ? MENSAJES[500] : MENSAJES[400]);
}

/** Frases en inglés que Nest pone en `error` (se reemplazan por la frase en español). */
const FRASES_INGLES = new Set(
  [
    'Bad Request', 'Unauthorized', 'Payment Required', 'Forbidden', 'Not Found', 'Method Not Allowed',
    'Not Acceptable', 'Proxy Authentication Required', 'Request Timeout', 'Conflict', 'Gone',
    'Length Required', 'Precondition Failed', 'Payload Too Large', 'URI Too Long', 'Unsupported Media Type',
    'Requested Range Not Satisfiable', 'Expectation Failed', "I'm a teapot", 'Misdirected',
    'Unprocessable Entity', 'Locked', 'Failed Dependency', 'Precondition Required', 'Too Many Requests',
    'Internal Server Error', 'Not Implemented', 'Bad Gateway', 'Service Unavailable', 'Gateway Timeout',
    'HTTP Version Not Supported',
  ].map((f) => f.toLowerCase()),
);

export function esFraseInglesaDeNest(texto: unknown): boolean {
  return typeof texto === 'string' && FRASES_INGLES.has(texto.trim().toLowerCase());
}

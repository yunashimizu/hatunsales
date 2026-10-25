import { CdrLeido, leerCdr } from '../nucleo/cdr/lector-cdr';
import { verificarCdr } from '../nucleo/cdr/verificar-cdr';
import { intentarParsearXml, ruta, texto } from '../nucleo/xml/lector-xml';
import { leerXmlDeZip } from '../nucleo/zip/paquete-zip';
import type { CdrGre, GreEsperada, ResultadoConsultaGre, ResultadoEnvioGre } from './gre.contrato';
import type { ErrorSunatGre } from './gre.tipos';

/**
 * Traduce las respuestas de la API REST de la GRE a un resultado normalizado. Puro: no lanza ni hace red.
 *
 * Fuentes: [GRE-M] Manual de servicios web de la Plataforma Nueva GRE (errores generales: HTTP 400–503 con
 * {cod, msg, exc}; validaciones funcionales HTTP 422 con errors[{codError, desError}]); [A13] anexo N.° 13
 * (POST devuelve un ticket; GET con el ticket devuelve el estado y, al terminar, la constancia);
 * [TERCERO] Greenter (gre-api y GreSender: numTicket, fecRecepcion, codRespuesta 98/0/99, error.numError/
 * desError, indCdrGenerado, arcCdr = ZIP en base64; lee 422 también como errors[{cod, msg}]).
 *
 * Regla de numeración (PLAN V3, D11): un rechazo de la GRE (codRespuesta 99 o 422 antes del ticket) NO
 * consume el número: se corrige y se reenvía con el mismo número.
 */

export interface RespuestaHttpLeidaGre {
  estadoHttp: number;
  cuerpo: string;
}

/** Credenciales SOL, perfil o RUC del archivo distinto al del usuario: se corrige en el panel, no en la guía ([XC], mismos textos que SOAP). */
const CODIGOS_CONFIGURACION = new Set(['0101', '0102', '0103', '0104', '0105', '0106', '0111', '0112', '0113', '0154']);

/** «Ya informado» / «registrado previamente con otros datos» en los servicios de comprobantes [XC]; para la GRE [NO VERIFICADO]. */
const CODIGOS_YA_REGISTRADA = new Set(['1032', '1033']);

/**
 * Descripciones solo para cuando SUNAT no manda su propio texto: 0151–0161 y 0154 de la tabla de errores de
 * SUNAT [XC]; 166 del ejemplo oficial de [GRE-M]; 0508/0509 de la consulta del ticket [TERCERO: verifac.pe].
 */
const DESCRIPCIONES_CONOCIDAS: Readonly<Record<string, string>> = {
  '0151': 'El nombre del archivo ZIP es incorrecto',
  '0154': 'El RUC del archivo no corresponde al RUC del usuario SOL',
  '0155': 'El archivo ZIP está vacío',
  '0156': 'El archivo ZIP está corrupto',
  '0157': 'El archivo ZIP no contiene comprobantes',
  '0158': 'El archivo ZIP contiene demasiados comprobantes para este tipo de envío',
  '0159': 'El nombre del archivo XML es incorrecto',
  '0160': 'El archivo XML está vacío',
  '0161': 'El nombre del archivo XML no coincide con el nombre del archivo ZIP',
  '0166': 'Código de ticket no enviado',
  '0508': 'El ticket no tiene un formato válido',
  '0509': 'El ticket no existe o pertenece a otro RUC',
};

const MAXIMO_CRUDO = 20 * 1024;
const PATRON_TICKET = /^[A-Za-z0-9-]{1,100}$/;

/** SUNAT manda los códigos con o sin ceros a la izquierda ('155' o '0155'): se comparan con 4 dígitos. */
function codigoParaBuscar(codigo: string): string {
  const limpio = codigo.trim();
  return /^\d{1,3}$/.test(limpio) ? limpio.padStart(4, '0') : limpio;
}

function esCodigoDe(conjunto: ReadonlySet<string>, error: ErrorSunatGre): boolean {
  return conjunto.has(codigoParaBuscar(error.codigo));
}

function comoObjeto(valor: unknown): Record<string, unknown> | null {
  return valor && typeof valor === 'object' && !Array.isArray(valor) ? (valor as Record<string, unknown>) : null;
}

function leerJson(cuerpo: string): Record<string, unknown> | null {
  try {
    const valor: unknown = JSON.parse(cuerpo);
    return comoObjeto(valor);
  } catch {
    return null;
  }
}

function textoCampo(objeto: Record<string, unknown> | null, campo: string): string {
  const valor = objeto?.[campo];
  return typeof valor === 'string' || typeof valor === 'number' ? String(valor).trim() : '';
}

/** Quita lo que nunca debe guardarse ni mostrarse: tokens, client_secret, password. */
export function redactarSecretosGre(valor: string): string {
  return valor
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTADO]')
    .replace(/("?(?:access_token|refresh_token|id_token|client_secret|password|clave|claveSol)"?\s*[:=]\s*"?)[^"&,\s}]+/gi, '$1[REDACTADO]');
}

/** Respuesta para auditoría: sin el CDR en base64 (va aparte) ni secretos, y a lo sumo 20 KB. */
export function crudoParaAuditoria(cuerpo: string): string {
  const json = leerJson(cuerpo);
  const contenido =
    json && typeof json.arcCdr === 'string' ? JSON.stringify({ ...json, arcCdr: `[arcCdr omitido: ${json.arcCdr.length} caracteres]` }) : cuerpo;
  const limpio = redactarSecretosGre(contenido);
  return limpio.length > MAXIMO_CRUDO ? `${limpio.slice(0, MAXIMO_CRUDO)}…[truncado]` : limpio;
}

/** errors[{codError, desError}] del manual o errors[{cod, msg}] de Greenter; si no hay lista, {cod, msg} de la raíz. */
function erroresDeRespuesta(json: Record<string, unknown> | null): ErrorSunatGre[] {
  if (!json) return [];
  const lista = Array.isArray(json.errors) ? json.errors : [];
  const errores = lista
    .map((elemento) => comoObjeto(elemento))
    .filter((elemento): elemento is Record<string, unknown> => elemento !== null)
    .map((elemento) => crearError(textoCampo(elemento, 'codError') || textoCampo(elemento, 'cod'), textoCampo(elemento, 'desError') || textoCampo(elemento, 'msg')))
    .filter((error) => error.codigo || error.descripcion);
  if (errores.length > 0) return errores;
  const codigo = textoCampo(json, 'cod');
  const descripcion = textoCampo(json, 'msg');
  return codigo || descripcion ? [crearError(codigo, descripcion)] : [];
}

function crearError(codigo: string, descripcion: string): ErrorSunatGre {
  const limpio = codigo.trim();
  return { codigo: limpio, descripcion: descripcion || DESCRIPCIONES_CONOCIDAS[codigoParaBuscar(limpio)] || 'SUNAT no dio la descripción del error.' };
}

function listarErrores(errores: readonly ErrorSunatGre[]): string {
  return errores
    .map((e) => {
      const descripcion = e.descripcion.replace(/[.\s]+$/, '');
      return e.codigo ? `${e.codigo} - ${descripcion}` : descripcion;
    })
    .join('; ');
}

function base(estadoHttp: number | null, cuerpo: string | null) {
  return { httpStatus: estadoHttp, crudo: cuerpo === null ? null : crudoParaAuditoria(cuerpo) };
}

/**
 * Por qué no hay respuesta de SUNAT que clasificar: falla de red o timeout (`red`), credenciales rechazadas
 * al pedir el token (`credenciales`), servicio de token caído (`token_no_disponible`) o datos que impiden
 * siquiera llamar (`invalido`).
 */
export type MotivoSinRespuestaGre = 'red' | 'credenciales' | 'token_no_disponible' | 'invalido';

// ── Envío (POST del ZIP) ──────────────────────────────────────────────────────

/** Resultado del envío cuando no hubo respuesta de SUNAT o no se llegó a enviar (falló el token). */
export function envioSinRespuesta(motivo: MotivoSinRespuestaGre, detalle: string): ResultadoEnvioGre {
  const comun = { ticket: null, fechaRecepcion: null, errores: [], httpStatus: null, crudo: null };
  switch (motivo) {
    case 'red':
      return {
        ...comun,
        estado: 'PENDIENTE_REENVIO',
        codigo: null,
        accion: 'REINTENTAR',
        mensaje: `No hubo respuesta de SUNAT (${detalle}): el envío quedó incierto. Reintente con el mismo archivo; si SUNAT ya lo recibió, lo indicará.`,
      };
    case 'token_no_disponible':
      return {
        ...comun,
        estado: 'PENDIENTE_REENVIO',
        codigo: null,
        accion: 'REINTENTAR',
        mensaje: `No se pudo obtener el permiso (token) de SUNAT: ${detalle}. No se envió la guía; reintente en unos minutos.`,
      };
    case 'credenciales':
      return {
        ...comun,
        estado: 'ERROR_CONFIG',
        codigo: null,
        accion: 'REVISAR_CONFIG',
        mensaje: `SUNAT no aceptó las credenciales de la GRE: ${detalle}. Revise el client_id, el client_secret y el usuario y clave SOL en el panel de facturación. No se envió la guía.`,
      };
    case 'invalido':
      return { ...comun, estado: 'ERROR_CONFIG', codigo: null, accion: 'REVISAR_CONFIG', mensaje: detalle };
  }
}

export function clasificarEnvioGre(respuesta: RespuestaHttpLeidaGre): ResultadoEnvioGre {
  const { estadoHttp, cuerpo } = respuesta;
  const json = leerJson(cuerpo);
  const comun = { ...base(estadoHttp, cuerpo), ticket: null, fechaRecepcion: null };

  if (estadoHttp >= 200 && estadoHttp < 300) {
    const ticket = textoCampo(json, 'numTicket');
    if (PATRON_TICKET.test(ticket)) {
      return {
        ...comun,
        estado: 'TICKET_PENDIENTE',
        ticket,
        fechaRecepcion: textoCampo(json, 'fecRecepcion') || null,
        codigo: null,
        errores: [],
        accion: 'CONSULTAR_TICKET',
        mensaje: `SUNAT recibió la guía (ticket ${ticket}). Consulte el ticket para obtener la constancia (CDR).`,
      };
    }
    return {
      ...comun,
      estado: 'PENDIENTE_REENVIO',
      codigo: null,
      errores: [],
      accion: 'REINTENTAR',
      mensaje: 'SUNAT respondió sin número de ticket: el envío quedó incierto. Reintente con el mismo archivo.',
    };
  }

  const errores = erroresDeRespuesta(json);
  const detalle = errores.length > 0 ? `: ${listarErrores(errores)}` : '';
  const codigo = errores[0]?.codigo || String(estadoHttp);

  if (estadoHttp >= 300 && estadoHttp < 400) {
    return {
      ...comun,
      estado: 'ERROR_CONFIG',
      codigo,
      errores,
      accion: 'REVISAR_CONFIG',
      mensaje: `SUNAT respondió con una redirección (HTTP ${estadoHttp}); por seguridad no se sigue. No se envió la guía: revise la conexión del servidor.`,
    };
  }
  if (estadoHttp === 401 || estadoHttp === 403) {
    return {
      ...comun,
      estado: 'ERROR_CONFIG',
      codigo,
      errores,
      accion: 'REVISAR_CONFIG',
      mensaje: `SUNAT rechazó la autorización (HTTP ${estadoHttp})${detalle}. Revise las credenciales de la API de SUNAT y el perfil del usuario SOL para emitir guías. No se envió la guía.`,
    };
  }
  if (estadoHttp === 422) {
    if (errores.some((e) => esCodigoDe(CODIGOS_CONFIGURACION, e))) {
      return {
        ...comun,
        estado: 'ERROR_CONFIG',
        codigo,
        errores,
        accion: 'REVISAR_CONFIG',
        mensaje: `SUNAT no recibió la guía por un problema de credenciales o permisos${detalle}. Corríjalo en el panel de facturación; la guía no se registró.`,
      };
    }
    return {
      ...comun,
      estado: 'RECHAZADA',
      codigo,
      errores,
      accion: 'CORREGIR_Y_REENVIAR',
      mensaje: `SUNAT rechazó la guía antes de recibirla${detalle}. El número no se consume: corrija y vuelva a enviarla con el mismo número.`,
    };
  }
  if (estadoHttp === 429 || estadoHttp >= 500) {
    return {
      ...comun,
      estado: 'PENDIENTE_REENVIO',
      codigo,
      errores,
      accion: 'REINTENTAR',
      mensaje: `SUNAT no pudo atender el envío (HTTP ${estadoHttp})${detalle}. El resultado es incierto: reintente con el mismo archivo.`,
    };
  }
  // 400, 404, 405, 406, 415…: la petición no se entendió; no hay ticket, así que la guía no se registró.
  return {
    ...comun,
    estado: 'ERROR_CONFIG',
    codigo,
    errores,
    accion: 'REVISAR_CONFIG',
    mensaje: `SUNAT no aceptó la solicitud (HTTP ${estadoHttp})${detalle}. La guía no se registró; avise a soporte técnico.`,
  };
}

// ── Consulta del ticket (GET) ─────────────────────────────────────────────────

/** Resultado de la consulta cuando no hubo respuesta: la guía sigue con su ticket, NUNCA se reenvía por esto. */
export function consultaSinRespuesta(motivo: MotivoSinRespuestaGre, detalle: string): ResultadoConsultaGre {
  const comun = { codigo: null, errores: [], cdr: null, httpStatus: null, crudo: null };
  switch (motivo) {
    case 'red':
    case 'token_no_disponible':
      return {
        ...comun,
        estado: 'TICKET_PENDIENTE',
        accion: 'CONSULTAR_TICKET',
        mensaje: `No se pudo consultar a SUNAT (${detalle}). La guía sigue enviada con su ticket: vuelva a consultar en unos minutos.`,
      };
    case 'credenciales':
      return {
        ...comun,
        estado: 'ERROR_CONFIG',
        accion: 'REVISAR_CONFIG',
        mensaje: `SUNAT no aceptó las credenciales de la GRE: ${detalle}. Revíselas en el panel de facturación y vuelva a consultar.`,
      };
    case 'invalido':
      return { ...comun, estado: 'ERROR_CONFIG', accion: 'REVISAR_CONFIG', mensaje: detalle };
  }
}

/** Enlace del QR: cac:DocumentResponse/cac:DocumentReference/cbc:DocumentDescription (así lo lee Greenter). */
function enlaceQrDeCdr(xml: string): string | null {
  const documento = intentarParsearXml(xml);
  const valor = documento ? texto(ruta(documento, 'DocumentResponse', 'DocumentReference', 'DocumentDescription')) : '';
  return valor && valor.length <= 2000 ? valor : null;
}

/** arcCdr es el ZIP de la constancia en base64; null si no se puede leer. */
function leerConstancia(arcCdr: string): { cdr: CdrGre; leido: CdrLeido } | null {
  const zip = Buffer.from(arcCdr.replace(/\s+/g, ''), 'base64');
  const contenido = leerXmlDeZip(zip);
  if (!contenido) return null;
  const leido = leerCdr(contenido.xml);
  if (leido.codigo === 'ERROR') return null;
  return {
    cdr: { nombre: contenido.nombre, xml: Buffer.from(contenido.xml, 'utf8'), zip, enlaceQr: enlaceQrDeCdr(contenido.xml) },
    leido,
  };
}

function pendiente(comun: { httpStatus: number | null; crudo: string | null }, mensaje: string, extra: Partial<ResultadoConsultaGre> = {}): ResultadoConsultaGre {
  return { ...comun, estado: 'TICKET_PENDIENTE', codigo: null, errores: [], accion: 'CONSULTAR_TICKET', cdr: null, mensaje, ...extra };
}

/** Rechazo con constancia o sin ella: el número no se consume (D11), salvo que SUNAT diga que ya estaba registrada. */
function rechazo(
  comun: { httpStatus: number | null; crudo: string | null },
  codigo: string,
  errores: ErrorSunatGre[],
  cdr: CdrGre | null,
): ResultadoConsultaGre {
  const yaRegistrada = errores.some((e) => esCodigoDe(CODIGOS_YA_REGISTRADA, e));
  const mensaje = yaRegistrada
    ? `SUNAT indica que esta guía ya estaba registrada (${listarErrores(errores)}). Antes de corregirla o reenviarla, verifique en SUNAT Operaciones en Línea si ya figura aceptada.`
    : `SUNAT rechazó la guía: ${listarErrores(errores)}. El número no se consume: corrija los datos y vuelva a enviarla con el mismo número.`;
  return { ...comun, estado: 'RECHAZADA', codigo, errores, accion: 'CORREGIR_Y_REENVIAR', cdr, mensaje };
}

export function clasificarConsultaGre(respuesta: RespuestaHttpLeidaGre, esperada?: GreEsperada): ResultadoConsultaGre {
  const { estadoHttp, cuerpo } = respuesta;
  const json = leerJson(cuerpo);
  const comun = base(estadoHttp, cuerpo);

  if (estadoHttp >= 200 && estadoHttp < 300) {
    if (!json) return pendiente(comun, 'SUNAT respondió algo que no se pudo leer. Vuelva a consultar el ticket en unos minutos.');
    const codRespuesta = textoCampo(json, 'codRespuesta');
    const arcCdr = textoCampo(json, 'arcCdr');
    const conCdr = textoCampo(json, 'indCdrGenerado') === '1' && arcCdr !== '';

    if (codRespuesta === '98') {
      return pendiente(comun, 'SUNAT aún está procesando la guía (código 98). Vuelva a consultar en unos minutos.', { codigo: '98' });
    }
    if (codRespuesta !== '0' && codRespuesta !== '99') {
      return pendiente(comun, `SUNAT devolvió un estado no reconocido (codRespuesta «${codRespuesta || 'vacío'}»). Vuelva a consultar en unos minutos.`);
    }

    if (!conCdr) {
      if (codRespuesta === '0') {
        return pendiente(comun, 'SUNAT la aceptó pero no entregó la constancia: vuelva a consultar.', { codigo: '0' });
      }
      const error = comoObjeto(json.error);
      const errores = [crearError(textoCampo(error, 'numError'), textoCampo(error, 'desError'))];
      return rechazo(comun, errores[0].codigo || '99', errores, null);
    }

    const constancia = leerConstancia(arcCdr);
    if (!constancia) {
      return pendiente(comun, 'SUNAT entregó una constancia (CDR) que no se pudo leer. Vuelva a consultar el ticket.', { codigo: codRespuesta });
    }
    const { cdr, leido } = constancia;
    if (esperada) {
      const verificacion = verificarCdr(cdr.xml, { rucEmisor: esperada.rucEmisor, tipo: '09', serie: esperada.serie, numero: esperada.numero });
      if (!verificacion.coincide) {
        const motivo = verificacion.motivo ?? 'La constancia (CDR) no corresponde a la guía enviada.';
        return pendiente(comun, `${motivo} No se da por aceptada ni rechazada: vuelva a consultar o revise la guía en SUNAT Operaciones en Línea.`, {
          codigo: leido.codigo,
          cdrNoCorresponde: motivo,
        });
      }
    }
    const observaciones = leido.observaciones.map((o) => crearError(o.codigo, o.descripcion));
    if (leido.estado === 'ACEPTADO' || leido.estado === 'ACEPTADO_CON_OBSERVACIONES') {
      return {
        ...comun,
        estado: 'ACEPTADA',
        codigo: leido.codigo,
        errores: [],
        observaciones,
        accion: 'NINGUNA',
        cdr,
        mensaje:
          observaciones.length > 0
            ? `SUNAT aceptó la guía con observaciones: ${listarErrores(observaciones)}.`
            : `SUNAT aceptó la guía${leido.descripcion ? `: ${leido.descripcion}` : '.'}`,
      };
    }
    // ResponseCode de rechazo o excepción (con codRespuesta 0 o 99): manda la constancia.
    const errores = [crearError(leido.codigo, leido.descripcion), ...observaciones];
    return rechazo(comun, leido.codigo, errores, cdr);
  }

  const errores = erroresDeRespuesta(json);
  const detalle = errores.length > 0 ? `: ${listarErrores(errores)}` : '';
  const codigo = errores[0]?.codigo || String(estadoHttp);
  if (estadoHttp === 429 || estadoHttp >= 500) {
    return pendiente(comun, `SUNAT no pudo atender la consulta (HTTP ${estadoHttp})${detalle}. La guía sigue enviada: vuelva a consultar en unos minutos.`, { codigo, errores });
  }
  if (estadoHttp === 401 || estadoHttp === 403) {
    return {
      ...comun,
      estado: 'ERROR_CONFIG',
      codigo,
      errores,
      accion: 'REVISAR_CONFIG',
      cdr: null,
      mensaje: `SUNAT rechazó la autorización de la consulta (HTTP ${estadoHttp})${detalle}. Revise las credenciales de la API de SUNAT y vuelva a consultar.`,
    };
  }
  return {
    ...comun,
    estado: 'ERROR_CONFIG',
    codigo,
    errores,
    accion: 'REVISAR_CONFIG',
    cdr: null,
    mensaje: `SUNAT no pudo consultar el ticket (HTTP ${estadoHttp})${detalle}. Verifique el ticket guardado y las credenciales; si persiste, revise la guía en SUNAT Operaciones en Línea.`,
  };
}

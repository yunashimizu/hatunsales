import type {
  AccionSunat,
  ClasificacionRespuesta,
  ContextoClasificacion,
  EstadoSunat,
  ObservacionSunat,
  RespuestaSunat,
} from './documento-fiscal.types';
import { admiteGetStatusCdr, esDocumentoDeFactura } from './reglas-envio';
import { estadoDeConsulta } from './soap/estados-consulta-sunat';

/**
 * Tabla de decisión ante cada respuesta de SUNAT (design §7.3). Los rangos son
 * oficiales (Manual del Programador §4.1): 0100–0999 excepción de SUNAT,
 * 1000–1999 excepción del contribuyente (no informado: se corrige y se
 * reenvía con el mismo número), 2000–3999 rechazo (en comprobantes el número
 * queda usado; en RC/RA no), 4000+ observación (aceptado).
 * Los códigos con trato propio se revisan ANTES que los rangos (p. ej. 2109 o el
 * certificado 2325 no son un rechazo corriente). Textos verificados en la tabla de
 * códigos de SUNAT; si SUNAT publica un código nuevo se agrega aquí.
 */

/** Usuario/clave SOL (0102–0106), encabezado de seguridad (0101), perfil o afiliación (0111–0113), RUC del archivo ≠ usuario (0154). */
export const CODIGOS_FAULT_CONFIGURACION = new Set(['0101', '0102', '0103', '0104', '0105', '0106', '0111', '0112', '0113', '0154']);

/**
 * Credencial SOL rechazada: los faults de configuración y 2107 («Numero de RUC SOL no coincide con
 * RUC emisor»). Reintentar con la misma clave no sirve y puede bloquear el usuario SOL: abre el
 * interruptor del ambiente (bloqueaEmision).
 */
export const CODIGOS_CREDENCIAL_SOL = new Set([...CODIGOS_FAULT_CONFIGURACION, '2107']);

/** Certificado no comunicado a SUNAT (2325), de baja (2326), no vigente (2327) o revocado (2328): también abre el interruptor. */
export const CODIGOS_CERTIFICADO = new Set(['2325', '2326', '2327', '2328']);

/** El emisor no está habilitado: 1078 (no autorizado en SEE-Desde los sistemas del contribuyente) y 2012 (no autorizado a emitir electrónicos). */
export const CODIGOS_EMISOR_NO_HABILITADO = new Set(['1078', '2012']);

/** Fallas temporales del servicio de SUNAT y 0140 (otro envío igual en proceso): reintentar con backoff (en producción, consultando antes). */
export const CODIGOS_FAULT_TRANSITORIOS = new Set([
  '0100', '0109', '0110', '0125', '0130', '0131', '0132', '0133', '0134', '0135', '0136', '0137', '0138', '0140',
  '0200', '0201', '0202', '0203', '0204', '0250', '0251', '0252', '0253', '0303', '0304', '0307',
]);

/** El paquete enviado es incorrecto (nombre, ZIP o XML ilegible, referencia inexistente): corregir antes de reenviar. */
export const CODIGOS_FAULT_PAQUETE = new Set([
  '0150', '0151', '0152', '0153', '0155', '0156', '0157', '0158', '0159', '0160', '0161',
  '0300', '0301', '0302', '0305', '0306', '0403', '0404',
]);

/**
 * SUNAT ya recibió ese número: 0402/2403 «la numeración ya ha sido enviada anteriormente» y
 * 1033/2109 «registrado previamente con otros datos». No se reenvía a ciegas: se recupera la
 * constancia (getStatusCdr, solo facturas y sus notas en producción) o se verifica en SOL.
 */
export const CODIGOS_RECUPERAR_CDR = new Set(['1033', '0402', '2109', '2403']);

/** Con estos la constancia de SUNAT puede ser de OTRO contenido con el mismo número. */
const CODIGOS_REGISTRADO_CON_OTROS_DATOS = new Set(['1033', '2109']);

/** El comprobante ya está informado y anulado o rechazado (1032, 2987): no se puede reenviar con ese número. */
export const CODIGOS_YA_INFORMADO_INVALIDO = new Set(['1032', '2987']);

/** 1079: la boleta pasó su plazo de envío individual y solo puede ir en un resumen diario. */
export const CODIGOS_SOLO_RESUMEN_DIARIO = new Set(['1079']);

/**
 * Fuera de plazo: presentación fuera de fecha (2108, 2600, 2950) y bajas fuera de plazo (2374,
 * 2376, 2379, 2957, 2958). Es del documento: no bloquea la emisión y reenviar no lo arregla.
 */
export const CODIGOS_FUERA_DE_PLAZO = new Set(['2108', '2600', '2950', '2374', '2376', '2379', '2957', '2958']);

const CODIGOS_BAJA_FUERA_DE_PLAZO = new Set(['2374', '2376', '2379', '2957', '2958']);

/** «El documento electrónico ingresado ha sido alterado»: el XML no coincide con su firma (falla técnica, no del emisor). */
export const CODIGOS_DOCUMENTO_ALTERADO = new Set(['2334', '2335']);

/** El ticket consultado no existe o no es del usuario: hay que volver a enviar el resumen. */
export const CODIGOS_TICKET_INVALIDO = new Set(['0126', '0127']);

/** Errores de red y HTTP que justifican reintentar. */
export const CODIGOS_TRANSPORTE_TRANSITORIOS = new Set([
  'ETIMEDOUT', 'ECONNRESET', 'ECONNABORTED', 'ECONNREFUSED', 'EPIPE', 'EAI_AGAIN', 'ENOTFOUND', 'ENETUNREACH', 'EHOSTUNREACH',
  'ESOCKETTIMEDOUT', 'ERROR_RED', 'ERROR_DESCONOCIDO', 'RESPUESTA_INVALIDA', 'CDR_ILEGIBLE', 'HTTP_408', 'HTTP_429',
]);

export interface RegistroAdvertencias {
  warn(mensaje: string): void;
}

const consola: RegistroAdvertencias = { warn: (mensaje) => console.warn(`[SUNAT] ${mensaje}`) };

function decision(estado: EstadoSunat, accion: AccionSunat, mensajeUsuario: string): ClasificacionRespuesta {
  return { estado, accion, mensajeUsuario };
}

function detalleObservaciones(observaciones: readonly ObservacionSunat[]): string {
  return observaciones
    .slice(0, 5)
    .map((o) => (o.codigo ? `${o.codigo} - ${o.descripcion}` : o.descripcion))
    .join('; ');
}

function numero(codigo: string): number | null {
  return /^\d{1,4}$/.test(codigo) ? Number(codigo) : null;
}

/** '402' → '0402': los conjuntos usan siempre 4 dígitos. */
function cuatroDigitos(codigo: string): string {
  return /^\d{1,4}$/.test(codigo) ? codigo.padStart(4, '0') : codigo;
}

export class ClasificadorRespuestaSunat {
  constructor(private readonly registro: RegistroAdvertencias = consola) {}

  clasificar(respuesta: RespuestaSunat, contexto: ContextoClasificacion): ClasificacionRespuesta {
    const codigo = String(respuesta?.codigo ?? '').trim();
    switch (respuesta?.tipo) {
      case 'CDR':
        return this.porCdr(respuesta, codigo, contexto);
      case 'TICKET':
        return decision('TICKET_PENDIENTE', 'CONSULTAR_TICKET', respuesta.statusCode === '98'
          ? 'SUNAT sigue procesando el lote; se consultará el ticket nuevamente.'
          : `SUNAT recibió el lote (ticket ${respuesta.ticket ?? ''}); se consultará su resultado.`);
      case 'ESTADO':
        return this.porEstado(respuesta, codigo, contexto);
      case 'FAULT':
        return this.porFault(respuesta, codigo, contexto);
      case 'NO_DISPONIBLE':
        return this.consultaNoDisponible(respuesta, contexto);
      case 'TRANSPORTE':
        return this.porTransporte(respuesta, codigo);
      default:
        this.registro.warn(`Respuesta de SUNAT sin tipo reconocido: ${String(respuesta?.tipo)}`);
        return decision('PENDIENTE_REENVIO', 'REINTENTAR', 'No se pudo interpretar la respuesta de SUNAT; se reintentará.');
    }
  }

  /** RC y RA (envío o consulta de su ticket): un rechazo no invalida números. */
  private esLote(contexto: ContextoClasificacion): boolean {
    return contexto.operacion === 'resumen' || contexto.operacion === 'baja' || contexto.etapa === 'consulta_ticket';
  }

  private porCdr(respuesta: RespuestaSunat, codigo: string, contexto: ContextoClasificacion): ClasificacionRespuesta {
    const valor = numero(codigo);
    const observaciones = respuesta.observaciones ?? [];
    const descripcion = `${codigo} - ${respuesta.descripcion}`;
    if (valor === 0 && observaciones.length === 0) {
      return decision('ACEPTADO', 'NINGUNA', respuesta.descripcion || 'SUNAT aceptó el comprobante.');
    }
    if (valor === 0 || (valor !== null && valor >= 4000)) {
      const notas = observaciones.length > 0 ? detalleObservaciones(observaciones) : descripcion;
      return decision('ACEPTADO_OBS', 'NINGUNA', `SUNAT aceptó con observaciones: ${notas}. Corríjalas en los próximos comprobantes.`);
    }
    const conocido = valor !== null ? this.porCodigoConocido(cuatroDigitos(codigo), descripcion, contexto, true) : null;
    if (conocido) return conocido;
    if (valor !== null && valor >= 2000) return this.rechazo(descripcion, contexto);
    if (valor !== null && valor >= 100) return this.excepcion(descripcion);
    this.registro.warn(`CDR con ResponseCode desconocido "${codigo}"`);
    return decision('PENDIENTE_REENVIO', 'REINTENTAR', `SUNAT devolvió una constancia con un código no reconocido (${codigo}); se consultará de nuevo.`);
  }

  /**
   * Consulta sin constancia: getStatus de un ticket (RC/RA) o billConsultService (tabla 0001–0012
   * del anexo 2 del Manual). Los errores documentados de la consulta (0004–0010, 0012) nunca vuelven
   * a PENDIENTE_REENVIO: repetirla con los mismos datos da lo mismo y la tarea la reintentaría en vano.
   * Solo un código no documentado se reintenta (con aviso en el registro).
   */
  private porEstado(respuesta: RespuestaSunat, codigo: string, contexto: ContextoClasificacion): ClasificacionRespuesta {
    const descripcion = `${codigo} - ${respuesta.descripcion}`;
    if (this.esLote(contexto)) {
      if (respuesta.estadoComprobante === 'RECHAZADO' || codigo === '99') {
        return decision('RECHAZADO', 'CORREGIR_Y_REENVIAR', `SUNAT procesó el lote con errores (${descripcion}). Los números no se invalidan: corrija y envíe un nuevo resumen.`);
      }
      return decision('TICKET_PENDIENTE', 'CONSULTAR_TICKET', `Estado del ticket: ${descripcion}. Se consultará nuevamente.`);
    }
    const estado = respuesta.estadoComprobante && respuesta.estadoComprobante !== 'DESCONOCIDO' ? respuesta.estadoComprobante : estadoDeConsulta(codigo);
    switch (estado) {
      case 'ACEPTADO':
        return decision('ACEPTADO', 'NINGUNA', `SUNAT confirma que el comprobante está aceptado (${descripcion}).`);
      case 'RECHAZADO':
        return decision('RECHAZADO', 'EMITIR_NUEVO', `SUNAT tiene el comprobante como rechazado (${descripcion}): emita un comprobante nuevo.`);
      case 'DE_BAJA':
        return decision('ANULADO', 'NINGUNA', `SUNAT tiene el comprobante dado de baja (${descripcion}).`);
      case 'NO_EXISTE':
        return decision('PENDIENTE_REENVIO', 'REINTENTAR', 'SUNAT no tiene registrado el comprobante: se reenviará el mismo XML.');
      case 'CONSULTA_INVALIDA':
        return decision(
          'EXCEPCION',
          'NINGUNA',
          `SUNAT no aceptó los datos de la consulta (${descripcion}); repetirla no cambiará la respuesta. Verifique el comprobante en SUNAT Operaciones en Línea.`,
        );
      case 'NO_AUTORIZADO':
        return decision(
          'ERROR_CONFIG',
          'REVISAR_CONFIG',
          `SUNAT no permite consultar ese comprobante con este usuario (${descripcion}). Revise el RUC del emisor y el usuario SOL en Panel → Facturación SUNAT; no se reintentará automáticamente.`,
        );
      default:
        break;
    }
    this.registro.warn(`Consulta de SUNAT con estado no reconocido "${codigo}": ${respuesta.descripcion}`);
    return decision('PENDIENTE_REENVIO', 'REINTENTAR', `SUNAT respondió la consulta con el estado ${descripcion}; se reintentará.`);
  }

  private porFault(respuesta: RespuestaSunat, codigo: string, contexto: ContextoClasificacion): ClasificacionRespuesta {
    const descripcion = `${codigo} - ${respuesta.descripcion}`;
    const normalizado = cuatroDigitos(codigo);
    const conocido = this.porCodigoConocido(normalizado, descripcion, contexto, false);
    if (conocido) return conocido;
    if (CODIGOS_TICKET_INVALIDO.has(normalizado) && this.esLote(contexto)) {
      return decision('EXCEPCION', 'CORREGIR_Y_REENVIAR', `El ticket no es válido (${descripcion}): vuelva a enviar el resumen.`);
    }
    if (CODIGOS_FAULT_PAQUETE.has(normalizado)) return this.excepcion(descripcion);
    if (normalizado === '0140') {
      return decision('PENDIENTE_REENVIO', 'REINTENTAR', `SUNAT todavía está procesando otro envío igual de este comprobante (${descripcion}); se volverá a intentar más tarde.`);
    }
    if (CODIGOS_FAULT_TRANSITORIOS.has(normalizado)) {
      return decision('PENDIENTE_REENVIO', 'REINTENTAR', `SUNAT no pudo confirmar el resultado (${descripcion}). Revise el estado antes de solicitar manualmente el reenvío del mismo XML.`);
    }

    const valor = numero(codigo);
    if (valor !== null && valor >= 100 && valor <= 999) {
      this.registro.warn(`Fault de SUNAT no catalogado ${codigo}: ${respuesta.descripcion}`);
      return decision('PENDIENTE_REENVIO', 'REINTENTAR', `SUNAT respondió una excepción (${descripcion}); se reintentará.`);
    }
    if (valor !== null && valor >= 1000 && valor <= 1999) return this.excepcion(descripcion);
    if (valor !== null && valor >= 2000 && valor <= 3999) return this.rechazo(descripcion, contexto);
    if (valor !== null && valor >= 4000) {
      this.registro.warn(`Fault de SUNAT con código de observación ${codigo}: ${respuesta.descripcion}`);
      return this.excepcion(descripcion);
    }
    this.registro.warn(`Fault de SUNAT sin código numérico: ${respuesta.codigo} ${respuesta.descripcion}`);
    return decision('PENDIENTE_REENVIO', 'REINTENTAR', `SUNAT devolvió un error sin código (${respuesta.descripcion}); se reintentará.`);
  }

  /**
   * Códigos con trato propio, igual si llegan como Fault o en la constancia. `enCdr`: vino en un CDR
   * (en un comprobante el número ya quedó usado en SUNAT).
   */
  private porCodigoConocido(codigo: string, descripcion: string, contexto: ContextoClasificacion, enCdr: boolean): ClasificacionRespuesta | null {
    const lote = this.esLote(contexto);
    const numeroUsado = enCdr && !lote ? ' Este número ya quedó usado en SUNAT: el comprobante deberá emitirse de nuevo.' : '';
    if (CODIGOS_CREDENCIAL_SOL.has(codigo)) {
      return {
        ...decision(
          'ERROR_CONFIG',
          'REVISAR_CONFIG',
          `SUNAT rechazó la credencial SOL del emisor (${descripcion}). Corrija el usuario y la clave SOL en Panel → Facturación SUNAT y luego reanude la emisión; mientras tanto no se enviarán más comprobantes de este ambiente.${numeroUsado}`,
        ),
        bloqueaEmision: true,
      };
    }
    if (CODIGOS_CERTIFICADO.has(codigo)) {
      return {
        ...decision(
          'ERROR_CONFIG',
          'REVISAR_CONFIG',
          `SUNAT rechazó el certificado digital del emisor (${descripcion}). Corrija el certificado (registrado en SOL, vigente y no revocado) en Panel → Facturación SUNAT y luego reanude la emisión; mientras tanto no se enviarán más comprobantes de este ambiente.${numeroUsado}`,
        ),
        bloqueaEmision: true,
      };
    }
    if (CODIGOS_EMISOR_NO_HABILITADO.has(codigo)) {
      return decision(
        'ERROR_CONFIG',
        'REVISAR_CONFIG',
        `SUNAT indica que el emisor no está habilitado para emitir comprobantes electrónicos desde su propio sistema (${descripcion}). Complete el alta como emisor electrónico en SUNAT Operaciones en Línea; no se reintentará automáticamente.${numeroUsado}`,
      );
    }
    if (CODIGOS_FUERA_DE_PLAZO.has(codigo)) return this.fueraDePlazo(codigo, descripcion, contexto);
    if (CODIGOS_DOCUMENTO_ALTERADO.has(codigo)) {
      return decision(
        'EXCEPCION',
        'NINGUNA',
        `SUNAT indica que el XML recibido no coincide con su firma (${descripcion}). Es una falla técnica: revise la firma o la codificación del XML antes de volver a emitir.${numeroUsado}`,
      );
    }
    // Lo que sigue es propio de un comprobante: en el CDR de un resumen o de una baja manda el rechazo del lote.
    if (enCdr && lote) return null;
    if (CODIGOS_RECUPERAR_CDR.has(codigo)) {
      const hecho = CODIGOS_REGISTRADO_CON_OTROS_DATOS.has(codigo)
        ? `SUNAT indica que ese número ya fue registrado antes con otros datos (${descripcion}).`
        : `SUNAT indica que ya recibió este comprobante (${descripcion}).`;
      return decision('PENDIENTE_REENVIO', 'RECUPERAR_CDR', `${hecho} ${this.pasoParaRecuperar(contexto)}`);
    }
    if (CODIGOS_YA_INFORMADO_INVALIDO.has(codigo)) {
      return decision('RECHAZADO', 'EMITIR_NUEVO', `SUNAT ya tiene este comprobante como anulado o rechazado (${descripcion}): emita uno nuevo.`);
    }
    if (CODIGOS_SOLO_RESUMEN_DIARIO.has(codigo)) {
      return decision('EXCEPCION', 'NINGUNA', `Fuera del plazo de envío individual: la boleta solo puede informarse en un resumen diario (${descripcion}).`);
    }
    return null;
  }

  /**
   * Qué pasa después de un «ya recibido». Solo en producción y para facturas y sus notas (serie F)
   * existe getStatusCdr; boletas, notas de boleta y BETA se verifican a mano en SOL y se confirman.
   */
  private pasoParaRecuperar(contexto: ContextoClasificacion): string {
    if (!contexto.ambiente) {
      return 'No reenvíe el ZIP a ciegas: primero recupere la constancia (CDR) o verifique el comprobante en SUNAT.';
    }
    if (contexto.ambiente === 'produccion' && contexto.tipo && admiteGetStatusCdr(contexto.tipo, contexto.serie ?? '')) {
      return 'No se reenviará el ZIP: se consultará la constancia (CDR) a SUNAT antes de reenviar.';
    }
    return 'No se reenviará el ZIP: verifique en SUNAT Operaciones en Línea y confirme el resultado.';
  }

  /** La consulta no se pudo hacer (BETA no tiene el servicio; boletas y series B no se consultan): queda a verificación manual. */
  private consultaNoDisponible(respuesta: RespuestaSunat, contexto: ContextoClasificacion): ClasificacionRespuesta {
    const motivo = (respuesta.descripcion ?? '').trim() || 'SUNAT no permite consultar este comprobante por servicio web.';
    const paso = contexto.ambiente || contexto.tipo
      ? 'Verifique en SUNAT Operaciones en Línea y confirme el resultado; no reenvíe el ZIP a ciegas.'
      : 'Verifique el comprobante en SUNAT antes de reenviar el ZIP.';
    return decision('PENDIENTE_REENVIO', 'RECUPERAR_CDR', `${motivo} ${paso}`);
  }

  /** Plazos vencidos: el documento ya no puede ir por esta vía; reenviar no lo arregla y no es un problema del emisor. */
  private fueraDePlazo(codigo: string, descripcion: string, contexto: ContextoClasificacion): ClasificacionRespuesta {
    if (CODIGOS_BAJA_FUERA_DE_PLAZO.has(codigo) || contexto.operacion === 'baja') {
      return decision('EXCEPCION', 'NINGUNA', `Fuera de plazo: SUNAT ya no acepta la baja de este comprobante (${descripcion}). Anúlelo con una nota de crédito.`);
    }
    if (contexto.operacion === 'resumen' || contexto.etapa === 'consulta_ticket') {
      return decision(
        'EXCEPCION',
        'NINGUNA',
        `Fuera de plazo: SUNAT no aceptó el resumen por estar fuera del plazo permitido (${descripcion}). Esos documentos ya no pueden informarse por esta vía: consulte con su contador cómo regularizarlos.`,
      );
    }
    const regimen = this.regimenDelDocumento(contexto);
    if (regimen === 'boleta') {
      return decision('EXCEPCION', 'NINGUNA', `Fuera del plazo de envío individual: informe la boleta por resumen diario en SUNAT (${descripcion}).`);
    }
    if (regimen === 'factura') {
      return decision('EXCEPCION', 'NINGUNA', `Fuera de plazo: SUNAT ya no recibe este comprobante (${descripcion}). Emita un comprobante nuevo.`);
    }
    return decision('EXCEPCION', 'NINGUNA', `Fuera de plazo: SUNAT ya no recibe este documento por esta vía (${descripcion}).`);
  }

  /** Factura y sus notas, o boleta y sus notas (la nota sigue la letra de su serie); null si el contexto no lo dice. */
  private regimenDelDocumento(contexto: ContextoClasificacion): 'factura' | 'boleta' | null {
    if (contexto.tipo === '01') return 'factura';
    if (contexto.tipo === '03') return 'boleta';
    if ((contexto.tipo === '07' || contexto.tipo === '08') && contexto.serie) {
      return esDocumentoDeFactura(contexto.tipo, contexto.serie) ? 'factura' : 'boleta';
    }
    return null;
  }

  private porTransporte(respuesta: RespuestaSunat, codigo: string): ClasificacionRespuesta {
    const http = /^HTTP_(\d{3})$/.exec(codigo);
    if (http && Number(http[1]) >= 400 && Number(http[1]) < 500 && !CODIGOS_TRANSPORTE_TRANSITORIOS.has(codigo)) {
      return decision('ERROR_CONFIG', 'REVISAR_CONFIG', `El servicio de SUNAT respondió HTTP ${http[1]}: revise el endpoint configurado.`);
    }
    if (!http && !CODIGOS_TRANSPORTE_TRANSITORIOS.has(codigo)) {
      this.registro.warn(`Error de transporte no catalogado ${codigo}: ${respuesta.descripcion}`);
    }
    return decision('PENDIENTE_REENVIO', 'REINTENTAR', `No hubo respuesta válida de SUNAT (${codigo}). El resultado puede ser incierto; revise el estado antes de solicitar manualmente el reenvío del mismo ZIP.`);
  }

  private rechazo(descripcion: string, contexto: ContextoClasificacion): ClasificacionRespuesta {
    if (this.esLote(contexto)) {
      return decision('RECHAZADO', 'CORREGIR_Y_REENVIAR', `SUNAT rechazó el ${contexto.operacion === 'baja' ? 'pedido de baja' : 'resumen'} (${descripcion}). Los números no se invalidan: corrija y vuelva a enviarlo.`);
    }
    return decision('RECHAZADO', 'EMITIR_NUEVO', `SUNAT rechazó el comprobante (${descripcion}). El número quedó usado: corrija y emita un comprobante nuevo.`);
  }

  private excepcion(descripcion: string): ClasificacionRespuesta {
    return decision('EXCEPCION', 'CORREGIR_Y_REENVIAR', `SUNAT no registró el comprobante (${descripcion}). Corrija el dato y reenvíe con el mismo número.`);
  }
}

const clasificadorPorOmision = new ClasificadorRespuestaSunat();

/** clasificarRespuesta(r, { operacion, tipo?, etapa?, ambiente?, serie? }) → { estado, accion, mensajeUsuario, bloqueaEmision? } */
export function clasificarRespuesta(respuesta: RespuestaSunat, contexto: ContextoClasificacion): ClasificacionRespuesta {
  return clasificadorPorOmision.clasificar(respuesta, contexto);
}

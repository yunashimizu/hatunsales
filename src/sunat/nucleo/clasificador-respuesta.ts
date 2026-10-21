import type {
  AccionSunat,
  ClasificacionRespuesta,
  ContextoClasificacion,
  EstadoSunat,
  ObservacionSunat,
  RespuestaSunat,
} from './documento-fiscal.types';

/**
 * Tabla de decisión ante cada respuesta de SUNAT (design §7.3). Los rangos son
 * oficiales (Manual del Programador §4.1): 0100–0999 excepción de SUNAT,
 * 1000–1999 excepción del contribuyente (no informado: se corrige y se
 * reenvía con el mismo número), 2000–3999 rechazo (en comprobantes el número
 * queda usado; en RC/RA no), 4000+ observación (aceptado).
 * Los conjuntos son editables: si SUNAT publica un código nuevo se agrega aquí.
 */

/** Usuario/clave SOL (0102–0106), encabezado de seguridad (0101), perfil o afiliación (0111–0113), RUC del archivo ≠ usuario (0154). */
export const CODIGOS_FAULT_CONFIGURACION = new Set(['0101', '0102', '0103', '0104', '0105', '0106', '0111', '0112', '0113', '0154']);

/** Fallas temporales del servicio de SUNAT: reintentar con backoff (en producción, consultando antes). */
export const CODIGOS_FAULT_TRANSITORIOS = new Set([
  '0100', '0109', '0110', '0125', '0130', '0131', '0132', '0133', '0134', '0135', '0136', '0137', '0138',
  '0200', '0201', '0202', '0203', '0204', '0250', '0251', '0252', '0253', '0303', '0304', '0307',
]);

/** El paquete enviado es incorrecto (nombre, ZIP o XML ilegible, referencia inexistente): corregir antes de reenviar. */
export const CODIGOS_FAULT_PAQUETE = new Set([
  '0150', '0151', '0152', '0153', '0155', '0156', '0157', '0158', '0159', '0160', '0161',
  '0300', '0301', '0302', '0305', '0306', '0403', '0404',
]);

/** El comprobante ya fue recibido antes: recuperar la constancia con getStatusCdr (no reenviar a ciegas). */
export const CODIGOS_RECUPERAR_CDR = new Set(['1033', '0402']);

/** El comprobante ya está informado y anulado o rechazado: no se puede reenviar con ese número. */
export const CODIGOS_YA_INFORMADO_INVALIDO = new Set(['1032']);

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
        return decision('PENDIENTE_REENVIO', 'REINTENTAR', 'La consulta a SUNAT no está disponible en este ambiente. Revise el estado antes de solicitar manualmente el reenvío del mismo XML.');
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
    if (valor !== null && valor >= 2000) return this.rechazo(descripcion, contexto);
    if (valor !== null && valor >= 100) return this.excepcion(descripcion);
    this.registro.warn(`CDR con ResponseCode desconocido "${codigo}"`);
    return decision('PENDIENTE_REENVIO', 'REINTENTAR', `SUNAT devolvió una constancia con un código no reconocido (${codigo}); se consultará de nuevo.`);
  }

  private porEstado(respuesta: RespuestaSunat, codigo: string, contexto: ContextoClasificacion): ClasificacionRespuesta {
    const descripcion = `${codigo} - ${respuesta.descripcion}`;
    if (this.esLote(contexto)) {
      if (respuesta.estadoComprobante === 'RECHAZADO' || codigo === '99') {
        return decision('RECHAZADO', 'CORREGIR_Y_REENVIAR', `SUNAT procesó el lote con errores (${descripcion}). Los números no se invalidan: corrija y envíe un nuevo resumen.`);
      }
      return decision('TICKET_PENDIENTE', 'CONSULTAR_TICKET', `Estado del ticket: ${descripcion}. Se consultará nuevamente.`);
    }
    switch (respuesta.estadoComprobante) {
      case 'ACEPTADO':
        return decision('ACEPTADO', 'NINGUNA', `SUNAT confirma que el comprobante está aceptado (${descripcion}).`);
      case 'RECHAZADO':
        return decision('RECHAZADO', 'EMITIR_NUEVO', `SUNAT tiene el comprobante como rechazado (${descripcion}): emita un comprobante nuevo.`);
      case 'DE_BAJA':
        return decision('ANULADO', 'NINGUNA', `SUNAT tiene el comprobante dado de baja (${descripcion}).`);
      case 'NO_EXISTE':
        return decision('PENDIENTE_REENVIO', 'REINTENTAR', 'SUNAT no tiene registrado el comprobante: se reenviará el mismo XML.');
      default:
        break;
    }
    if (codigo === '0008' || codigo === '0012') {
      return decision('ERROR_CONFIG', 'REVISAR_CONFIG', `SUNAT no permite consultar ese comprobante con este usuario (${descripcion}). Revise el RUC y el usuario SOL.`);
    }
    this.registro.warn(`Consulta de SUNAT con estado no reconocido "${codigo}": ${respuesta.descripcion}`);
    return decision('PENDIENTE_REENVIO', 'REINTENTAR', `SUNAT respondió la consulta con el estado ${descripcion}; se reintentará.`);
  }

  private porFault(respuesta: RespuestaSunat, codigo: string, contexto: ContextoClasificacion): ClasificacionRespuesta {
    const descripcion = `${codigo} - ${respuesta.descripcion}`;
    if (CODIGOS_FAULT_CONFIGURACION.has(codigo)) {
      return decision('ERROR_CONFIG', 'REVISAR_CONFIG', `SUNAT rechazó las credenciales o el perfil del usuario SOL (${descripcion}). Revise Panel → Facturación SUNAT; no se reintentará automáticamente.`);
    }
    if (CODIGOS_RECUPERAR_CDR.has(codigo)) {
      return decision(
        'PENDIENTE_REENVIO',
        'RECUPERAR_CDR',
        `SUNAT indica que ya recibió este comprobante (${descripcion}). No reenvíe el ZIP: el servicio de consulta de CDR no está disponible en BETA; verifique el envío con SUNAT antes de continuar.`,
      );
    }
    if (CODIGOS_YA_INFORMADO_INVALIDO.has(codigo)) {
      return decision('RECHAZADO', 'EMITIR_NUEVO', `SUNAT ya tiene este comprobante como anulado o rechazado (${descripcion}): emita uno nuevo.`);
    }
    if (CODIGOS_TICKET_INVALIDO.has(codigo) && this.esLote(contexto)) {
      return decision('EXCEPCION', 'CORREGIR_Y_REENVIAR', `El ticket no es válido (${descripcion}): vuelva a enviar el resumen.`);
    }
    if (CODIGOS_FAULT_PAQUETE.has(codigo)) return this.excepcion(descripcion);
    if (CODIGOS_FAULT_TRANSITORIOS.has(codigo)) {
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

/** clasificarRespuesta(r, { operacion, tipo?, etapa? }) → { estado, accion, mensajeUsuario } */
export function clasificarRespuesta(respuesta: RespuestaSunat, contexto: ContextoClasificacion): ClasificacionRespuesta {
  return clasificadorPorOmision.clasificar(respuesta, contexto);
}

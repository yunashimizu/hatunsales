import { hijos, intentarParsearXml, primerDescendiente, ruta, texto } from '../xml/lector-xml';

export interface FaultSoap {
  /** Código de SUNAT normalizado a 4 dígitos ('0111', '1033', '2335'); '' si no trae número. */
  codigo: string;
  /** faultcode tal como llegó ('soap-env:Client.0111'). */
  codigoOriginal: string;
  mensaje: string;
  detalle?: string;
}

export interface EstadoSoap {
  /** CDR en ZIP base64 (getStatus de un ticket o getStatusCdr). */
  content: string | null;
  statusCode: string | null;
  statusMessage: string | null;
}

export interface RespuestaSoapLeida {
  esXml: boolean;
  fault: FaultSoap | null;
  /** sendBill: CDR en ZIP base64. */
  applicationResponse: string | null;
  /** sendSummary. */
  ticket: string | null;
  /** getStatus / getStatusCdr. */
  estado: EstadoSoap | null;
}

function codigoAlFinal(valor: string): string | null {
  return /(\d{3,4})\s*$/.exec(valor)?.[1] ?? null;
}

function codigoAlInicio(valor: string): string | null {
  return /^\s*(\d{3,4})(?:\b|\s|$)/.exec(valor)?.[1] ?? null;
}

/**
 * Extrae los 4 dígitos del Fault en cualquiera de sus formas:
 * 'soap-env:Client.0111', 'ns0:0111', '0111', o un faultstring/detalle que empiece con el código.
 */
export function normalizarCodigoFault(faultcode: string, faultstring = '', detalle = ''): string {
  const codigo = codigoAlFinal(String(faultcode ?? '')) ?? codigoAlInicio(String(faultstring ?? '')) ?? codigoAlInicio(String(detalle ?? ''));
  return codigo ? codigo.padStart(4, '0') : '';
}

function limpiar(valor: string): string {
  return valor.replace(/\s+/g, ' ').trim();
}

/** Lee la respuesta SOAP de SUNAT sin depender de prefijos (soap-env, S, ns2…). */
export function leerRespuestaSoap(cuerpo: string): RespuestaSoapLeida {
  const documento = intentarParsearXml(cuerpo);
  if (!documento) return { esXml: false, fault: null, applicationResponse: null, ticket: null, estado: null };

  const nodoFault = primerDescendiente(documento, 'Fault');
  let fault: FaultSoap | null = null;
  if (nodoFault) {
    // SOAP 1.1 (faultcode/faultstring) y, por si acaso, SOAP 1.2 (Code/Value, Reason/Text).
    const codigoOriginal = texto(hijos(nodoFault, 'faultcode')[0]) || texto(ruta(nodoFault, 'Code', 'Value'));
    const mensaje = limpiar(texto(hijos(nodoFault, 'faultstring')[0]) || texto(ruta(nodoFault, 'Reason', 'Text')));
    const detalle = limpiar(texto(hijos(nodoFault, 'detail')[0]) || texto(hijos(nodoFault, 'Detail')[0]));
    fault = {
      codigo: normalizarCodigoFault(codigoOriginal, mensaje, detalle),
      codigoOriginal,
      mensaje: mensaje || detalle || 'SUNAT devolvió un SOAP Fault sin detalle.',
      detalle: detalle || undefined,
    };
  }

  const nodoStatusCode = primerDescendiente(documento, 'statusCode');
  const padreStatus = nodoStatusCode?.parentNode as Element | null | undefined;
  const estado: EstadoSoap | null = nodoStatusCode
    ? {
        content: (padreStatus ? texto(hijos(padreStatus, 'content')[0]) : '') || null,
        statusCode: texto(nodoStatusCode) || null,
        statusMessage: (padreStatus ? limpiar(texto(hijos(padreStatus, 'statusMessage')[0])) : '') || null,
      }
    : null;

  return {
    esXml: true,
    fault,
    applicationResponse: texto(primerDescendiente(documento, 'applicationResponse')) || null,
    ticket: texto(primerDescendiente(documento, 'ticket')) || null,
    estado,
  };
}

import { leerRespuestaSoap, normalizarCodigoFault, RespuestaSoapLeida } from '../nucleo/soap/lector-respuesta-soap';
import { leerXmlDeZip } from '../nucleo/zip/paquete-zip';

export interface SoapFaultInfo {
  /** faultcode tal como llegó ('soap-env:Client.0111'). */
  faultCode: string;
  faultString: string;
  /** Código de SUNAT normalizado a 4 dígitos ('0111'); '' si el Fault no trae número. */
  codigoNumerico: string;
}

function textoPorRegex(xml: string, elemento: string): string | null {
  const patron = new RegExp(`<(?:[\\w-]+:)?${elemento}[^>]*>([^<]+)</(?:[\\w-]+:)?${elemento}>`, 'i');
  return patron.exec(xml)?.[1]?.trim() || null;
}

/**
 * La respuesta SOAP de sendBill/getStatus no trae el CDR suelto: lo trae en
 * <applicationResponse> (o <content> en getStatus) como un ZIP en base64 que
 * contiene el ApplicationResponse firmado. Este helper lo decodifica y
 * descomprime. Lee el DOM sin depender de prefijos y, si la respuesta no es
 * XML bien formado, cae a la lectura por expresiones regulares heredada.
 */
export class CdrExtractorUtil {
  /** XML del ApplicationResponse (CDR), o null si no viene o no se puede leer (p. ej. un SOAP Fault). */
  extraerCdrXml(respuestaSoapCruda: string): string | null {
    const base64 = this.extraerContenidoBase64(respuestaSoapCruda);
    return base64 ? (leerXmlDeZip(base64)?.xml ?? null) : null;
  }

  private leer(xml: string): RespuestaSoapLeida | null {
    const leida = leerRespuestaSoap(String(xml ?? ''));
    return leida.esXml ? leida : null;
  }

  private extraerContenidoBase64(xml: string): string | null {
    const leida = this.leer(xml);
    if (leida) return leida.applicationResponse ?? leida.estado?.content ?? null;
    return textoPorRegex(String(xml ?? ''), 'applicationResponse') ?? textoPorRegex(String(xml ?? ''), 'content');
  }

  /** Ticket de sendSummary (resúmenes y comunicaciones de baja). */
  extraerTicket(xml: string): string | null {
    return this.leer(xml)?.ticket ?? textoPorRegex(String(xml ?? ''), 'ticket');
  }

  /** statusCode de getStatus (98 en proceso, 0 procesado, 99 con errores). */
  extraerStatusCode(xml: string): string | null {
    return this.leer(xml)?.estado?.statusCode ?? textoPorRegex(String(xml ?? ''), 'statusCode');
  }

  /** SOAP Fault (credenciales inválidas, XML mal formado, rechazo…), con el código normalizado. */
  extraerFault(xml: string): SoapFaultInfo | null {
    const leida = this.leer(xml);
    if (leida) {
      if (!leida.fault) return null;
      return {
        faultCode: leida.fault.codigoOriginal || 'DESCONOCIDO',
        faultString: leida.fault.mensaje,
        codigoNumerico: leida.fault.codigo,
      };
    }
    const texto = String(xml ?? '');
    if (!/<(?:[\w-]+:)?Fault[>\s]/i.test(texto)) return null;
    const faultCode = textoPorRegex(texto, 'faultcode') ?? 'DESCONOCIDO';
    const faultString = textoPorRegex(texto, 'faultstring') ?? 'SUNAT devolvió un SOAP Fault sin detalle.';
    return { faultCode, faultString, codigoNumerico: normalizarCodigoFault(faultCode, faultString) };
  }
}

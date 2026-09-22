import AdmZip from 'adm-zip';

export interface SoapFaultInfo {
  faultCode: string;
  faultString: string;
}

/**
 * La respuesta SOAP real de sendBill/sendSummary/getStatus de SUNAT no trae
 * el CDR como XML suelto en el cuerpo: lo trae dentro de un elemento
 * <applicationResponse> (o <content> en getStatus) cuyo contenido es un ZIP
 * codificado en base64, que a su vez contiene el XML ApplicationResponse
 * firmado. Este helper hace ese trabajo: decodifica el base64, descomprime
 * el ZIP y devuelve el XML real listo para CdrParserService.parse().
 */
export class CdrExtractorUtil {
  /**
   * Busca <applicationResponse>...</applicationResponse> o
   * <content>...</content> (getStatus) en el XML crudo de la respuesta SOAP,
   * lo decodifica de base64 y descomprime el ZIP para obtener el XML del
   * ApplicationResponse (CDR) real. Devuelve null si no encuentra ese
   * elemento (por ejemplo si la respuesta es un SOAP Fault).
   */
  extraerCdrXml(respuestaSoapCruda: string): string | null {
    const base64 = this.extraerContenidoBase64(respuestaSoapCruda);
    if (!base64) return null;

    try {
      const zipBuffer = Buffer.from(base64, 'base64');
      const zip = new AdmZip(zipBuffer);
      const entradaXml = zip.getEntries().find((entrada) => entrada.entryName.toLowerCase().endsWith('.xml'));
      if (!entradaXml) return null;
      return zip.readAsText(entradaXml, 'utf8');
    } catch {
      return null;
    }
  }

  private extraerContenidoBase64(xml: string): string | null {
    const applicationResponse = xml.match(/<(?:[\w-]+:)?applicationResponse[^>]*>([^<]+)<\/(?:[\w-]+:)?applicationResponse>/i);
    if (applicationResponse?.[1]) return applicationResponse[1].trim();

    const content = xml.match(/<(?:[\w-]+:)?content[^>]*>([^<]+)<\/(?:[\w-]+:)?content>/i);
    if (content?.[1]) return content[1].trim();

    return null;
  }

  /** Extrae el ticket que devuelve sendSummary (envio asincrono de resumenes/comunicaciones de baja). */
  extraerTicket(xml: string): string | null {
    const match = xml.match(/<(?:[\w-]+:)?ticket[^>]*>([^<]+)<\/(?:[\w-]+:)?ticket>/i);
    return match?.[1]?.trim() ?? null;
  }

  /** Extrae el estado de un getStatus todavia en proceso (SUNAT devuelve statusCode sin CDR mientras procesa). */
  extraerStatusCode(xml: string): string | null {
    const match = xml.match(/<(?:[\w-]+:)?statusCode[^>]*>([^<]+)<\/(?:[\w-]+:)?statusCode>/i);
    return match?.[1]?.trim() ?? null;
  }

  /** Detecta y extrae un SOAP Fault (credenciales invalidas, XML mal formado, etc.). */
  extraerFault(xml: string): SoapFaultInfo | null {
    if (!/<(?:[\w-]+:)?Fault[>\s]/i.test(xml)) return null;

    const faultCode = xml.match(/<(?:[\w-]+:)?faultcode>([^<]+)<\/(?:[\w-]+:)?faultcode>/i)?.[1]?.trim() ?? 'DESCONOCIDO';
    const faultString = xml.match(/<(?:[\w-]+:)?faultstring>([^<]+)<\/(?:[\w-]+:)?faultstring>/i)?.[1]?.trim()
      ?? 'SUNAT devolvió un SOAP Fault sin detalle.';

    return { faultCode, faultString };
  }
}

import axios from 'axios';
import { CdrExtractorUtil, SoapFaultInfo } from '../cdr/cdr-extractor.util';

export interface SunatBillClientConfig {
  username: string;
  password: string;
  endpoint: string;
  timeoutMs?: number;
}

export interface SunatSoapResultado {
  ok: boolean;
  status: 'ACEPTADO' | 'PENDIENTE' | 'ERROR_TRANSPORTE' | 'RECHAZADO';
  /** Cuerpo crudo de la respuesta SOAP, tal como llegó (incluye el envelope completo). */
  raw: string;
  /** XML del CDR/ApplicationResponse ya descomprimido y decodificado, listo para CdrParserService.parse(). null si no venía o no se pudo extraer. */
  cdrXml: string | null;
  /** Detalle del SOAP Fault (credenciales inválidas, XML mal formado, etc.) cuando SUNAT devuelve uno en vez de un CDR. */
  fault: SoapFaultInfo | null;
  message: string;
}

export interface SunatSendSummaryResultado {
  ok: boolean;
  raw: string;
  ticket: string | null;
  fault: SoapFaultInfo | null;
  message: string;
}

export interface SunatGetStatusResultado {
  ok: boolean;
  /** true si SUNAT ya terminó de procesar el ticket (hay CDR o fue rechazado); false si sigue "En proceso". */
  finalizado: boolean;
  raw: string;
  cdrXml: string | null;
  statusCode: string | null;
  fault: SoapFaultInfo | null;
  message: string;
}

/**
 * Cliente SOAP para los servicios web de SUNAT (billService): envío directo
 * de Factura/Boleta/Nota de Crédito/Guía de Remisión, sin OSE ni facturador
 * de pago. Mismo endpoint y credenciales (usuario/clave SOL vía WS-Security
 * UsernameToken) en BETA y en PRODUCCIÓN — solo cambia la URL del endpoint.
 */
export class SunatBillClient {
  private readonly cdrExtractor = new CdrExtractorUtil();

  constructor(private readonly config: SunatBillClientConfig) {}

  private buildEnvelope(metodo: string, argumentosXml: string): string {
    return `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ser="http://service.sunat.gob.pe">
  <soapenv:Header>
    <wsse:Security xmlns:wsse="http://docs.oasis-open.org/wss/2004/01/oasis-2004-01-wss-wssecurity-secext-1.0.xsd">
      <wsse:UsernameToken>
        <wsse:Username>${this.config.username}</wsse:Username>
        <wsse:Password>${this.config.password}</wsse:Password>
      </wsse:UsernameToken>
    </wsse:Security>
  </soapenv:Header>
  <soapenv:Body>
    <ser:${metodo}>
      ${argumentosXml}
    </ser:${metodo}>
  </soapenv:Body>
</soapenv:Envelope>`;
  }

  buildSendBillEnvelope(fileName: string, contentFileBase64: string): string {
    return this.buildEnvelope('sendBill', `<fileName>${fileName}</fileName>
      <contentFile>${contentFileBase64}</contentFile>`);
  }

  buildSendSummaryEnvelope(fileName: string, contentFileBase64: string): string {
    return this.buildEnvelope('sendSummary', `<fileName>${fileName}</fileName>
      <contentFile>${contentFileBase64}</contentFile>`);
  }

  buildGetStatusEnvelope(ticket: string): string {
    return this.buildEnvelope('getStatus', `<ticket>${ticket}</ticket>`);
  }

  private async postSoap(envelope: string, soapAction: string): Promise<{ ok: boolean; httpStatus: number; raw: string; message: string }> {
    if (!this.config.username || !this.config.password || !this.config.endpoint) {
      return {
        ok: false,
        httpStatus: 0,
        raw: envelope,
        message: 'Credenciales o endpoint SUNAT no configurados para envío real.',
      };
    }

    try {
      const response = await axios.post(this.config.endpoint, envelope, {
        headers: {
          'Content-Type': 'text/xml; charset=utf-8',
          SOAPAction: `"http://service.sunat.gob.pe/ser:${soapAction}"`,
        },
        timeout: this.config.timeoutMs ?? 30000,
        validateStatus: () => true,
      });

      const raw = String(response.data ?? '');
      const enRango2xx = response.status >= 200 && response.status < 300;

      return {
        ok: enRango2xx,
        httpStatus: response.status,
        raw: this.redactarCredenciales(raw),
        message: enRango2xx ? 'SOAP enviado a SUNAT.' : `Error HTTP ${response.status}: ${response.statusText}`,
      };
    } catch (error: any) {
      return {
        ok: false,
        httpStatus: 0,
        raw: this.redactarCredenciales(envelope),
        message: error?.message ?? 'Error de transporte al comunicarse con SUNAT.',
      };
    }
  }

  /**
   * Nunca se debe guardar el usuario/clave SOL en logs ni en la base de
   * datos: cuando falta configuración o la petición falla antes de llegar a
   * SUNAT, `raw` es el envelope SALIENTE (que sí trae las credenciales en
   * <wsse:UsernameToken>). Se reemplazan por "***" antes de devolverlo, sea
   * cual sea el llamador (aunque solo lo persista él mismo).
   */
  private redactarCredenciales(texto: string): string {
    if (!this.config.username && !this.config.password) return texto;
    let resultado = texto;
    if (this.config.username) resultado = resultado.split(this.config.username).join('***');
    if (this.config.password) resultado = resultado.split(this.config.password).join('***');
    return resultado;
  }

  /** Envío síncrono de UN comprobante (Factura, Boleta, Nota de Crédito o Guía). SUNAT responde de inmediato con el CDR. */
  async sendBill(fileName: string, contentFileBase64: string): Promise<SunatSoapResultado> {
    const envelope = this.buildSendBillEnvelope(fileName, contentFileBase64);
    const respuesta = await this.postSoap(envelope, 'sendBill');

    const fault = this.cdrExtractor.extraerFault(respuesta.raw);
    if (fault) {
      return {
        ok: false,
        status: 'ERROR_TRANSPORTE',
        raw: respuesta.raw,
        cdrXml: null,
        fault,
        message: `SUNAT rechazó la solicitud (${fault.faultCode}): ${fault.faultString}`,
      };
    }

    const cdrXml = respuesta.ok ? this.cdrExtractor.extraerCdrXml(respuesta.raw) : null;

    return {
      ok: respuesta.ok && !!cdrXml,
      status: cdrXml ? 'ACEPTADO' : respuesta.ok ? 'PENDIENTE' : 'ERROR_TRANSPORTE',
      raw: respuesta.raw,
      cdrXml,
      fault: null,
      message: cdrXml ? 'CDR recibido de SUNAT.' : respuesta.message,
    };
  }

  /** Envío asíncrono (Resumen Diario de Boletas, Comunicación de Baja): SUNAT devuelve un ticket, el CDR se consulta despues con getStatus. */
  async sendSummary(fileName: string, contentFileBase64: string): Promise<SunatSendSummaryResultado> {
    const envelope = this.buildSendSummaryEnvelope(fileName, contentFileBase64);
    const respuesta = await this.postSoap(envelope, 'sendSummary');

    const fault = this.cdrExtractor.extraerFault(respuesta.raw);
    if (fault) {
      return {
        ok: false,
        raw: respuesta.raw,
        ticket: null,
        fault,
        message: `SUNAT rechazó el resumen (${fault.faultCode}): ${fault.faultString}`,
      };
    }

    const ticket = respuesta.ok ? this.cdrExtractor.extraerTicket(respuesta.raw) : null;

    return {
      ok: respuesta.ok && !!ticket,
      raw: respuesta.raw,
      ticket,
      fault: null,
      message: ticket ? `Resumen aceptado para procesamiento. Ticket: ${ticket}` : respuesta.message,
    };
  }

  /** Consulta el resultado de un ticket de sendSummary/sendPack. Puede seguir "En proceso" (finalizado=false). */
  async getStatus(ticket: string): Promise<SunatGetStatusResultado> {
    const envelope = this.buildGetStatusEnvelope(ticket);
    const respuesta = await this.postSoap(envelope, 'getStatus');

    const fault = this.cdrExtractor.extraerFault(respuesta.raw);
    if (fault) {
      return {
        ok: false,
        finalizado: false,
        raw: respuesta.raw,
        cdrXml: null,
        statusCode: null,
        fault,
        message: `SUNAT rechazó la consulta (${fault.faultCode}): ${fault.faultString}`,
      };
    }

    const cdrXml = respuesta.ok ? this.cdrExtractor.extraerCdrXml(respuesta.raw) : null;
    const statusCode = respuesta.ok ? this.cdrExtractor.extraerStatusCode(respuesta.raw) : null;

    return {
      ok: respuesta.ok,
      finalizado: !!cdrXml,
      raw: respuesta.raw,
      cdrXml,
      statusCode,
      fault: null,
      message: cdrXml ? 'CDR disponible.' : statusCode ? `SUNAT sigue procesando (statusCode ${statusCode}).` : respuesta.message,
    };
  }
}

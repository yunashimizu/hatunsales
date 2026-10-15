import { CdrExtractorUtil, SoapFaultInfo } from '../cdr/cdr-extractor.util';
import { construirSobreSoap, MetodoSoapSunat, soapActionDe } from '../nucleo/soap/sobre-soap';
import { ErrorTransporteSoap, TransporteSoap, TransporteSoapAxios } from '../nucleo/soap/transporte-soap';
import { escaparXml } from '../nucleo/xml/escritor-xml';

// Cliente nuevo del núcleo (contrato §12.1): úselo en todo código nuevo.
export {
  FabricaClienteSoapSunat,
  SunatSoapClient,
  TIMEOUT_POS_MS,
  TIMEOUT_WORKER_MS,
  ESTADOS_CONSULTA_SUNAT,
} from '../nucleo/soap/sunat-soap-client';
export type { ConfiguracionClienteSoap, DependenciasClienteSoap } from '../nucleo/soap/sunat-soap-client';

export interface SunatBillClientConfig {
  username: string;
  password: string;
  endpoint: string;
  timeoutMs?: number;
}

export interface SunatSoapResultado {
  ok: boolean;
  status: 'ACEPTADO' | 'PENDIENTE' | 'ERROR_TRANSPORTE' | 'RECHAZADO';
  /** Cuerpo de la respuesta SOAP con las credenciales redactadas. */
  raw: string;
  /** XML del CDR/ApplicationResponse ya descomprimido y decodificado, listo para CdrParserService.parse(). null si no venía o no se pudo extraer. */
  cdrXml: string | null;
  /** Detalle del SOAP Fault (credenciales inválidas, XML mal formado, etc.) cuando SUNAT devuelve uno en vez de un CDR. */
  fault: SoapFaultInfo | null;
  message: string;
  /** Estado HTTP de la respuesta (0 si no hubo respuesta). */
  httpStatus?: number;
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
 * @deprecated Cliente heredado (lo usan la GRE SOAP y los proveedores BETA).
 * El código nuevo usa SunatSoapClient, que normaliza y clasifica las
 * respuestas. Se mantienen sus métodos y tipos de retorno; se corrigieron el
 * SOAPAction (urn:método, como declaran los WSDL), el espacio de nombres de
 * WS-Security y el escape XML de usuario y clave.
 */
export class SunatBillClient {
  private readonly cdrExtractor = new CdrExtractorUtil();

  constructor(
    private readonly config: SunatBillClientConfig,
    private readonly transporte: TransporteSoap = new TransporteSoapAxios(),
  ) {}

  private buildEnvelope(metodo: MetodoSoapSunat, argumentos: ReadonlyArray<readonly [string, string]>): string {
    return construirSobreSoap(metodo, { usuario: this.config.username ?? '', clave: this.config.password ?? '' }, argumentos);
  }

  buildSendBillEnvelope(fileName: string, contentFileBase64: string): string {
    return this.buildEnvelope('sendBill', [['fileName', fileName], ['contentFile', contentFileBase64]]);
  }

  buildSendSummaryEnvelope(fileName: string, contentFileBase64: string): string {
    return this.buildEnvelope('sendSummary', [['fileName', fileName], ['contentFile', contentFileBase64]]);
  }

  buildGetStatusEnvelope(ticket: string): string {
    return this.buildEnvelope('getStatus', [['ticket', ticket]]);
  }

  /** `cuerpo` (sin redactar) solo se usa para extraer el CDR; `raw` es lo único que se devuelve al llamador. */
  private async postSoap(
    envelope: string,
    metodo: MetodoSoapSunat,
  ): Promise<{ ok: boolean; httpStatus: number; cuerpo: string; raw: string; message: string }> {
    if (!this.config.username || !this.config.password || !this.config.endpoint) {
      return {
        ok: false,
        httpStatus: 0,
        cuerpo: '',
        raw: this.redactarCredenciales(envelope),
        message: 'Credenciales o endpoint SUNAT no configurados para envío real.',
      };
    }

    try {
      const respuesta = await this.transporte.enviar({
        url: this.config.endpoint,
        cuerpo: envelope,
        soapAction: soapActionDe(metodo),
        timeoutMs: this.config.timeoutMs ?? 30000,
      });
      const enRango2xx = respuesta.estadoHttp >= 200 && respuesta.estadoHttp < 300;
      return {
        ok: enRango2xx,
        httpStatus: respuesta.estadoHttp,
        cuerpo: respuesta.cuerpo,
        raw: this.redactarCredenciales(respuesta.cuerpo),
        message: enRango2xx ? 'SOAP enviado a SUNAT.' : `Error HTTP ${respuesta.estadoHttp}`,
      };
    } catch (error: unknown) {
      const mensaje = error instanceof ErrorTransporteSoap || error instanceof Error ? error.message : 'Error de transporte al comunicarse con SUNAT.';
      return {
        ok: false,
        httpStatus: 0,
        cuerpo: '',
        raw: this.redactarCredenciales(envelope),
        message: this.redactarCredenciales(mensaje),
      };
    }
  }

  /**
   * Nunca se guarda el usuario ni la clave SOL en logs o en la base: si la
   * petición falla antes de llegar a SUNAT, `raw` es el envelope SALIENTE
   * (que trae el UsernameToken). Se reemplazan por "***" (también escapados).
   */
  private redactarCredenciales(texto: string): string {
    let resultado = String(texto ?? '');
    for (const secreto of [this.config.password, this.config.username]) {
      if (!secreto) continue;
      for (const forma of new Set([secreto, escaparXml(secreto)])) resultado = resultado.split(forma).join('***');
    }
    return resultado;
  }

  private faultRedactado(cuerpo: string): SoapFaultInfo | null {
    const fault = this.cdrExtractor.extraerFault(cuerpo);
    return fault ? { ...fault, faultString: this.redactarCredenciales(fault.faultString) } : null;
  }

  /** Envío síncrono de UN comprobante (Factura, Boleta, Nota de Crédito o Guía). SUNAT responde de inmediato con el CDR. */
  async sendBill(fileName: string, contentFileBase64: string): Promise<SunatSoapResultado> {
    const envelope = this.buildSendBillEnvelope(fileName, contentFileBase64);
    const respuesta = await this.postSoap(envelope, 'sendBill');

    const fault = this.faultRedactado(respuesta.cuerpo);
    if (fault) {
      return {
        ok: false,
        status: 'ERROR_TRANSPORTE',
        raw: respuesta.raw,
        cdrXml: null,
        fault,
        message: `SUNAT rechazó la solicitud (${fault.faultCode}): ${fault.faultString}`,
        httpStatus: respuesta.httpStatus,
      };
    }

    const cdrXml = respuesta.ok ? this.cdrExtractor.extraerCdrXml(respuesta.cuerpo) : null;

    return {
      ok: respuesta.ok && !!cdrXml,
      status: cdrXml ? 'ACEPTADO' : respuesta.ok ? 'PENDIENTE' : 'ERROR_TRANSPORTE',
      raw: respuesta.raw,
      cdrXml,
      fault: null,
      message: cdrXml ? 'CDR recibido de SUNAT.' : respuesta.message,
      httpStatus: respuesta.httpStatus,
    };
  }

  /** Envío asíncrono (Resumen Diario de Boletas, Comunicación de Baja): SUNAT devuelve un ticket, el CDR se consulta después con getStatus. */
  async sendSummary(fileName: string, contentFileBase64: string): Promise<SunatSendSummaryResultado> {
    const envelope = this.buildSendSummaryEnvelope(fileName, contentFileBase64);
    const respuesta = await this.postSoap(envelope, 'sendSummary');

    const fault = this.faultRedactado(respuesta.cuerpo);
    if (fault) {
      return {
        ok: false,
        raw: respuesta.raw,
        ticket: null,
        fault,
        message: `SUNAT rechazó el resumen (${fault.faultCode}): ${fault.faultString}`,
      };
    }

    const ticket = respuesta.ok ? this.cdrExtractor.extraerTicket(respuesta.cuerpo) : null;

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

    const fault = this.faultRedactado(respuesta.cuerpo);
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

    const cdrXml = respuesta.ok ? this.cdrExtractor.extraerCdrXml(respuesta.cuerpo) : null;
    const statusCode = respuesta.ok ? this.cdrExtractor.extraerStatusCode(respuesta.cuerpo) : null;

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

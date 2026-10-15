import { escaparXml } from '../xml/escritor-xml';

export const ESPACIO_SOAP_11 = 'http://schemas.xmlsoap.org/soap/envelope/';
export const ESPACIO_SERVICIO_SUNAT = 'http://service.sunat.gob.pe';
/** WS-Security 1.0 (OASIS 200401). */
export const ESPACIO_WSSE = 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd';

export type MetodoSoapSunat = 'sendBill' | 'sendSummary' | 'getStatus' | 'getStatusCdr';

export interface CredencialesSoap {
  /** RUC + usuario secundario SOL (en BETA: RUC + MODDATOS). */
  usuario: string;
  clave: string;
}

export type ArgumentosSoap = ReadonlyArray<readonly [string, string | number]>;

/** Valor del encabezado HTTP SOAPAction que declaran los WSDL vigentes: "urn:sendBill", "urn:getStatusCdr"… */
export function soapActionDe(metodo: MetodoSoapSunat): string {
  return `"urn:${metodo}"`;
}

/**
 * Sobre SOAP 1.1 con WS-Security UsernameToken. Usuario, clave y argumentos
 * se escapan: una clave con "&" o "<" no rompe el XML ni inyecta elementos.
 */
export function construirSobreSoap(metodo: MetodoSoapSunat, credenciales: CredencialesSoap, argumentos: ArgumentosSoap): string {
  const parametros = argumentos
    .map(([nombre, valor]) => `      <${nombre}>${escaparXml(String(valor))}</${nombre}>`)
    .join('\n');
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<soapenv:Envelope xmlns:soapenv="${ESPACIO_SOAP_11}" xmlns:ser="${ESPACIO_SERVICIO_SUNAT}" xmlns:wsse="${ESPACIO_WSSE}">`,
    '  <soapenv:Header>',
    '    <wsse:Security>',
    '      <wsse:UsernameToken>',
    `        <wsse:Username>${escaparXml(credenciales.usuario)}</wsse:Username>`,
    `        <wsse:Password>${escaparXml(credenciales.clave)}</wsse:Password>`,
    '      </wsse:UsernameToken>',
    '    </wsse:Security>',
    '  </soapenv:Header>',
    '  <soapenv:Body>',
    `    <ser:${metodo}>`,
    parametros,
    `    </ser:${metodo}>`,
    '  </soapenv:Body>',
    '</soapenv:Envelope>',
  ].join('\n');
}

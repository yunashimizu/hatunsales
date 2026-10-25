/**
 * Respuestas de la API REST de la GRE SOLO para specs: cuerpos JSON del token, del envío y de la consulta
 * del ticket, y una constancia (CDR) de guía. Estructura según el manual de SUNAT y Greenter; nunca vienen de SUNAT.
 */
import { zipBase64 } from '../../nucleo/pruebas/respuestas-sunat-prueba-spec';

export const TICKET_PRUEBA = '1a2b3c4d-5e6f-4a1b-9c2d-3e4f5a6b7c8d';
export const ENLACE_QR_PRUEBA = 'https://e-factura.sunat.gob.pe/v1/contribuyente/gre/comprobantes/descargaqr?hashqr=QUJDMTIz';

export interface OpcionesCdrGre {
  codigo?: string;
  descripcion?: string;
  notas?: string[];
  referencia?: string;
  rucEmisor?: string;
  conQr?: boolean;
}

export function cdrGrePrueba(opciones: OpcionesCdrGre = {}): string {
  const referencia = opciones.referencia ?? 'T001-00000001';
  const notas = (opciones.notas ?? []).map((n) => `  <cbc:Note>${n}</cbc:Note>`).join('\n');
  const qr = opciones.conQr === false ? '' : `<cbc:DocumentDescription>${ENLACE_QR_PRUEBA.replace(/&/g, '&amp;')}</cbc:DocumentDescription>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<ar:ApplicationResponse xmlns:ar="urn:oasis:names:specification:ubl:schema:xsd:ApplicationResponse-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
  <cbc:UBLVersionID>2.1</cbc:UBLVersionID>
  <cbc:CustomizationID>1.0</cbc:CustomizationID>
  <cbc:ID>202600000123</cbc:ID>
  <cbc:IssueDate>2026-10-21</cbc:IssueDate>
  <cbc:IssueTime>10:16:02</cbc:IssueTime>
  <cbc:ResponseDate>2026-10-21</cbc:ResponseDate>
  <cbc:ResponseTime>10:16:02</cbc:ResponseTime>
${notas}
  <cac:SenderParty><cac:PartyIdentification><cbc:ID>20131312955</cbc:ID></cac:PartyIdentification></cac:SenderParty>
  <cac:ReceiverParty><cac:PartyIdentification><cbc:ID>${opciones.rucEmisor ?? '20610206337'}</cbc:ID></cac:PartyIdentification></cac:ReceiverParty>
  <cac:DocumentResponse>
    <cac:Response>
      <cbc:ReferenceID>${referencia}</cbc:ReferenceID>
      <cbc:ResponseCode>${opciones.codigo ?? '0'}</cbc:ResponseCode>
      <cbc:Description>${opciones.descripcion ?? `La Guia numero ${referencia}, ha sido aceptada`}</cbc:Description>
    </cac:Response>
    <cac:DocumentReference>
      <cbc:ID>${referencia}</cbc:ID>
      <cbc:DocumentTypeCode>09</cbc:DocumentTypeCode>
      ${qr}
    </cac:DocumentReference>
  </cac:DocumentResponse>
</ar:ApplicationResponse>`;
}

export function arcCdrPrueba(cdrXml: string = cdrGrePrueba(), nombre = 'R-20610206337-09-T001-00000001.xml'): string {
  return zipBase64(nombre, cdrXml);
}

export function cuerpoToken(segundos = 3600, token = 'eyJhbGciOiJSUzI1NiJ9.cGF5bG9hZA.ZmlybWE'): string {
  return JSON.stringify({ access_token: token, token_type: 'JWT', expires_in: segundos });
}

export function cuerpoTicket(ticket = TICKET_PRUEBA): string {
  return JSON.stringify({ numTicket: ticket, fecRecepcion: '2026-10-21T10:16:00.000-05:00' });
}

export function cuerpoConsulta(codRespuesta: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ codRespuesta, ...extra });
}

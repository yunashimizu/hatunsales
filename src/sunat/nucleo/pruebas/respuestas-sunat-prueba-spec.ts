/**
 * Respuestas de SUNAT de ejemplo SOLO para specs (estructura de los CDR y de
 * los sobres SOAP reales de billService y billConsultService).
 */
import AdmZip from 'adm-zip';

export interface OpcionesCdrPrueba {
  codigo: string;
  descripcion: string;
  notas?: string[];
  /** Agrega atributos a ResponseCode como en los CDR reales. */
  conAtributos?: boolean;
  referencia?: string;
}

export function cdrPrueba(opciones: OpcionesCdrPrueba): string {
  const atributos = opciones.conAtributos ? ' listAgencyName="PE:SUNAT"' : '';
  const notas = (opciones.notas ?? []).map((n) => `  <cbc:Note>${n}</cbc:Note>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<ar:ApplicationResponse xmlns:ar="urn:oasis:names:specification:ubl:schema:xsd:ApplicationResponse-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2" xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2">
  <ext:UBLExtensions><ext:UBLExtension><ext:ExtensionContent><Signature xmlns="http://www.w3.org/2000/09/xmldsig#"><SignedInfo><Reference URI=""><DigestValue>abc</DigestValue></Reference></SignedInfo></Signature></ext:ExtensionContent></ext:UBLExtension></ext:UBLExtensions>
  <cbc:UBLVersionID>2.0</cbc:UBLVersionID>
  <cbc:CustomizationID>1.0</cbc:CustomizationID>
  <cbc:ID>1760371800000</cbc:ID>
  <cbc:IssueDate>2026-10-13</cbc:IssueDate>
  <cbc:IssueTime>10:30:05</cbc:IssueTime>
  <cbc:ResponseDate>2026-10-13</cbc:ResponseDate>
  <cbc:ResponseTime>10:30:05</cbc:ResponseTime>
${notas}
  <cac:Signature><cbc:ID>SignSUNAT</cbc:ID></cac:Signature>
  <cac:SenderParty><cac:PartyIdentification><cbc:ID>20131312955</cbc:ID></cac:PartyIdentification></cac:SenderParty>
  <cac:ReceiverParty><cac:PartyIdentification><cbc:ID>20610206337</cbc:ID></cac:PartyIdentification></cac:ReceiverParty>
  <cac:DocumentResponse>
    <cac:Response>
      <cbc:ReferenceID>${opciones.referencia ?? 'FFF1-7'}</cbc:ReferenceID>
      <cbc:ResponseCode${atributos}>${opciones.codigo}</cbc:ResponseCode>
      <cbc:Description>${opciones.descripcion}</cbc:Description>
    </cac:Response>
    <cac:DocumentReference><cbc:ID>${opciones.referencia ?? 'FFF1-7'}</cbc:ID></cac:DocumentReference>
  </cac:DocumentResponse>
</ar:ApplicationResponse>`;
}

export function zipBase64(nombre: string, contenido: string): string {
  const zip = new AdmZip();
  zip.addFile(nombre, Buffer.from(contenido, 'utf8'));
  return zip.toBuffer().toString('base64');
}

function sobre(cuerpo: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<soap-env:Envelope xmlns:soap-env="http://schemas.xmlsoap.org/soap/envelope/">
  <soap-env:Header/>
  <soap-env:Body>
${cuerpo}
  </soap-env:Body>
</soap-env:Envelope>`;
}

export function respuestaSendBill(cdrXml: string): string {
  return sobre(`    <br:sendBillResponse xmlns:br="http://service.sunat.gob.pe">
      <applicationResponse>${zipBase64('R-20610206337-01-FFF1-00000007.xml', cdrXml)}</applicationResponse>
    </br:sendBillResponse>`);
}

export function respuestaFault(faultcode: string, faultstring: string, detalle?: string): string {
  return sobre(`    <soap-env:Fault>
      <faultcode>${faultcode}</faultcode>
      <faultstring>${faultstring}</faultstring>${detalle ? `\n      <detail><message>${detalle}</message></detail>` : ''}
    </soap-env:Fault>`);
}

export function respuestaSendSummary(ticket: string): string {
  return sobre(`    <br:sendSummaryResponse xmlns:br="http://service.sunat.gob.pe"><ticket>${ticket}</ticket></br:sendSummaryResponse>`);
}

export function respuestaGetStatus(statusCode: string, cdrXml?: string): string {
  const contenido = cdrXml ? `<content>${zipBase64('R-20610206337-RC-20261013-00001.xml', cdrXml)}</content>` : '';
  return sobre(`    <br:getStatusResponse xmlns:br="http://service.sunat.gob.pe"><status>${contenido}<statusCode>${statusCode}</statusCode></status></br:getStatusResponse>`);
}

export function respuestaGetStatusCdr(statusCode: string, statusMessage: string, cdrXml?: string): string {
  const contenido = cdrXml ? `<content>${zipBase64('R-20610206337-01-FFF1-00000007.xml', cdrXml)}</content>` : '';
  return sobre(`    <br:getStatusCdrResponse xmlns:br="http://service.sunat.gob.pe"><statusCdr>${contenido}<statusCode>${statusCode}</statusCode><statusMessage>${statusMessage}</statusMessage></statusCdr></br:getStatusCdrResponse>`);
}

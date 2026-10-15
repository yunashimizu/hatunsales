import type { AtributosXml } from '../xml/escritor-xml';

/** Espacios de nombres de UBL 2.0/2.1 y de las extensiones de SUNAT. */
export const ESPACIOS_UBL = {
  invoice: 'urn:oasis:names:specification:ubl:schema:xsd:Invoice-2',
  creditNote: 'urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2',
  debitNote: 'urn:oasis:names:specification:ubl:schema:xsd:DebitNote-2',
  summaryDocuments: 'urn:sunat:names:specification:ubl:peru:schema:xsd:SummaryDocuments-1',
  voidedDocuments: 'urn:sunat:names:specification:ubl:peru:schema:xsd:VoidedDocuments-1',
  cac: 'urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2',
  cbc: 'urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2',
  ext: 'urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2',
  sac: 'urn:sunat:names:specification:ubl:peru:schema:xsd:SunatAggregateComponents-1',
  ds: 'http://www.w3.org/2000/09/xmldsig#',
} as const;

/** cac:Signature/cbc:ID del documento. */
export const ID_FIRMA_UBL = 'IDSignSP';
/** Atributo Id del ds:Signature que coloca la firma XMLDSig. */
export const ID_SIGNATURE_XMLDSIG = 'SignatureSP';
/** cac:Signature/…/cbc:URI: apunta al ds:Signature. */
export const URI_FIRMA_UBL = `#${ID_SIGNATURE_XMLDSIG}`;

/** Elementos raíz que el núcleo sabe firmar y empaquetar. */
export const RAICES_DOCUMENTO_SUNAT = ['Invoice', 'CreditNote', 'DebitNote', 'SummaryDocuments', 'VoidedDocuments', 'DespatchAdvice'] as const;
export const PATRON_RAIZ_DOCUMENTO_SUNAT = new RegExp(`<(?:[\\w-]+:)?(${RAICES_DOCUMENTO_SUNAT.join('|')})[\\s>/]`);

export function atributosRaizUbl(espacioPrincipal: string, conSac = false): AtributosXml {
  return {
    xmlns: espacioPrincipal,
    'xmlns:cac': ESPACIOS_UBL.cac,
    'xmlns:cbc': ESPACIOS_UBL.cbc,
    'xmlns:ext': ESPACIOS_UBL.ext,
    'xmlns:ds': ESPACIOS_UBL.ds,
    'xmlns:sac': conSac ? ESPACIOS_UBL.sac : undefined,
  };
}

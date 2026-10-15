import { X509Certificate } from 'crypto';
import { SignedXml } from 'xml-crypto';
import type { MaterialFirma, ResultadoFirmaXml } from '../documento-fiscal.types';
import { FirmaXmlError, XmlInvalidoError } from '../errores-nucleo';
import { ESPACIOS_UBL, ID_SIGNATURE_XMLDSIG, RAICES_DOCUMENTO_SUNAT } from '../ubl/espacios-ubl';
import { descendientes, hijos, nombreLocal, parsearXml, primerDescendiente, texto } from '../xml/lector-xml';
import { prepararMaterialFirma } from './material-certificado';

/** Algoritmos de la firma XMLDSig que acepta SUNAT (C14N inclusivo, firma envuelta, RSA-SHA256). */
export const ALGORITMOS_FIRMA_SUNAT = Object.freeze({
  canonicalizacion: 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315',
  firma: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256',
  digest: 'http://www.w3.org/2001/04/xmlenc#sha256',
  envuelta: 'http://www.w3.org/2000/09/xmldsig#enveloped-signature',
});

export interface OpcionesFirmaXml {
  /** Instante de referencia para la vigencia del certificado (por omisión, ahora). */
  ahora?: Date;
  /** Verificar la firma localmente tras firmar (por omisión, sí). */
  verificar?: boolean;
}

interface ContenedorFirma {
  raiz: string;
  /** XPath del único ext:ExtensionContent vacío. */
  xpath: string;
  declaraPrefijoDs: boolean;
}

const RAICES_FIRMABLES = new Set<string>(RAICES_DOCUMENTO_SUNAT);

/**
 * Ubica el contenedor de la firma: el único ext:ExtensionContent vacío. Sirve
 * para cualquier raíz UBL de SUNAT (Invoice, CreditNote, DebitNote,
 * SummaryDocuments, VoidedDocuments y DespatchAdvice de la GRE).
 */
function ubicarContenedorFirma(xml: string): ContenedorFirma {
  const documento = parsearXml(xml, 'El XML a firmar');
  const raiz = documento.documentElement;
  const nombreRaiz = nombreLocal(raiz);
  if (!RAICES_FIRMABLES.has(nombreRaiz)) {
    throw new XmlInvalidoError(`El XML no es un documento SUNAT firmable (raíz ${nombreRaiz}; se esperaba ${RAICES_DOCUMENTO_SUNAT.join(', ')}).`);
  }
  const contenedores = descendientes(documento, 'ExtensionContent').filter((e) => e.namespaceURI === ESPACIOS_UBL.ext);
  if (contenedores.some((c) => hijos(c, 'Signature').length > 0)) {
    throw new FirmaXmlError('El XML ya está firmado: no se vuelve a firmar un comprobante (se reenvía el mismo XML).');
  }
  const vacios = contenedores.map((c, indice) => ({ c, indice })).filter(({ c }) => hijos(c).length === 0);
  if (vacios.length === 0) {
    throw new XmlInvalidoError('El XML no tiene un ext:UBLExtensions/ext:UBLExtension/ext:ExtensionContent vacío donde colocar la firma.');
  }
  if (vacios.length > 1) {
    throw new XmlInvalidoError('El XML tiene más de un ext:ExtensionContent vacío: debe existir uno solo para la firma.');
  }
  return {
    raiz: nombreRaiz,
    xpath: `(//*[local-name(.)='ExtensionContent'])[${vacios[0].indice + 1}]`,
    declaraPrefijoDs: raiz.getAttribute('xmlns:ds') === ESPACIOS_UBL.ds,
  };
}

function leerValoresFirma(firmaXml: string): { digestValue: string; signatureValue: string } {
  const documento = parsearXml(firmaXml, 'La firma generada');
  const limpiar = (valor: string) => valor.replace(/\s+/g, '');
  return {
    digestValue: limpiar(texto(primerDescendiente(documento, 'DigestValue'))),
    signatureValue: limpiar(texto(primerDescendiente(documento, 'SignatureValue'))),
  };
}

function firmasXmlDsig(documento: Document): Element[] {
  return descendientes(documento, 'Signature').filter((e) => e.namespaceURI === ESPACIOS_UBL.ds);
}

function certificadoDeKeyInfo(firma: Element): string | null {
  const base64 = texto(primerDescendiente(firma, 'X509Certificate')).replace(/\s+/g, '');
  if (!base64) return null;
  try {
    return new X509Certificate(Buffer.from(base64, 'base64')).toString();
  } catch {
    return null;
  }
}

/**
 * Verifica la integridad criptográfica de un XML firmado (digest y firma).
 * Sin `certificadoPem` usa el certificado de ds:KeyInfo: comprueba que el XML
 * no fue alterado, no que el certificado sea de confianza.
 */
export function verificarFirmaXml(xmlFirmado: string, certificadoPem?: string): boolean {
  try {
    const documento = parsearXml(xmlFirmado, 'El XML firmado');
    const firmas = firmasXmlDsig(documento);
    if (firmas.length !== 1) return false;
    const certificado = certificadoPem ?? certificadoDeKeyInfo(firmas[0]);
    if (!certificado) return false;
    const verificador = new SignedXml({ publicCert: certificado });
    verificador.loadSignature(firmas[0]);
    return verificador.checkSignature(xmlFirmado) === true;
  } catch {
    return false;
  }
}

/** ds:DigestValue (valor resumen en base64) de un XML ya firmado, o null. */
export function extraerDigestValue(xmlFirmado: string): string | null {
  try {
    const firma = firmasXmlDsig(parsearXml(xmlFirmado, 'El XML firmado'))[0];
    const valor = firma ? texto(primerDescendiente(firma, 'DigestValue')).replace(/\s+/g, '') : '';
    return valor || null;
  } catch {
    return null;
  }
}

/**
 * Firma XMLDSig envuelta de SUNAT: C14N inclusivo, enveloped-signature,
 * RSA-SHA256/SHA-256, ds:Signature Id="SignatureSP" dentro del único
 * ext:ExtensionContent y ds:KeyInfo solo con el certificado hoja. Verifica la
 * firma antes de devolverla: si no verifica, lanza y no se envía nada.
 */
export class FirmadorXmlSunat {
  firmar(xml: string, material: MaterialFirma, opciones: OpcionesFirmaXml = {}): ResultadoFirmaXml {
    const certificado = prepararMaterialFirma(material, opciones.ahora ?? new Date());
    const contenedor = ubicarContenedorFirma(xml);

    const firmante = new SignedXml({
      privateKey: certificado.privateKeyPem,
      publicCert: certificado.certificadoHojaPem,
      signatureAlgorithm: ALGORITMOS_FIRMA_SUNAT.firma,
      canonicalizationAlgorithm: ALGORITMOS_FIRMA_SUNAT.canonicalizacion,
    });
    firmante.addReference({
      xpath: '/*',
      isEmptyUri: true,
      transforms: [ALGORITMOS_FIRMA_SUNAT.envuelta],
      digestAlgorithm: ALGORITMOS_FIRMA_SUNAT.digest,
    });

    try {
      firmante.computeSignature(xml, {
        prefix: 'ds',
        attrs: { Id: ID_SIGNATURE_XMLDSIG },
        existingPrefixes: contenedor.declaraPrefijoDs ? { ds: ESPACIOS_UBL.ds } : {},
        location: { reference: contenedor.xpath, action: 'append' },
      });
    } catch (error) {
      throw new FirmaXmlError(`No se pudo firmar el ${contenedor.raiz}: ${error instanceof Error ? error.message : String(error)}`);
    }

    const xmlFirmado = firmante.getSignedXml();
    const { digestValue, signatureValue } = leerValoresFirma(firmante.getSignatureXml());
    if (!digestValue || !signatureValue) {
      throw new FirmaXmlError('La firma generada no tiene DigestValue o SignatureValue.');
    }
    if (opciones.verificar !== false && !verificarFirmaXml(xmlFirmado, certificado.certificadoHojaPem)) {
      throw new FirmaXmlError('La firma generada no se pudo verificar localmente; no se enviará el comprobante.');
    }
    return { xmlFirmado, digestValue, signatureValue };
  }
}

const firmadorPorOmision = new FirmadorXmlSunat();

/** firmarXml(xml, material) → { xmlFirmado, digestValue (base64), signatureValue }. */
export function firmarXml(xml: string, material: MaterialFirma, opciones: OpcionesFirmaXml = {}): ResultadoFirmaXml {
  return firmadorPorOmision.firmar(xml, material, opciones);
}

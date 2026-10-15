import { createHash } from 'crypto';
import type { ResultadoFirmaXml } from '../documento-fiscal.types';
import { FirmaDemoNoPermitidaError } from '../errores-nucleo';
import { ID_SIGNATURE_XMLDSIG, PATRON_RAIZ_DOCUMENTO_SUNAT } from '../ubl/espacios-ubl';

export const MENSAJE_DEMO_EN_PRODUCCION = 'Firma DEMO no permitida en producción: cargue el certificado en Panel → Facturación SUNAT';

export interface OpcionesFirmaDemo {
  /** Entorno de ejecución (por omisión process.env.NODE_ENV). En 'production' siempre lanza. */
  entorno?: string;
}

/**
 * Firma DEMO: estructura ds:Signature con un hash local y SIN clave privada.
 * No es válida ante SUNAT; existe solo para pruebas explícitas del flujo
 * (armado, ZIP, envío simulado). Nunca se usa por omisión y en producción lanza.
 */
export function firmarXmlDemo(xml: string, opciones: OpcionesFirmaDemo = {}): ResultadoFirmaXml {
  const entorno = opciones.entorno ?? process.env.NODE_ENV;
  if (entorno === 'production') throw new FirmaDemoNoPermitidaError(MENSAJE_DEMO_EN_PRODUCCION);

  const raiz = PATRON_RAIZ_DOCUMENTO_SUNAT.exec(xml ?? '')?.[1];
  if (!raiz) throw new FirmaDemoNoPermitidaError('El XML no es un documento SUNAT: no se puede generar la firma DEMO.');

  const digestValue = createHash('sha256').update(xml, 'utf8').digest('base64');
  const signatureValue = `signature-demo-${createHash('sha256').update(digestValue).digest('hex').slice(0, 32)}`;
  const firma = [
    `<ds:Signature Id="${ID_SIGNATURE_XMLDSIG}">`,
    '<ds:SignedInfo>',
    '<ds:CanonicalizationMethod Algorithm="http://www.w3.org/TR/2001/REC-xml-c14n-20010315"/>',
    '<ds:SignatureMethod Algorithm="http://www.w3.org/2001/04/xmldsig-more#rsa-sha256"/>',
    '<ds:Reference URI="">',
    '<ds:Transforms><ds:Transform Algorithm="http://www.w3.org/2000/09/xmldsig#enveloped-signature"/></ds:Transforms>',
    '<ds:DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"/>',
    `<ds:DigestValue>${digestValue}</ds:DigestValue>`,
    '</ds:Reference>',
    '</ds:SignedInfo>',
    `<ds:SignatureValue>${signatureValue}</ds:SignatureValue>`,
    '<ds:KeyInfo><ds:X509Data><ds:X509Certificate>MI_CERTIFICADO_DEMO</ds:X509Certificate></ds:X509Data></ds:KeyInfo>',
    '</ds:Signature>',
  ].join('');

  // Con el contenedor vacío del builder se llena ahí (un solo ext:UBLExtensions); si no, se agrega antes del cierre de la raíz.
  const xmlFirmado = /<ext:ExtensionContent\s*\/>/.test(xml)
    ? xml.replace(/<ext:ExtensionContent\s*\/>/, `<ext:ExtensionContent>${firma}</ext:ExtensionContent>`)
    : xml.replace(
        new RegExp(`</((?:[\\w-]+:)?${raiz})>\\s*$`),
        `<ext:UBLExtensions xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2" xmlns:ds="http://www.w3.org/2000/09/xmldsig#"><ext:UBLExtension><ext:ExtensionContent>${firma}</ext:ExtensionContent></ext:UBLExtension></ext:UBLExtensions></$1>`,
      );

  return { xmlFirmado, digestValue, signatureValue };
}

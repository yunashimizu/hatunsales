import { readFileSync } from 'fs';
import * as forge from 'node-forge';
import { SignedXml } from 'xml-crypto';
import { DOMParser } from '@xmldom/xmldom';

export interface CertificadoCargado {
  privateKeyPem: string;
  certificatePem: string;
}

/**
 * Lee un certificado digital .p12/.pfx (el CDT gratuito de SUNAT+RENIEC o uno
 * comercial de un PSC acreditado ante INDECOPI) y extrae la clave privada y
 * el certificado en formato PEM para poder firmar XML.
 */
export class CertificadoDigitalService {
  cargarDesdeArchivo(rutaP12: string, password: string): CertificadoCargado {
    const buffer = readFileSync(rutaP12);
    return this.cargarDesdeBuffer(buffer, password);
  }

  cargarDesdeBuffer(buffer: Buffer, password: string): CertificadoCargado {
    let p12: forge.pkcs12.Pkcs12Pfx;
    try {
      const p12Asn1 = forge.asn1.fromDer(buffer.toString('binary'));
      p12 = forge.pkcs12.pkcs12FromAsn1(p12Asn1, password);
    } catch (error: any) {
      throw new Error(`No se pudo leer el certificado .p12: ${error?.message ?? 'archivo o clave inválidos'}`);
    }

    const keyBags = p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag] ?? [];
    const certBags = p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] ?? [];

    const privateKey = keyBags[0]?.key;
    const certificate = certBags[0]?.cert;

    if (!privateKey || !certificate) {
      throw new Error('El archivo .p12 no contiene una clave privada y un certificado válidos.');
    }

    return {
      privateKeyPem: forge.pki.privateKeyToPem(privateKey),
      certificatePem: forge.pki.certificateToPem(certificate),
    };
  }
}

export interface FirmaCertificadoResultado {
  xmlFirmado: string;
  digest: string;
  signatureValue: string;
}

/**
 * Firma XML-DSig real (canonicalización C14N + enveloped-signature + RSA-SHA256)
 * sobre documentos UBL 2.1, colocando la firma dentro de
 * ext:UBLExtensions/ext:UBLExtension/ext:ExtensionContent tal como exige SUNAT.
 * Reemplaza, cuando hay certificado configurado, a la firma DEMO (hash sin
 * clave privada) que sigue siendo el comportamiento por defecto.
 */
export class FirmadorXmlCertificado {
  constructor(private readonly certificado: CertificadoCargado) {}

  firmar(xml: string): FirmaCertificadoResultado {
    const firmante = new SignedXml({
      privateKey: this.certificado.privateKeyPem,
      publicCert: this.certificado.certificatePem,
      signatureAlgorithm: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256',
      canonicalizationAlgorithm: 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315',
    });

    firmante.addReference({
      xpath: '/*',
      isEmptyUri: true,
      transforms: ['http://www.w3.org/2000/09/xmldsig#enveloped-signature'],
      digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256',
    });

    firmante.computeSignature(xml, {
      prefix: 'ds',
      existingPrefixes: { ds: 'http://www.w3.org/2000/09/xmldsig#' },
      location: {
        reference: "//*[local-name(.)='ExtensionContent']",
        action: 'append',
      },
    });

    const xmlFirmado = firmante.getSignedXml();
    const signatureXml = firmante.getSignatureXml();
    const digest = signatureXml.match(/<(?:ds:)?DigestValue>([^<]+)<\/(?:ds:)?DigestValue>/)?.[1] ?? '';
    const signatureValue = signatureXml.match(/<(?:ds:)?SignatureValue>([^<]+)<\/(?:ds:)?SignatureValue>/)?.[1] ?? '';

    return { xmlFirmado, digest, signatureValue };
  }

  /** Verifica criptograficamente un XML ya firmado contra el certificado configurado. Util para probar antes de enviar a SUNAT. */
  verificar(xmlFirmado: string): boolean {
    const verificador = new SignedXml({ publicCert: this.certificado.certificatePem });
    const documento = new DOMParser().parseFromString(xmlFirmado);
    const [firma] = verificador.findSignatures(documento);
    if (!firma) return false;
    verificador.loadSignature(firma);
    return verificador.checkSignature(xmlFirmado);
  }
}

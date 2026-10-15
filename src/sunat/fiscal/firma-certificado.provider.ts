import { createHash, createPrivateKey, X509Certificate } from 'crypto';
import { readFileSync } from 'fs';
import { leerPkcs12 } from '../certificado/certificado-digital.util';
import type { MaterialFirma } from '../nucleo/documento-fiscal.types';
import { firmarXml, verificarFirmaXml } from '../nucleo/firma/firmador-xml';
import { separarCertificadosPem } from '../nucleo/firma/material-certificado';

// API del núcleo (contrato §12.1): firma genérica por raíz UBL, también para la GRE (DespatchAdvice).
export { extraerDigestValue, FirmadorXmlSunat, firmarXml, verificarFirmaXml, ALGORITMOS_FIRMA_SUNAT } from '../nucleo/firma/firmador-xml';
export type { OpcionesFirmaXml } from '../nucleo/firma/firmador-xml';
export { prepararMaterialFirma, separarCertificadosPem } from '../nucleo/firma/material-certificado';
export type { MaterialFirma } from '../nucleo/documento-fiscal.types';

export interface CertificadoCargado {
  privateKeyPem: string;
  certificatePem: string;
}

/** Arma un MaterialFirma a partir de una clave y su certificado (elige la hoja si el PEM trae la cadena). */
export function materialDesdeCertificado(certificado: CertificadoCargado): MaterialFirma {
  const bloques = separarCertificadosPem(certificado.certificatePem);
  let hoja: X509Certificate | null = null;
  try {
    const clave = createPrivateKey(certificado.privateKeyPem);
    hoja = bloques.map((b) => new X509Certificate(b)).find((x) => x.checkPrivateKey(clave)) ?? null;
  } catch {
    hoja = null;
  }
  const referencia = hoja ?? (bloques[0] ? new X509Certificate(bloques[0]) : null);
  return {
    privateKeyPem: certificado.privateKeyPem,
    certificatePem: certificado.certificatePem,
    huellaSha256: referencia ? createHash('sha256').update(referencia.raw).digest('hex') : '',
    vigenteHasta: referencia ? new Date(referencia.validTo) : new Date(0),
    autofirmado: referencia ? referencia.checkIssued(referencia) : false,
  };
}

/**
 * Lee un certificado .p12/.pfx (CDT de SUNAT/RENIEC o uno comercial) y
 * devuelve la clave privada y SU certificado (no el primero del archivo:
 * en muchos .pfx el primero es el de la entidad certificadora). Acepta
 * pkcs8ShroudedKeyBag y keyBag. Delega en certificado-digital.util (leerPkcs12),
 * que traduce los errores a mensajes claros en español.
 */
export class CertificadoDigitalService {
  /** @deprecated Ruta heredada (SUNAT_CERT_PATH). El certificado real se sube por el panel y se guarda cifrado. */
  cargarDesdeArchivo(rutaP12: string, password: string): CertificadoCargado {
    return this.cargarDesdeBuffer(readFileSync(rutaP12), password);
  }

  cargarDesdeBuffer(buffer: Buffer, password: string): CertificadoCargado {
    const leido = leerPkcs12(buffer, password);
    return { privateKeyPem: leido.privateKeyPem, certificatePem: leido.certificatePem };
  }

  /** MaterialFirma con los metadatos del certificado (huella, RUC, vigencia, autofirmado). */
  materialDesdeBuffer(buffer: Buffer, password: string): MaterialFirma {
    const leido = leerPkcs12(buffer, password);
    return {
      privateKeyPem: leido.privateKeyPem,
      certificatePem: leido.certificatePem,
      huellaSha256: leido.info.huellaSha256,
      ruc: leido.info.ruc,
      vigenteHasta: leido.info.vigenteHasta,
      autofirmado: leido.info.autofirmado,
    };
  }
}

export interface FirmaCertificadoResultado {
  xmlFirmado: string;
  /** DigestValue en base64 (valor resumen). */
  digest: string;
  signatureValue: string;
}

/**
 * @deprecated Use firmarXml(xml, material). Envoltorio heredado: firma XMLDSig
 * real (C14N, enveloped-signature, RSA-SHA256) con Id="SignatureSP" dentro del
 * ext:ExtensionContent y verificación local antes de devolver.
 */
export class FirmadorXmlCertificado {
  private readonly material: MaterialFirma;

  constructor(certificado: CertificadoCargado) {
    this.material = materialDesdeCertificado(certificado);
  }

  firmar(xml: string): FirmaCertificadoResultado {
    const resultado = firmarXml(xml, this.material);
    return { xmlFirmado: resultado.xmlFirmado, digest: resultado.digestValue, signatureValue: resultado.signatureValue };
  }

  /** Verifica criptográficamente un XML ya firmado contra el certificado configurado. */
  verificar(xmlFirmado: string): boolean {
    const bloques = separarCertificadosPem(this.material.certificatePem);
    try {
      const clave = createPrivateKey(this.material.privateKeyPem);
      const hoja = bloques.find((b) => new X509Certificate(b).checkPrivateKey(clave));
      return verificarFirmaXml(xmlFirmado, hoja ?? bloques[0]);
    } catch {
      return false;
    }
  }
}

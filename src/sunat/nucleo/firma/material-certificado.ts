import { createPrivateKey, KeyObject, X509Certificate } from 'crypto';
import type { MaterialFirma } from '../documento-fiscal.types';
import { CertificadoDigitalError } from '../errores-nucleo';

/** SUNAT exige claves RSA de al menos 1024 bits (Manual del Programador §3.1). */
export const BITS_MINIMOS_CLAVE = 1024;

const PATRON_PEM_CERTIFICADO = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;

/** Material listo para firmar: la clave y SOLO el certificado hoja que le corresponde. */
export interface CertificadoPreparado {
  clavePrivada: KeyObject;
  privateKeyPem: string;
  /** Certificado de la clave (hoja), el único que viaja en ds:KeyInfo. */
  certificadoHojaPem: string;
  vigenteDesde: Date;
  vigenteHasta: Date;
  bitsClave: number;
}

/** Bloques PEM de certificado contenidos en un texto (la hoja y, si viene, su cadena). */
export function separarCertificadosPem(pem: string): string[] {
  return String(pem ?? '').match(PATRON_PEM_CERTIFICADO)?.map((bloque) => `${bloque.trim()}\n`) ?? [];
}

// El certificado cacheado del panel reutiliza el mismo objeto MaterialFirma (inmutable): se parsea una sola vez.
const preparados = new WeakMap<MaterialFirma, CertificadoPreparado>();

function leerFecha(texto: string): Date {
  const fecha = new Date(texto);
  if (Number.isNaN(fecha.getTime())) {
    throw new CertificadoDigitalError('FISCAL_CERT_FORMATO_INVALIDO', 'No se pudo leer la vigencia del certificado digital.');
  }
  return fecha;
}

function preparar(material: MaterialFirma): CertificadoPreparado {
  if (!material || typeof material.privateKeyPem !== 'string' || typeof material.certificatePem !== 'string') {
    throw new CertificadoDigitalError('FISCAL_CERT_FORMATO_INVALIDO', 'El material de firma está incompleto (falta la clave privada o el certificado).');
  }

  let clavePrivada: KeyObject;
  try {
    clavePrivada = createPrivateKey(material.privateKeyPem);
  } catch {
    throw new CertificadoDigitalError('FISCAL_CERT_FORMATO_INVALIDO', 'La clave privada del certificado digital no es válida.');
  }
  if (clavePrivada.asymmetricKeyType !== 'rsa') {
    throw new CertificadoDigitalError('FISCAL_CERT_FORMATO_NO_SOPORTADO', 'SUNAT requiere un certificado con clave RSA.');
  }
  const bitsClave = clavePrivada.asymmetricKeyDetails?.modulusLength ?? 0;
  if (bitsClave < BITS_MINIMOS_CLAVE) {
    throw new CertificadoDigitalError('FISCAL_CERT_FORMATO_NO_SOPORTADO', `La clave del certificado tiene ${bitsClave} bits; SUNAT exige al menos ${BITS_MINIMOS_CLAVE}.`);
  }

  const bloques = separarCertificadosPem(material.certificatePem);
  if (bloques.length === 0) {
    throw new CertificadoDigitalError('FISCAL_CERT_FORMATO_INVALIDO', 'El material de firma no contiene un certificado X.509 en formato PEM.');
  }

  for (const bloque of bloques) {
    let x509: X509Certificate;
    try {
      x509 = new X509Certificate(bloque);
    } catch {
      continue;
    }
    if (x509.checkPrivateKey(clavePrivada)) {
      return {
        clavePrivada,
        privateKeyPem: clavePrivada.export({ type: 'pkcs8', format: 'pem' }).toString(),
        certificadoHojaPem: x509.toString(),
        vigenteDesde: leerFecha(x509.validFrom),
        vigenteHasta: leerFecha(x509.validTo),
        bitsClave,
      };
    }
  }
  throw new CertificadoDigitalError(
    'FISCAL_CERT_NO_CORRESPONDE',
    'Ningún certificado del archivo corresponde a la clave privada: vuelva a exportar el .pfx con su certificado.',
  );
}

/**
 * Valida el material y elige el certificado hoja (el que corresponde a la
 * clave, aunque el PEM traiga también la cadena de la entidad certificadora).
 * Rechaza certificados vencidos o aún no vigentes: SUNAT los rechazaría y el
 * número del comprobante quedaría usado.
 */
export function prepararMaterialFirma(material: MaterialFirma, ahora: Date = new Date()): CertificadoPreparado {
  let preparado = preparados.get(material);
  if (!preparado) {
    preparado = preparar(material);
    preparados.set(material, preparado);
  }
  if (ahora.getTime() > preparado.vigenteHasta.getTime()) {
    throw new CertificadoDigitalError(
      'FISCAL_CERT_VENCIDO',
      `El certificado digital venció el ${preparado.vigenteHasta.toISOString().slice(0, 10)}: cargue uno vigente en Panel → Facturación SUNAT.`,
    );
  }
  if (ahora.getTime() < preparado.vigenteDesde.getTime()) {
    throw new CertificadoDigitalError(
      'FISCAL_CERT_NO_VIGENTE',
      `El certificado digital recién es válido desde el ${preparado.vigenteDesde.toISOString().slice(0, 10)}.`,
    );
  }
  return preparado;
}

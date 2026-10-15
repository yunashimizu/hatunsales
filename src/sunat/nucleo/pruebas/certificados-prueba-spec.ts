/**
 * Utilidades SOLO para specs (el sufijo -spec.ts lo excluye del build y jest
 * no lo ejecuta como suite): certificados autofirmados y cadenas CA → hoja
 * generados en memoria. Nunca se usan contra SUNAT.
 */
import { createHash, generateKeyPairSync } from 'crypto';
import * as forge from 'node-forge';
import type { MaterialFirma } from '../documento-fiscal.types';

export interface CertificadoPrueba {
  privateKeyPem: string;
  certificatePem: string;
  llave: forge.pki.rsa.PrivateKey;
  certificado: forge.pki.Certificate;
}

export interface OpcionesCertificadoPrueba {
  nombre?: string;
  ruc?: string;
  desde?: Date;
  hasta?: Date;
  /** Si llega, el certificado lo firma esta CA (si no, es autofirmado). */
  emisor?: CertificadoPrueba;
  esCa?: boolean;
  bits?: number;
}

const DIA_MS = 24 * 60 * 60 * 1000;
let serie = 1;

export function generarCertificadoPrueba(opciones: OpcionesCertificadoPrueba = {}): CertificadoPrueba {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: opciones.bits ?? 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const llave = forge.pki.privateKeyFromPem(privateKey) as forge.pki.rsa.PrivateKey;
  const certificado = forge.pki.createCertificate();
  certificado.publicKey = forge.pki.publicKeyFromPem(publicKey);
  certificado.serialNumber = (serie++).toString(16).padStart(4, '0');
  certificado.validity.notBefore = opciones.desde ?? new Date(Date.now() - DIA_MS);
  certificado.validity.notAfter = opciones.hasta ?? new Date(Date.now() + 365 * DIA_MS);
  const sujeto = [
    { name: 'commonName', value: opciones.nombre ?? 'HATUNSALES S.A.C. (PRUEBAS)' },
    { name: 'organizationalUnitName', value: opciones.ruc ?? '20610206337' },
    { name: 'countryName', value: 'PE' },
  ];
  certificado.setSubject(sujeto);
  certificado.setIssuer(opciones.emisor ? opciones.emisor.certificado.subject.attributes : sujeto);
  certificado.setExtensions([{ name: 'basicConstraints', cA: !!opciones.esCa }]);
  certificado.sign(opciones.emisor ? opciones.emisor.llave : llave, forge.md.sha256.create());
  return { privateKeyPem: privateKey, certificatePem: forge.pki.certificateToPem(certificado), llave, certificado };
}

export function materialDePrueba(certificado: CertificadoPrueba, certificatePem = certificado.certificatePem, autofirmado = true): MaterialFirma {
  return {
    privateKeyPem: certificado.privateKeyPem,
    certificatePem,
    huellaSha256: createHash('sha256').update(certificatePem).digest('hex'),
    ruc: '20610206337',
    vigenteHasta: certificado.certificado.validity.notAfter,
    autofirmado,
  };
}

/** PKCS#12 (.pfx) con la clave y los certificados en el orden indicado (p. ej. la CA primero). */
export function pfxDePrueba(llave: forge.pki.rsa.PrivateKey, certificados: forge.pki.Certificate[], clave: string): Buffer {
  const asn1 = forge.pkcs12.toPkcs12Asn1(llave, certificados, clave, { algorithm: '3des' });
  return Buffer.from(forge.asn1.toDer(asn1).getBytes(), 'binary');
}

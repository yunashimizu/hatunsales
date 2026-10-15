import { generateKeyPairSync, randomBytes } from 'crypto';
import * as forge from 'node-forge';
import { firmarCertificadoConOpenSsl } from './certificado-digital.util';

/**
 * Fábrica de certificados y .pfx para las pruebas (no entra al build: termina
 * en «spec.ts», y jest no la toma como suite porque no es «.spec.ts»).
 * Las claves RSA se generan con OpenSSL (rápido); el PKCS#12 con node-forge.
 */

export const RUC_PRUEBA = '20610206337';
export const OTRO_RUC = '20100070970';
const DIA = 24 * 3600 * 1000;

export interface ParPrueba {
  privada: forge.pki.rsa.PrivateKey;
  publica: forge.pki.rsa.PublicKey;
  /** PKCS#8 PEM: se firma con OpenSSL (node-forge en JS es ~25 veces más lento dentro de jest). */
  pem: string;
}

export function parRsa(bits = 2048): ParPrueba {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: bits,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  return {
    privada: forge.pki.privateKeyFromPem(privateKey) as forge.pki.rsa.PrivateKey,
    publica: forge.pki.publicKeyFromPem(publicKey) as forge.pki.rsa.PublicKey,
    pem: privateKey,
  };
}

export interface OpcionesCertificado {
  sujeto: forge.pki.CertificateField[];
  emisor?: forge.pki.CertificateField[];
  par: ParPrueba;
  /** Par con el que se firma (el de la CA); por omisión, el propio (autofirmado). */
  firmante?: ParPrueba;
  desde?: Date;
  hasta?: Date;
  ca?: boolean;
  extensiones?: any[];
}

export function certificado(o: OpcionesCertificado): forge.pki.Certificate {
  const cert = forge.pki.createCertificate();
  cert.publicKey = o.par.publica;
  cert.serialNumber = `01${randomBytes(8).toString('hex')}`;
  cert.validity.notBefore = o.desde ?? new Date(Date.now() - DIA);
  cert.validity.notAfter = o.hasta ?? new Date(Date.now() + 365 * DIA);
  cert.setSubject(o.sujeto);
  cert.setIssuer(o.emisor ?? o.sujeto);
  cert.setExtensions(
    o.extensiones ?? [
      { name: 'basicConstraints', cA: !!o.ca },
      o.ca ? { name: 'keyUsage', keyCertSign: true, cRLSign: true } : { name: 'keyUsage', digitalSignature: true, nonRepudiation: true },
    ],
  );
  firmarCertificadoConOpenSsl(cert, (o.firmante ?? o.par).pem);
  return cert;
}

export function sujetoEmpresa(ruc: string | null = RUC_PRUEBA, nombre = 'HATUNSALES S.A.C.'): forge.pki.CertificateField[] {
  const campos: forge.pki.CertificateField[] = [
    { name: 'commonName', value: nombre },
    { name: 'organizationName', value: nombre },
  ];
  if (ruc) campos.push({ name: 'organizationalUnitName', value: ruc });
  campos.push({ name: 'countryName', value: 'PE' });
  return campos;
}

export function pfx(
  llave: forge.pki.rsa.PrivateKey | null,
  cadena: forge.pki.Certificate[],
  clave: string,
  algoritmo: '3des' | 'aes256' = '3des',
): Buffer {
  const asn1 = forge.pkcs12.toPkcs12Asn1(llave, cadena, clave, { algorithm: algoritmo, generateLocalKeyId: true });
  return Buffer.from(forge.asn1.toDer(asn1).getBytes(), 'binary');
}

/** Certificado de una «CA» y una hoja firmada por ella, empaquetados con la CA primero. */
export function pfxConCadena(clave: string, rucHoja: string | null = RUC_PRUEBA): {
  contenido: Buffer;
  hoja: forge.pki.Certificate;
  ca: forge.pki.Certificate;
} {
  const parCa = parRsa(2048);
  const sujetoCa: forge.pki.CertificateField[] = [
    { name: 'commonName', value: 'CA DE PRUEBA HATUNSALES' },
    { name: 'organizationName', value: 'ENTIDAD DE PRUEBA' },
    { name: 'countryName', value: 'PE' },
  ];
  const ca = certificado({ sujeto: sujetoCa, par: parCa, ca: true, hasta: new Date(Date.now() + 3650 * DIA) });
  const parHoja = parRsa(2048);
  const hoja = certificado({ sujeto: sujetoEmpresa(rucHoja), emisor: sujetoCa, par: parHoja, firmante: parCa });
  return { contenido: pfx(parHoja.privada, [ca, hoja], clave), hoja, ca };
}

export function pfxAutofirmado(opciones: {
  clave: string;
  ruc?: string | null;
  desde?: Date;
  hasta?: Date;
  bits?: number;
  algoritmo?: '3des' | 'aes256';
}): Buffer {
  const par = parRsa(opciones.bits ?? 2048);
  const cert = certificado({ sujeto: sujetoEmpresa(opciones.ruc === undefined ? RUC_PRUEBA : opciones.ruc), par, desde: opciones.desde, hasta: opciones.hasta });
  return pfx(par.privada, [cert], opciones.clave, opciones.algoritmo ?? '3des');
}

export const LLAVE_PRUEBA = randomBytes(32).toString('base64');
export const OTRA_LLAVE_PRUEBA = randomBytes(32).toString('base64');
export const DIAS = DIA;

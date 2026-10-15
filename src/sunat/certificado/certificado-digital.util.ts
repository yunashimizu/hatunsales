import { constants, createPrivateKey, generateKeyPair, KeyObject, privateEncrypt, randomBytes, X509Certificate } from 'crypto';
import * as forge from 'node-forge';
import { promisify } from 'util';
import { FiscalConfigError } from '../config/fiscal-errores';
import { Ruc } from '../config/ruc';

/**
 * Lectura y generación de certificados digitales PKCS#12 (.pfx / .p12).
 *
 * - Recorre TODAS las bolsas de claves y certificados y elige el certificado
 *   cuya clave pública corresponde a la clave privada (no el primero: en muchos
 *   .pfx el primero es el de la entidad certificadora).
 * - Valida el par con OpenSSL (X509Certificate.checkPrivateKey).
 * - Traduce los errores de node-forge a errores de dominio en español.
 * Nunca escribe nada en disco ni en el log.
 */

export interface InfoCertificado {
  titular: string | null;
  ruc: string | null;
  numeroSerie: string;
  emisor: string | null;
  vigenteDesde: Date;
  vigenteHasta: Date;
  bitsClave: number;
  huellaSha256: string;
  autofirmado: boolean;
  /** null si el certificado no trae la extensión keyUsage. */
  permiteFirma: boolean | null;
}

export interface CertificadoLeido {
  /** Clave privada en PKCS#8 PEM. */
  privateKeyPem: string;
  certificatePem: string;
  info: InfoCertificado;
}

export type FormatoCertificadoPublico = 'cer' | 'pem';

export const BITS_MINIMOS_SUNAT = 1024;
export const BITS_RECOMENDADOS = 2048;

const TAG_UTF8 = 12;
const TAG_BMP = 30;
const OID_IDENTIFICADOR_ORGANIZACION = '2.5.4.97';
const OID_NUMERO_SERIE_SUJETO = '2.5.4.5';

const ayudaLegacy =
  'Reexpórtelo con compatibilidad: `openssl pkcs12 -legacy -in cert.pfx -out cert-legacy.pfx` '
  + '(o, en Windows, exportando con cifrado TripleDES-SHA1).';

/** Un PKCS#12 es DER: empieza con una SEQUENCE (0x30) y no es diminuto. */
export function pareceDer(contenido: Buffer): boolean {
  return Buffer.isBuffer(contenido) && contenido.length >= 64 && contenido[0] === 0x30;
}

const MENSAJE_SOLO_PUBLICO =
  'Ese archivo es solo el certificado público (.cer/.crt), sin la clave privada. '
  + 'Suba el .pfx o .p12 que descargó del buzón SOL (o que exportó «con la clave privada»).';

/**
 * El tipo se decide por el CONTENIDO, no por la extensión ni el mimetype:
 * - DER binario (lo normal en .pfx/.p12) se usa tal cual;
 * - un .pfx copiado como texto Base64 (con o sin cabecera PKCS12) se decodifica;
 * - un certificado o clave sueltos en PEM se rechazan con un mensaje claro.
 */
export function normalizarContenidoPkcs12(contenido: Buffer): Buffer {
  if (!Buffer.isBuffer(contenido) || contenido.length === 0) {
    throw new FiscalConfigError('FISCAL_CERT_FORMATO_INVALIDO', 'El archivo está vacío.');
  }
  if (pareceDer(contenido)) return contenido;

  const texto = contenido.toString('latin1').trim();
  if (/-----BEGIN (TRUSTED )?CERTIFICATE-----/.test(texto)) {
    throw new FiscalConfigError('FISCAL_CERT_SIN_CLAVE_PRIVADA', MENSAJE_SOLO_PUBLICO);
  }
  if (/-----BEGIN (RSA |EC |ENCRYPTED )?PRIVATE KEY-----/.test(texto)) {
    throw new FiscalConfigError(
      'FISCAL_CERT_FORMATO_INVALIDO',
      'Ese archivo contiene solo la clave privada. Suba el .pfx/.p12 que junta la clave y el certificado.',
    );
  }
  const cuerpo = texto.replace(/-----(BEGIN|END) PKCS12-----/g, '').replace(/\s+/g, '');
  if (cuerpo.length >= 88 && /^[A-Za-z0-9+/]+={0,2}$/.test(cuerpo)) {
    const decodificado = Buffer.from(cuerpo, 'base64');
    if (pareceDer(decodificado)) return decodificado;
  }
  throw new FiscalConfigError('FISCAL_CERT_FORMATO_INVALIDO', 'El archivo no es un certificado .pfx/.p12 válido o está dañado.');
}

/** ¿Es un certificado X.509 suelto (DER), sin clave? */
function esCertificadoSuelto(asn1: forge.asn1.Asn1): boolean {
  try {
    forge.pki.certificateFromAsn1(asn1);
    return true;
  } catch {
    return false;
  }
}

export function leerPkcs12(contenidoOriginal: Buffer, clave: string): CertificadoLeido {
  const contenido = normalizarContenidoPkcs12(contenidoOriginal);

  let p12: forge.pkcs12.Pkcs12Pfx;
  let asn1: forge.asn1.Asn1 | null = null;
  try {
    asn1 = forge.asn1.fromDer(contenido.toString('binary'));
    p12 = forge.pkcs12.pkcs12FromAsn1(asn1, false, clave ?? '');
  } catch (error) {
    if (asn1 && esCertificadoSuelto(asn1)) {
      throw new FiscalConfigError('FISCAL_CERT_SIN_CLAVE_PRIVADA', MENSAJE_SOLO_PUBLICO);
    }
    throw traducirErrorPkcs12(error);
  }

  const oids = forge.pki.oids;
  const bolsasClave = [
    ...(p12.getBags({ bagType: oids.pkcs8ShroudedKeyBag })[oids.pkcs8ShroudedKeyBag] ?? []),
    ...(p12.getBags({ bagType: oids.keyBag })[oids.keyBag] ?? []),
  ];
  if (!bolsasClave.length) {
    throw new FiscalConfigError(
      'FISCAL_CERT_SIN_CLAVE_PRIVADA',
      'El archivo no contiene la clave privada. Exporte el certificado «con la clave privada» (.pfx o .p12).',
    );
  }

  const llaves = bolsasClave
    .map((bolsa) => bolsa.key as forge.pki.rsa.PrivateKey | undefined)
    .filter((llave): llave is forge.pki.rsa.PrivateKey => !!llave && !!(llave as any).n);
  if (!llaves.length) {
    throw new FiscalConfigError(
      'FISCAL_CERT_FORMATO_NO_SOPORTADO',
      'La clave del certificado no es RSA (por ejemplo, es de curva elíptica). SUNAT requiere un certificado RSA.',
    );
  }

  const certificados = (p12.getBags({ bagType: oids.certBag })[oids.certBag] ?? [])
    .map((bolsa) => bolsa.cert)
    .filter((cert): cert is forge.pki.Certificate => !!cert);

  for (const llave of llaves) {
    const propio = certificados.find((cert) => {
      const publica = cert.publicKey as forge.pki.rsa.PublicKey;
      return !!publica?.n && publica.n.equals(llave.n);
    });
    if (propio) return armarCertificado(llave, propio);
  }

  throw new FiscalConfigError(
    'FISCAL_CERT_FORMATO_INVALIDO',
    'El archivo no incluye el certificado que corresponde a su clave privada. Expórtelo de nuevo incluyendo el certificado.',
  );
}

function armarCertificado(llave: forge.pki.rsa.PrivateKey, cert: forge.pki.Certificate): CertificadoLeido {
  const certificatePem = forge.pki.certificateToPem(cert);
  let privada: KeyObject;
  let x509: X509Certificate;
  try {
    privada = createPrivateKey(forge.pki.privateKeyToPem(llave));
    x509 = new X509Certificate(certificatePem);
  } catch {
    throw new FiscalConfigError('FISCAL_CERT_FORMATO_INVALIDO', 'No se pudo interpretar la clave o el certificado del archivo.');
  }
  if (!x509.checkPrivateKey(privada)) {
    throw new FiscalConfigError('FISCAL_CERT_FORMATO_INVALIDO', 'La clave privada no corresponde al certificado del archivo.');
  }

  return {
    privateKeyPem: privada.export({ type: 'pkcs8', format: 'pem' }).toString(),
    certificatePem,
    info: extraerInfo(cert, x509, llave.n.bitLength()),
  };
}

export function extraerInfo(cert: forge.pki.Certificate, x509: X509Certificate, bitsClave: number): InfoCertificado {
  const sujeto = atributos(cert.subject.attributes);
  const emisor = atributos(cert.issuer.attributes);
  const usos = cert.getExtension('keyUsage') as { digitalSignature?: boolean; nonRepudiation?: boolean } | null;

  return {
    titular: primero(sujeto, 'CN') ?? primero(sujeto, 'O'),
    ruc: buscarRuc(sujeto) ?? Ruc.buscarEn(nombresAlternativos(cert, x509).join(' ')),
    numeroSerie: String(cert.serialNumber ?? '').toUpperCase(),
    emisor: primero(emisor, 'CN') ?? primero(emisor, 'O') ?? primero(emisor, 'OU'),
    vigenteDesde: new Date(cert.validity.notBefore),
    vigenteHasta: new Date(cert.validity.notAfter),
    bitsClave,
    huellaSha256: x509.fingerprint256.replace(/:/g, '').toLowerCase(),
    autofirmado: esAutofirmado(x509),
    permiteFirma: usos ? !!(usos.digitalSignature || usos.nonRepudiation) : null,
  };
}

/** SUNAT pide el RUC en el OU; algunos emisores lo ponen en serialNumber u organizationIdentifier. */
function buscarRuc(sujeto: Array<{ clave: string; valor: string }>): string | null {
  const prioridad = ['OU', OID_NUMERO_SERIE_SUJETO, OID_IDENTIFICADOR_ORGANIZACION, 'CN', 'O'];
  for (const clave of prioridad) {
    for (const atributo of sujeto.filter((a) => a.clave === clave)) {
      const ruc = Ruc.buscarEn(atributo.valor);
      if (ruc) return ruc;
    }
  }
  return Ruc.buscarEn(sujeto.map((a) => a.valor).join(' '));
}

/** Textos del subjectAltName (algunas entidades ponen ahí el RUC). */
function nombresAlternativos(cert: forge.pki.Certificate, x509: X509Certificate): string[] {
  const valores: string[] = [];
  const extension = cert.getExtension('subjectAltName') as { altNames?: Array<{ value?: unknown }> } | null;
  for (const nombre of extension?.altNames ?? []) {
    if (typeof nombre?.value === 'string') valores.push(nombre.value);
  }
  // OpenSSL entrega además otherName/dirName ya decodificados como texto.
  if (x509.subjectAltName) valores.push(x509.subjectAltName);
  return valores;
}

/**
 * Autofirmado = el emisor es el mismo sujeto y la firma valida con su propia
 * clave pública. (No se usa checkIssued: OpenSSL lo niega si el certificado no
 * tiene keyCertSign, que es lo normal en un certificado de firma.)
 */
function esAutofirmado(x509: X509Certificate): boolean {
  try {
    return x509.subject === x509.issuer && x509.verify(x509.publicKey);
  } catch {
    return false;
  }
}

function atributos(lista: forge.pki.CertificateField[]): Array<{ clave: string; valor: string }> {
  return lista.map((atributo) => ({
    // shortName para los conocidos (CN, O, OU); el OID para el resto (2.5.4.5, 2.5.4.97).
    clave: atributo.shortName ?? atributo.type ?? atributo.name ?? '',
    valor: decodificarValor(atributo),
  }));
}

/** node-forge 1.3 entrega UTF8String/BMPString sin decodificar ("PEÃ\x91A"). */
function decodificarValor(atributo: forge.pki.CertificateField): string {
  const valor = String(atributo.value ?? '');
  const etiqueta = Number(atributo.valueTagClass);
  try {
    if (etiqueta === TAG_UTF8) return forge.util.decodeUtf8(valor);
    if (etiqueta === TAG_BMP) return Buffer.from(valor, 'binary').swap16().toString('utf16le');
  } catch {
    // Valor mal codificado: se devuelve tal cual.
  }
  return valor;
}

function primero(lista: Array<{ clave: string; valor: string }>, clave: string): string | null {
  return lista.find((a) => a.clave === clave && a.valor.trim())?.valor.trim() ?? null;
}

export function traducirErrorPkcs12(error: unknown): FiscalConfigError {
  const mensaje = String((error as any)?.message ?? error ?? '');
  if (/invalid password|wrong password|failed to decrypt|mac could not be verified/i.test(mensaje)) {
    return new FiscalConfigError('FISCAL_CERT_CLAVE_INCORRECTA', 'La contraseña del certificado no es correcta.');
  }
  if (/unsupported|not supported|unknown (hash|encryption)|unavailable|only pkcs#12 pfx in password/i.test(mensaje)) {
    return new FiscalConfigError(
      'FISCAL_CERT_FORMATO_NO_SOPORTADO',
      `El certificado usa un cifrado que el sistema no puede abrir. ${ayudaLegacy}`,
    );
  }
  return new FiscalConfigError('FISCAL_CERT_FORMATO_INVALIDO', 'El archivo no es un certificado .pfx/.p12 válido o está dañado.');
}

/**
 * Parte pública del certificado para registrarla en SOL («Actualización de
 * certificado digital»): 'cer' = DER binario; 'pem' = el mismo certificado en
 * texto Base64 (ambos se guardan con extensión .cer, que es lo que pide SOL).
 */
export function certificadoPublico(
  certificatePem: string,
  formato: FormatoCertificadoPublico,
): { contenido: Buffer; mime: string; extension: string } {
  const x509 = new X509Certificate(certificatePem);
  if (formato === 'pem') {
    return { contenido: Buffer.from(x509.toString(), 'utf8'), mime: 'application/x-pem-file', extension: 'cer' };
  }
  return { contenido: x509.raw, mime: 'application/pkix-cert', extension: 'cer' };
}

const generarParRsa = promisify(generateKeyPair);

/** DigestInfo DER de SHA-256 (RFC 8017 §9.2): prefijo + 32 bytes del resumen. */
const PREFIJO_DIGEST_INFO_SHA256 = Buffer.from('3031300d060960864801650304020105000420', 'hex');

/**
 * Firma el certificado con OpenSSL (RSASSA-PKCS1-v1_5 + SHA-256) en lugar de
 * la aritmética en JS de node-forge, que es lenta. node-forge solo arma el
 * TBSCertificate y nos entrega su resumen.
 */
export function firmarCertificadoConOpenSsl(cert: forge.pki.Certificate, privateKeyPem: string): void {
  const firmante = {
    sign: (md: forge.md.MessageDigest) => {
      const resumen = Buffer.from(md.digest().getBytes(), 'binary');
      return privateEncrypt(
        { key: privateKeyPem, padding: constants.RSA_PKCS1_PADDING },
        Buffer.concat([PREFIJO_DIGEST_INFO_SHA256, resumen]),
      ).toString('binary');
    },
  };
  cert.sign(firmante as unknown as forge.pki.rsa.PrivateKey, forge.md.sha256.create());
}

export interface OpcionesAutofirmado {
  ruc: string;
  razonSocial: string;
  clave: string;
  dias?: number;
  ahora?: Date;
}

/**
 * Certificado autofirmado para SUNAT BETA (que no valida la cadena): RSA 2048
 * generado por OpenSSL en el pool de hilos (no bloquea el event loop),
 * SHA-256, OU = RUC, C = PE, empaquetado en PKCS#12 con 3DES.
 */
export async function generarAutofirmado(opciones: OpcionesAutofirmado): Promise<Buffer> {
  const dias = Math.min(3650, Math.max(1, Math.trunc(opciones.dias ?? 365)));
  const ahora = opciones.ahora ?? new Date();
  const { privateKey, publicKey } = await generarParRsa('rsa', {
    modulusLength: BITS_RECOMENDADOS,
    publicExponent: 0x10001,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });

  const llave = forge.pki.privateKeyFromPem(privateKey);
  const cert = forge.pki.createCertificate();
  cert.publicKey = forge.pki.publicKeyFromPem(publicKey);
  // Serie positiva de 16 bytes (el primer byte < 0x80 evita un entero negativo en DER).
  cert.serialNumber = `01${randomBytes(15).toString('hex')}`;
  cert.validity.notBefore = new Date(ahora.getTime() - 24 * 3600 * 1000);
  cert.validity.notAfter = new Date(ahora.getTime() + dias * 24 * 3600 * 1000);

  // Con valueTagClass UTF8, node-forge codifica el texto él mismo (no pre-codificar).
  const razonSocial = opciones.razonSocial.trim() || 'EMISOR DE PRUEBAS';
  const sujeto = [
    { name: 'commonName', value: razonSocial, valueTagClass: TAG_UTF8 as any },
    { name: 'organizationName', value: razonSocial, valueTagClass: TAG_UTF8 as any },
    { name: 'organizationalUnitName', value: opciones.ruc },
    { name: 'countryName', value: 'PE' },
  ];
  cert.setSubject(sujeto);
  cert.setIssuer(sujeto);
  cert.setExtensions([
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', digitalSignature: true, nonRepudiation: true },
    { name: 'subjectKeyIdentifier' },
  ]);
  firmarCertificadoConOpenSsl(cert, privateKey);

  const p12 = forge.pkcs12.toPkcs12Asn1(llave, [cert], opciones.clave, {
    algorithm: '3des',
    friendlyName: 'HatunSales SUNAT BETA',
    generateLocalKeyId: true,
  });
  return Buffer.from(forge.asn1.toDer(p12).getBytes(), 'binary');
}

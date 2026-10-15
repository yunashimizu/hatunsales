import { createPublicKey, sign, verify, X509Certificate } from 'crypto';
import * as forge from 'node-forge';
import { FiscalConfigError } from '../config/fiscal-errores';
import { certificadoPublico, generarAutofirmado, leerPkcs12, normalizarContenidoPkcs12 } from './certificado-digital.util';
import {
  certificado,
  DIAS,
  OTRO_RUC,
  parRsa,
  pfx,
  pfxAutofirmado,
  pfxConCadena,
  RUC_PRUEBA,
  sujetoEmpresa,
} from './certificados.prueba-spec';

function codigoDe(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (error) {
    return error instanceof FiscalConfigError ? error.codigo : `otro: ${(error as Error).message}`;
  }
}

describe('certificado-digital.util (PKCS#12 con node-forge)', () => {
  it('abre un .pfx con su contraseña y extrae titular, RUC, serie, emisor, vigencia, bits y huella', () => {
    const contenido = pfxAutofirmado({ clave: 'secreta123' });
    const leido = leerPkcs12(contenido, 'secreta123');

    expect(leido.info.titular).toBe('HATUNSALES S.A.C.');
    expect(leido.info.ruc).toBe(RUC_PRUEBA);
    expect(leido.info.numeroSerie).toMatch(/^[0-9A-F]+$/);
    expect(leido.info.emisor).toBe('HATUNSALES S.A.C.');
    expect(leido.info.bitsClave).toBe(2048);
    expect(leido.info.autofirmado).toBe(true);
    expect(leido.info.huellaSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(leido.info.vigenteHasta.getTime()).toBeGreaterThan(Date.now());
    expect(leido.privateKeyPem).toContain('BEGIN PRIVATE KEY');

    // La clave privada y el certificado forman un par que firma de verdad.
    const datos = Buffer.from('comprobante');
    const firma = sign('sha256', datos, leido.privateKeyPem);
    expect(verify('sha256', datos, new X509Certificate(leido.certificatePem).publicKey, firma)).toBe(true);
  });

  it('con la contraseña incorrecta responde FISCAL_CERT_CLAVE_INCORRECTA', () => {
    const contenido = pfxAutofirmado({ clave: 'correcta1' });
    expect(codigoDe(() => leerPkcs12(contenido, 'otra-clave'))).toBe('FISCAL_CERT_CLAVE_INCORRECTA');
  });

  it('con la cadena de la CA primero elige el certificado que corresponde a la clave privada (la hoja)', () => {
    const { contenido, hoja } = pfxConCadena('cadena123');
    const leido = leerPkcs12(contenido, 'cadena123');
    expect(leido.info.autofirmado).toBe(false);
    expect(leido.info.emisor).toBe('CA DE PRUEBA HATUNSALES');
    expect(leido.info.ruc).toBe(RUC_PRUEBA);
    expect(leido.certificatePem.replace(/\r/g, '')).toBe(forge.pki.certificateToPem(hoja).replace(/\r/g, ''));
  });

  it('abre un .pfx moderno (PBES2/AES-256, como exporta OpenSSL 3)', () => {
    const contenido = pfxAutofirmado({ clave: 'moderno1', algoritmo: 'aes256' });
    expect(leerPkcs12(contenido, 'moderno1').info.ruc).toBe(RUC_PRUEBA);
  });

  it('acepta el .pfx copiado como texto Base64', () => {
    const contenido = pfxAutofirmado({ clave: 'base64ok' });
    const comoTexto = Buffer.from(contenido.toString('base64').replace(/(.{64})/g, '$1\n'), 'latin1');
    expect(leerPkcs12(comoTexto, 'base64ok').info.titular).toBe('HATUNSALES S.A.C.');
  });

  it('busca el RUC en serialNumber, organizationIdentifier y subjectAltName; si no está, devuelve null', () => {
    const par = parRsa();
    const conSerial = certificado({
      sujeto: [{ name: 'commonName', value: 'EMPRESA' }, { type: '2.5.4.5', value: `RUC${RUC_PRUEBA}` }],
      par,
    });
    expect(leerPkcs12(pfx(par.privada, [conSerial], 'a'), 'a').info.ruc).toBe(RUC_PRUEBA);

    const conOrgId = certificado({
      sujeto: [{ name: 'commonName', value: 'EMPRESA' }, { type: '2.5.4.97', value: `VATPE-${RUC_PRUEBA}` }],
      par,
    });
    expect(leerPkcs12(pfx(par.privada, [conOrgId], 'a'), 'a').info.ruc).toBe(RUC_PRUEBA);

    const conSan = certificado({
      sujeto: [{ name: 'commonName', value: 'EMPRESA' }],
      par,
      extensiones: [{ name: 'subjectAltName', altNames: [{ type: 2, value: `ruc${RUC_PRUEBA}.hatunsales.pe` }] }],
    });
    expect(leerPkcs12(pfx(par.privada, [conSan], 'a'), 'a').info.ruc).toBe(RUC_PRUEBA);

    const sinRuc = certificado({ sujeto: sujetoEmpresa(null), par });
    expect(leerPkcs12(pfx(par.privada, [sinRuc], 'a'), 'a').info.ruc).toBeNull();

    // 11 dígitos que no son un RUC válido (dígito verificador) no cuentan.
    const rucInvalido = certificado({ sujeto: sujetoEmpresa('20610206330'), par });
    expect(leerPkcs12(pfx(par.privada, [rucInvalido], 'a'), 'a').info.ruc).toBeNull();
  });

  it('informa el RUC de otro contribuyente tal cual (la política decide)', () => {
    const contenido = pfxAutofirmado({ clave: 'x1234567', ruc: OTRO_RUC });
    expect(leerPkcs12(contenido, 'x1234567').info.ruc).toBe(OTRO_RUC);
  });

  it('distingue los archivos que no son un .pfx', () => {
    expect(codigoDe(() => leerPkcs12(Buffer.from('hola mundo'), 'x'))).toBe('FISCAL_CERT_FORMATO_INVALIDO');
    expect(codigoDe(() => leerPkcs12(Buffer.alloc(0), 'x'))).toBe('FISCAL_CERT_FORMATO_INVALIDO');

    const par = parRsa();
    const cert = certificado({ sujeto: sujetoEmpresa(), par });
    const pem = Buffer.from(forge.pki.certificateToPem(cert));
    expect(codigoDe(() => leerPkcs12(pem, 'x'))).toBe('FISCAL_CERT_SIN_CLAVE_PRIVADA');
    const der = Buffer.from(forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes(), 'binary');
    expect(codigoDe(() => leerPkcs12(der, 'x'))).toBe('FISCAL_CERT_SIN_CLAVE_PRIVADA');

    const soloCertificado = pfx(null, [cert], 'sinllave');
    expect(codigoDe(() => leerPkcs12(soloCertificado, 'sinllave'))).toBe('FISCAL_CERT_SIN_CLAVE_PRIVADA');

    const clavePem = Buffer.from(forge.pki.privateKeyToPem(par.privada));
    expect(codigoDe(() => normalizarContenidoPkcs12(clavePem))).toBe('FISCAL_CERT_FORMATO_INVALIDO');
  });

  it('el .pfx sin el certificado de su clave se rechaza (no se usa el de la CA)', () => {
    const { ca } = pfxConCadena('a');
    const otraLlave = parRsa().privada;
    const contenido = pfx(otraLlave, [ca], 'a');
    expect(codigoDe(() => leerPkcs12(contenido, 'a'))).toBe('FISCAL_CERT_FORMATO_INVALIDO');
  });

  it('genera el autofirmado de BETA: RSA 2048, OU = RUC, C = PE, 3DES y la vigencia pedida', async () => {
    const ahora = new Date('2026-10-13T15:00:00Z');
    const contenido = await generarAutofirmado({ ruc: RUC_PRUEBA, razonSocial: 'HATUNSALES S.A.C.', clave: 'beta1234', dias: 30, ahora });
    const leido = leerPkcs12(contenido, 'beta1234');
    expect(leido.info).toMatchObject({ ruc: RUC_PRUEBA, autofirmado: true, bitsClave: 2048, permiteFirma: true });
    expect(leido.info.vigenteHasta.getTime() - ahora.getTime()).toBe(30 * DIAS);
  });

  it('exporta la parte pública en DER (.cer) y en Base64 (.cer)', () => {
    const leido = leerPkcs12(pfxAutofirmado({ clave: 'abcdefgh' }), 'abcdefgh');
    const der = certificadoPublico(leido.certificatePem, 'cer');
    expect(der.extension).toBe('cer');
    expect(der.mime).toBe('application/pkix-cert');
    expect(new X509Certificate(der.contenido).fingerprint256.replace(/:/g, '').toLowerCase()).toBe(leido.info.huellaSha256);

    const pem = certificadoPublico(leido.certificatePem, 'pem');
    expect(pem.contenido.toString('utf8')).toMatch(/^-----BEGIN CERTIFICATE-----/);
    expect(createPublicKey(pem.contenido.toString('utf8')).asymmetricKeyType).toBe('rsa');
  });
});

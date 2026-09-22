import * as forge from 'node-forge';
import { CertificadoDigitalService, FirmadorXmlCertificado } from './firma-certificado.provider';

/** Genera un certificado autofirmado + .p12 en memoria, solo para esta prueba (no se usa contra SUNAT real). */
function generarP12DePrueba(password: string): Buffer {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
  const attrs = [{ name: 'commonName', value: 'HATUNSALES SAC (prueba)' }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(keys.privateKey, forge.md.sha256.create());

  const p12Asn1 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], password);
  const der = forge.asn1.toDer(p12Asn1).getBytes();
  return Buffer.from(der, 'binary');
}

describe('CertificadoDigitalService + FirmadorXmlCertificado', () => {
  it('carga un .p12 y firma un XML UBL con firma XML-DSig verificable', () => {
    const password = 'clave-prueba';
    const p12 = generarP12DePrueba(password);
    const certificado = new CertificadoDigitalService().cargarDesdeBuffer(p12, password);

    expect(certificado.privateKeyPem).toContain('PRIVATE KEY');
    expect(certificado.certificatePem).toContain('CERTIFICATE');

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2" xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2" xmlns:ds="http://www.w3.org/2000/09/xmldsig#">
  <ext:UBLExtensions>
    <ext:UBLExtension>
      <ext:ExtensionContent/>
    </ext:UBLExtension>
  </ext:UBLExtensions>
  <cbc:ID xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">F001-1</cbc:ID>
</Invoice>`;

    const firmador = new FirmadorXmlCertificado(certificado);
    const resultado = firmador.firmar(xml);

    expect(resultado.xmlFirmado).toContain('<ds:Signature');
    expect(resultado.digest.length).toBeGreaterThan(10);
    expect(resultado.signatureValue.length).toBeGreaterThan(10);

    // La firma debe ser criptograficamente valida, no solo tener la forma correcta.
    expect(firmador.verificar(resultado.xmlFirmado)).toBe(true);
  });

  it('rechaza una clave incorrecta al abrir el .p12', () => {
    const p12 = generarP12DePrueba('clave-correcta');

    expect(() => new CertificadoDigitalService().cargarDesdeBuffer(p12, 'clave-incorrecta')).toThrow();
  });
});

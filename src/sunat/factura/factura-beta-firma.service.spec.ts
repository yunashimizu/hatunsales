import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import * as forge from 'node-forge';
import { FacturaBetaFirmaService } from './factura-beta-firma.service';
import { FirmadorXmlCertificado, CertificadoDigitalService } from '../fiscal/firma-certificado.provider';

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
  return Buffer.from(forge.asn1.toDer(p12Asn1).getBytes(), 'binary');
}

describe('FacturaBetaFirmaService', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('modo DEMO (sin certificado configurado): firma un XML y agrega la estructura de firma del documento', async () => {
    delete process.env.SUNAT_CERT_PATH;
    delete process.env.SUNAT_CERT_PASSWORD;

    const service = new FacturaBetaFirmaService();
    const xml = `<?xml version="1.0" encoding="UTF-8"?><Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"></Invoice>`;

    const result = await service.firmar(xml);

    expect(result.ok).toBe(true);
    expect(result.xmlFirmado).toContain('<ds:Signature>');
    expect(result.xmlFirmado).toContain('<ds:SignatureValue>');
    expect(result.xmlFirmado).toContain('signature-');
    expect(result.digest.length).toBeGreaterThan(10);
  });

  it('modo DEMO: llena el slot de firma del builder sin duplicar ext:UBLExtensions', async () => {
    delete process.env.SUNAT_CERT_PATH;
    delete process.env.SUNAT_CERT_PASSWORD;

    const service = new FacturaBetaFirmaService();
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2" xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2">
  <ext:UBLExtensions>
    <ext:UBLExtension>
      <ext:ExtensionContent/>
    </ext:UBLExtension>
  </ext:UBLExtensions>
</Invoice>`;

    const result = await service.firmar(xml);

    expect(result.xmlFirmado.match(/<ext:UBLExtensions>/g)?.length).toBe(1);
  });

  it('con SUNAT_CERT_PATH/SUNAT_CERT_PASSWORD configurados, firma con el certificado real (XML-DSig verificable)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sunat-cert-'));
    const p12Path = join(dir, 'certificado.p12');
    const password = 'clave-prueba';
    writeFileSync(p12Path, generarP12DePrueba(password));

    process.env.SUNAT_CERT_PATH = p12Path;
    process.env.SUNAT_CERT_PASSWORD = password;

    try {
      const service = new FacturaBetaFirmaService();
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2" xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2" xmlns:ds="http://www.w3.org/2000/09/xmldsig#">
  <ext:UBLExtensions>
    <ext:UBLExtension>
      <ext:ExtensionContent/>
    </ext:UBLExtension>
  </ext:UBLExtensions>
</Invoice>`;

      const result = await service.firmar(xml);

      expect(result.ok).toBe(true);
      expect(result.mensaje).toContain('certificado digital real');

      const certificado = new CertificadoDigitalService().cargarDesdeArchivo(p12Path, password);
      const firmador = new FirmadorXmlCertificado(certificado);
      expect(firmador.verificar(result.xmlFirmado)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

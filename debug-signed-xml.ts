import { writeFileSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import * as forge from 'node-forge';

function generarP12(password: string): Buffer {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
  const attrs = [{ name: 'commonName', value: '20123456789' }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  const p12Asn1 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], password);
  return Buffer.from(forge.asn1.toDer(p12Asn1).getBytes(), 'binary');
}

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'sunat-debug-cert-'));
  const certPath = join(dir, 'certificado.p12');
  const certPassword = 'prueba-beta-2026';
  writeFileSync(certPath, generarP12(certPassword));

  const { FacturaBetaService } = await import('./src/sunat/factura/factura-beta.service');
  const { FacturaBetaFirmaService } = await import('./src/sunat/factura/factura-beta-firma.service');

  const dto = {
    rucEmisor: '20123456789',
    razonSocialEmisor: 'HATUNSALES SAC',
    direccionEmisor: 'Av. Central 123',
    ubigeoEmisor: '150101',
    rucCliente: '20100000001',
    razonSocialCliente: 'CLIENTE DEMO SAC',
    serie: 'F001',
    numero: 1,
    fechaEmision: '2026-09-22',
    horaEmision: '10:00:00',
    moneda: 'PEN' as const,
    tipoOperacion: '0101' as const,
    items: [{ descripcion: 'Caja de tornillos', cantidad: 2, unidadMedida: 'NIU', precioUnitario: 10, descuento: 0, afectacionIgv: 'gravado' as const }],
  };

  const prepared = await new FacturaBetaService().emitirFacturaBeta(dto);
  console.log('=== XML SIN FIRMAR (fragmento ProfileID) ===');
  console.log(prepared.xml.match(/<cbc:ProfileID[\s\S]{0,60}/)?.[0]);

  process.env.SUNAT_CERT_PATH = certPath;
  process.env.SUNAT_CERT_PASSWORD = certPassword;
  const firmado = await new FacturaBetaFirmaService().firmar(prepared.xml);

  writeFileSync('/tmp/xml-firmado-debug.xml', firmado.xmlFirmado);
  console.log('\n=== XML FIRMADO (fragmento ProfileID) ===');
  console.log(firmado.xmlFirmado.match(/<cbc:ProfileID[\s\S]{0,60}/)?.[0]);
  console.log('\n=== Primeros 800 caracteres del XML firmado ===');
  console.log(firmado.xmlFirmado.slice(0, 800));
  console.log('\nGuardado completo en /tmp/xml-firmado-debug.xml');
}

main().catch((e) => { console.error(e); process.exit(1); });

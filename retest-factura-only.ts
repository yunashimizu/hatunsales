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
  const dir = mkdtempSync(join(tmpdir(), 'sunat-cert-'));
  const certPath = join(dir, 'certificado.p12');
  const certPassword = 'prueba-beta-2026';
  writeFileSync(certPath, generarP12(certPassword));

  process.env.SUNAT_DIRECT_ENABLED = 'true';
  process.env.SUNAT_FISCAL_PROVIDER = 'sunat-direct';
  process.env.SUNAT_FISCAL_ENVIRONMENT = 'beta';
  process.env.SUNAT_CERT_PATH = certPath;
  process.env.SUNAT_CERT_PASSWORD = certPassword;

  const { SunatDirectFiscalProvider } = await import('./src/sunat/fiscal/sunat-direct-fiscal.provider');
  const proveedor = new SunatDirectFiscalProvider();

  console.log('=== FACTURA (01) — retest tras arreglar InvoiceTypeCode/listID ===');
  const resultado = await proveedor.preparar({
    documentType: '01',
    series: 'F001',
    number: 2,
    issueDate: '2026-09-22',
    issueTime: '11:00:00',
    currency: 'PEN',
    supplier: { ruc: '20123456789', razonSocial: 'HATUNSALES SAC', direccion: 'Av. Central 123', ubigeo: '150101' },
    customer: { tipoDocumento: '6', numeroDocumento: '20100000001', denominacion: 'CLIENTE DEMO SAC' },
    lines: [{ descripcion: 'Caja de tornillos', cantidad: 2, unidad: 'NIU', precioUnitario: 10, descuento: 0, afectacionIgv: '10' }],
    taxes: { igv: 3.6, total: 23.6 },
    totals: { gravada: 20, exonerada: 0, inafecta: 0, descuento: 0, igv: 3.6, total: 23.6 },
  });
  console.log(JSON.stringify(resultado, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });

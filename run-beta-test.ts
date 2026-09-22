/**
 * Prueba REAL contra los servidores BETA de SUNAT (e-beta.sunat.gob.pe),
 * sin base de datos (fiscalEnvioRepository = undefined, igual que el
 * segundo test de sunat-direct-fiscal.provider.spec.ts). Genera un
 * certificado autofirmado de una sola vez para firmar de verdad (SUNAT Beta
 * no exige que el certificado esté registrado).
 */
import { writeFileSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import * as forge from 'node-forge';

const REPO = '/home/datayros/remote/hantusales_back/hatunsales';

function generarP12(password: string): Buffer {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
  const attrs = [
    { name: 'commonName', value: '20123456789' },
    { name: 'organizationName', value: 'HATUNSALES SAC (prueba beta)' },
    { name: 'countryName', value: 'PE' },
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  const p12Asn1 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], password);
  return Buffer.from(forge.asn1.toDer(p12Asn1).getBytes(), 'binary');
}

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'sunat-beta-cert-'));
  const certPath = join(dir, 'certificado.p12');
  const certPassword = 'prueba-beta-2026';
  writeFileSync(certPath, generarP12(certPassword));

  process.env.SUNAT_DIRECT_ENABLED = 'true';
  process.env.SUNAT_FISCAL_PROVIDER = 'sunat-direct';
  process.env.SUNAT_FISCAL_ENVIRONMENT = 'beta';
  process.env.SUNAT_CERT_PATH = certPath;
  process.env.SUNAT_CERT_PASSWORD = certPassword;

  const { SunatDirectFiscalProvider } = await import(join(REPO, 'src/sunat/fiscal/sunat-direct-fiscal.provider'));
  const { SunatDirectGreProvider } = await import(join(REPO, 'src/sunat/fiscal/sunat-direct-gre.provider'));
  const { CATALOGO_09_MOTIVO_NOTA_CREDITO, CATALOGO_20_MOTIVO_TRASLADO, CATALOGO_21_MODALIDAD_TRASLADO } = await import(join(REPO, 'src/sunat/catalogos/sunat.catalogos'));

  const RUC = '20123456789';
  const proveedor = new SunatDirectFiscalProvider();
  const proveedorGre = new SunatDirectGreProvider();

  const resultados: Record<string, any> = {};

  console.log('=== 1) FACTURA (01) ===');
  resultados.factura = await proveedor.preparar({
    documentType: '01',
    series: 'F001',
    number: 1,
    issueDate: '2026-09-22',
    issueTime: '10:00:00',
    currency: 'PEN',
    supplier: { ruc: RUC, razonSocial: 'HATUNSALES SAC', direccion: 'Av. Central 123', ubigeo: '150101' },
    customer: { tipoDocumento: '6', numeroDocumento: '20100000001', denominacion: 'CLIENTE DEMO SAC' },
    lines: [{ descripcion: 'Caja de tornillos', cantidad: 2, unidad: 'NIU', precioUnitario: 10, descuento: 0, afectacionIgv: '10' }],
    taxes: { igv: 3.6, total: 23.6 },
    totals: { gravada: 20, exonerada: 0, inafecta: 0, descuento: 0, igv: 3.6, total: 23.6 },
  });
  console.log(JSON.stringify(resultados.factura, null, 2));

  console.log('\n=== 2) BOLETA (03) ===');
  resultados.boleta = await proveedor.preparar({
    documentType: '03',
    series: 'B001',
    number: 1,
    issueDate: '2026-09-22',
    issueTime: '10:05:00',
    currency: 'PEN',
    supplier: { ruc: RUC, razonSocial: 'HATUNSALES SAC', direccion: 'Av. Central 123', ubigeo: '150101' },
    customer: { tipoDocumento: '1', numeroDocumento: '71739060', denominacion: 'CLIENTE NATURAL' },
    lines: [{ descripcion: 'Caja de tornillos', cantidad: 2, unidad: 'NIU', precioUnitario: 10, descuento: 0, afectacionIgv: '10' }],
    taxes: { igv: 3.6, total: 23.6 },
    totals: { gravada: 20, exonerada: 0, inafecta: 0, descuento: 0, igv: 3.6, total: 23.6 },
  });
  console.log(JSON.stringify(resultados.boleta, null, 2));

  console.log('\n=== 3) NOTA DE CREDITO (07) ===');
  resultados.notaCredito = await proveedor.preparar({
    documentType: '07',
    series: 'FC01',
    number: 1,
    issueDate: '2026-09-22',
    issueTime: '10:10:00',
    currency: 'PEN',
    supplier: { ruc: RUC, razonSocial: 'HATUNSALES SAC', direccion: 'Av. Central 123', ubigeo: '150101' },
    customer: { tipoDocumento: '6', numeroDocumento: '20100000001', denominacion: 'CLIENTE DEMO SAC' },
    lines: [{ descripcion: 'Caja de tornillos', cantidad: 2, unidad: 'NIU', precioUnitario: 10, descuento: 0, afectacionIgv: '10' }],
    taxes: { igv: 3.6, total: 23.6 },
    totals: { gravada: 20, exonerada: 0, inafecta: 0, descuento: 0, igv: 3.6, total: 23.6 },
    notaCredito: {
      documentoModificado: { tipoDocumento: '01', series: 'F001', number: 1 },
      motivo: CATALOGO_09_MOTIVO_NOTA_CREDITO.DEVOLUCION_TOTAL,
      sustento: 'Prueba BETA de devolucion total',
    },
  });
  console.log(JSON.stringify(resultados.notaCredito, null, 2));

  console.log('\n=== 4) GUIA DE REMISION (09) ===');
  resultados.guia = await proveedorGre.emitir({
    documentType: '09',
    series: 'T001',
    number: 1,
    issueDate: '2026-09-22',
    issueTime: '10:15:00',
    supplier: { ruc: RUC, razonSocial: 'HATUNSALES SAC' },
    customer: { tipoDocumento: '6', numeroDocumento: '20100000001', denominacion: 'CLIENTE DEMO SAC' },
    lines: [{ descripcion: 'Caja de tornillos', cantidad: 2, unidad: 'NIU' }],
    totals: { gravada: 0, exonerada: 0, inafecta: 0, descuento: 0, igv: 0, total: 0 },
    motivoTraslado: CATALOGO_20_MOTIVO_TRASLADO.VENTA,
    modalidadTraslado: CATALOGO_21_MODALIDAD_TRASLADO.TRANSPORTE_PRIVADO,
    vehiculoPlaca: 'ABC-123',
    pesoBrutoTotalKg: 20,
    origenUbigeo: '150101',
    origenDireccion: 'Av. Central 123',
    destinoUbigeo: '150102',
    destinoDireccion: 'Jr. Destino 456',
    fechaInicioTraslado: '2026-09-22',
  });
  console.log(JSON.stringify(resultados.guia, null, 2));

  writeFileSync(join(__dirname, 'resultados.json'), JSON.stringify(resultados, null, 2));
  console.log('\n\n=== Resultados guardados en resultados.json ===');
}

main().catch((error) => {
  console.error('ERROR FATAL:', error);
  process.exit(1);
});

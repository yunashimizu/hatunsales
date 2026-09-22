import { SunatDirectFiscalProvider } from './sunat-direct-fiscal.provider';
import { FacturaBetaService } from '../factura/factura-beta.service';
import { FacturaBetaFirmaService } from '../factura/factura-beta-firma.service';
import { FacturaBetaZipService } from '../factura/factura-beta-zip.service';
import { SunatBillClient } from './sunat-bill.client';
import { CdrParserService } from '../cdr/cdr-parser.service';

describe('SunatDirectFiscalProvider', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.SUNAT_DIRECT_ENABLED = 'true';
    process.env.SUNAT_FISCAL_PROVIDER = 'sunat-direct';
    process.env.SUNAT_FISCAL_ENVIRONMENT = 'beta';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.restoreAllMocks();
  });

  it('orquesta XML, firma, ZIP, sendBill, CDR y persistencia en la ruta BETA', async () => {
    const repo = {
      registrar: jest.fn().mockResolvedValue({ id_envio: 42 }),
      actualizarEstado: jest.fn().mockResolvedValue({ id_envio: 42, estado: 'ENVIANDO' }),
      guardarArtefacto: jest.fn().mockResolvedValue({ id_artifact: 1 }),
    };

    jest.spyOn(FacturaBetaService.prototype, 'emitirFacturaBeta').mockResolvedValue({
      ok: true,
      estado: 'PENDIENTE',
      xml: '<Invoice>demo</Invoice>',
      mensaje: 'ok',
    });

    jest.spyOn(FacturaBetaFirmaService.prototype, 'firmar').mockResolvedValue({
      ok: true,
      xmlFirmado: '<Invoice>firmado</Invoice>',
      digest: 'abc',
      signatureValue: 'sig',
      mensaje: 'firmado',
    });

    jest.spyOn(FacturaBetaZipService.prototype, 'generarZip').mockReturnValue({
      ok: true,
      fileName: '20123456789-01-F001-00000001.zip',
      zipBase64: 'ZmFrZQ==',
      mensaje: 'zip',
    });

    jest.spyOn(SunatBillClient.prototype, 'sendBill').mockResolvedValue({
      ok: true,
      status: 'ACEPTADO',
      raw: '<soapenv:Envelope><soapenv:Body><applicationResponse>ZmFrZQ==</applicationResponse></soapenv:Body></soapenv:Envelope>',
      cdrXml: '<ApplicationResponse><ResponseCode>0</ResponseCode><Description>OK</Description></ApplicationResponse>',
      fault: null,
      message: 'ok',
    });

    jest.spyOn(CdrParserService.prototype, 'parse').mockReturnValue({
      codigo: '0',
      descripcion: 'OK',
      observaciones: [],
      estado: 'ACEPTADO',
      rawXml: '<ApplicationResponse><ResponseCode>0</ResponseCode><Description>OK</Description></ApplicationResponse>',
    });

    const provider = new SunatDirectFiscalProvider(repo as any);

    const result = await provider.preparar({
      documentType: '01',
      series: 'F001',
      number: 1,
      issueDate: '2026-09-21',
      issueTime: '12:00:00',
      currency: 'PEN',
      supplier: {
        ruc: '20123456789',
        razonSocial: 'Empresa Demo',
        direccion: 'Av. Demo 123',
        ubigeo: '150101',
      },
      customer: {
        tipoDocumento: '6',
        numeroDocumento: '20123456789',
        denominacion: 'Cliente Demo',
      },
      lines: [{
        descripcion: 'Producto demo',
        cantidad: 1,
        unidad: 'NIU',
        precioUnitario: 10,
        descuento: 0,
        afectacionIgv: '10',
      }],
      taxes: { igv: 1.8, total: 10 },
      totals: { gravada: 10, exonerada: 0, inafecta: 0, descuento: 0, igv: 1.8, total: 11.8 },
    });

    expect(result.ok).toBe(true);
    expect(result.estado).toBe('ACEPTADO');
    expect(repo.registrar).toHaveBeenCalled();
    expect(repo.guardarArtefacto).toHaveBeenCalled();
    expect(repo.actualizarEstado).toHaveBeenCalledWith(42, 'ENVIANDO', expect.any(Object));
  });
});

import { SunatDirectGreProvider } from './sunat-direct-gre.provider';
import { GuiaRemisionBetaService } from '../factura/guia-remision-beta.service';
import { FacturaBetaFirmaService } from '../factura/factura-beta-firma.service';
import { FacturaBetaZipService } from '../factura/factura-beta-zip.service';
import { SunatBillClient } from './sunat-bill.client';
import { CdrParserService } from '../cdr/cdr-parser.service';
import { CATALOGO_20_MOTIVO_TRASLADO, CATALOGO_21_MODALIDAD_TRASLADO } from '../catalogos/sunat.catalogos';

describe('SunatDirectGreProvider', () => {
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

  it('orquesta XML, firma, ZIP y sendBill para la GRE contra el endpoint propio de GRE', async () => {
    jest.spyOn(GuiaRemisionBetaService.prototype, 'emitirGuiaRemisionBeta').mockResolvedValue({
      ok: true,
      xml: '<DespatchAdvice>demo</DespatchAdvice>',
      mensaje: 'ok',
    });
    jest.spyOn(FacturaBetaFirmaService.prototype, 'firmar').mockResolvedValue({
      ok: true,
      xmlFirmado: '<DespatchAdvice>firmado</DespatchAdvice>',
      digest: 'abc',
      signatureValue: 'sig',
      mensaje: 'firmado',
    });
    jest.spyOn(FacturaBetaZipService.prototype, 'generarZip').mockReturnValue({
      ok: true,
      fileName: '20123456789-09-T001-00000001.zip',
      zipBase64: 'ZmFrZQ==',
      mensaje: 'zip',
    });

    let endpointUsado = '';
    jest.spyOn(SunatBillClient.prototype, 'sendBill').mockImplementation(async function (this: SunatBillClient) {
      endpointUsado = (this as any).config.endpoint;
      return {
        ok: true,
        status: 'ACEPTADO',
        raw: '<soap/>',
        cdrXml: '<ApplicationResponse><ResponseCode>0</ResponseCode><Description>OK</Description></ApplicationResponse>',
        fault: null,
        message: 'ok',
      };
    });
    jest.spyOn(CdrParserService.prototype, 'parse').mockReturnValue({
      codigo: '0',
      descripcion: 'OK',
      observaciones: [],
      estado: 'ACEPTADO',
      rawXml: '',
    });

    const provider = new SunatDirectGreProvider();
    const result = await provider.emitir({
      documentType: '09',
      series: 'T001',
      number: 1,
      issueDate: '2026-09-22',
      issueTime: '10:00:00',
      supplier: { ruc: '20123456789', razonSocial: 'Empresa Demo' },
      customer: { tipoDocumento: '6', numeroDocumento: '20100000001', denominacion: 'Cliente Demo' },
      lines: [{ descripcion: 'Caja', cantidad: 1, unidad: 'NIU', precioUnitario: 0 }],
      totals: { gravada: 0, exonerada: 0, inafecta: 0, descuento: 0, igv: 0, total: 0 },
      motivoTraslado: CATALOGO_20_MOTIVO_TRASLADO.VENTA,
      modalidadTraslado: CATALOGO_21_MODALIDAD_TRASLADO.TRANSPORTE_PRIVADO,
      vehiculoPlaca: 'ABC-123',
      pesoBrutoTotalKg: 10,
      origenUbigeo: '150101',
      destinoUbigeo: '150102',
    });

    expect(result.success).toBe(true);
    expect(result.estado).toBe('ACEPTADO');
    expect(endpointUsado).toContain('guia');
  });
});

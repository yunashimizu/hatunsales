import { ResumenDiarioEnvioService } from './resumen-diario-envio.service';
import { ResumenDiarioBetaService } from '../factura/resumen-diario-beta.service';
import { FacturaBetaFirmaService } from '../factura/factura-beta-firma.service';
import { SunatBillClient } from './sunat-bill.client';

describe('ResumenDiarioEnvioService', () => {
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

  const dto = {
    rucEmisor: '20123456789',
    razonSocialEmisor: 'HATUNSALES SAC',
    fechaGeneracion: '2026-09-22',
    fechaEmisionDocumentos: '2026-09-22',
    numeroCorrelativoResumen: 1,
    lineas: [{
      numeroLinea: 1,
      tipoDocumento: '03' as const,
      serie: 'B001',
      numero: 1,
      tipoDocumentoCliente: '1',
      numeroDocumentoCliente: '71739060',
      gravada: 100,
      exonerada: 0,
      inafecta: 0,
      gratuita: 0,
      igv: 18,
      total: 118,
      estado: 1 as const,
    }],
  };

  it('envía el resumen por sendSummary y devuelve el ticket', async () => {
    jest.spyOn(FacturaBetaFirmaService.prototype, 'firmar').mockResolvedValue({
      ok: true,
      xmlFirmado: '<SummaryDocuments>firmado</SummaryDocuments>',
      digest: 'abc',
      signatureValue: 'sig',
      mensaje: 'firmado',
    });
    jest.spyOn(SunatBillClient.prototype, 'sendSummary').mockResolvedValue({
      ok: true,
      raw: '<soap/>',
      ticket: '@1234567890123',
      fault: null,
      message: 'Resumen aceptado para procesamiento.',
    });

    const service = new ResumenDiarioEnvioService();
    const result = await service.enviar(dto);

    expect(result.ok).toBe(true);
    expect(result.ticket).toBe('@1234567890123');
    expect(result.identificador).toBe('RC-20260922-00001');
  });

  it('consultarTicket delega en SunatBillClient.getStatus', async () => {
    jest.spyOn(SunatBillClient.prototype, 'getStatus').mockResolvedValue({
      ok: true,
      finalizado: true,
      raw: '<soap/>',
      cdrXml: '<ApplicationResponse><ResponseCode>0</ResponseCode></ApplicationResponse>',
      statusCode: null,
      fault: null,
      message: 'CDR disponible.',
    });

    const service = new ResumenDiarioEnvioService();
    const result = await service.consultarTicket('@1234567890123', '20123456789');

    expect(result.finalizado).toBe(true);
    expect(result.aceptado).toBe(true);
  });
});

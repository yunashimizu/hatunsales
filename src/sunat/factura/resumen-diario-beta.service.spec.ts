import { EmitirResumenDiarioBetaDto, ResumenDiarioBetaService } from './resumen-diario-beta.service';

describe('ResumenDiarioBetaService', () => {
  const dtoBase: EmitirResumenDiarioBetaDto = {
    rucEmisor: '20123456789',
    razonSocialEmisor: 'HATUNSALES SAC',
    fechaGeneracion: '2026-09-22',
    fechaEmisionDocumentos: '2026-09-22',
    numeroCorrelativoResumen: 1,
    lineas: [
      {
        numeroLinea: 1,
        tipoDocumento: '03',
        serie: 'B001',
        numero: 15,
        tipoDocumentoCliente: '1',
        numeroDocumentoCliente: '71739060',
        gravada: 100,
        exonerada: 0,
        inafecta: 0,
        gratuita: 0,
        igv: 18,
        total: 118,
        estado: 1,
      },
    ],
  };

  it('genera el identificador RC-YYYYMMDD-##### y el XML SummaryDocuments UBL 2.0', async () => {
    const service = new ResumenDiarioBetaService();

    const result = await service.emitirResumenDiarioBeta(dtoBase);

    expect(result.ok).toBe(true);
    expect(result.identificador).toBe('RC-20260922-00001');
    expect(result.xml).toContain('<SummaryDocuments');
    expect(result.xml).toContain('<cbc:UBLVersionID>2.0</cbc:UBLVersionID>');
    expect(result.xml).toContain('<cbc:ID>RC-20260922-00001</cbc:ID>');
    expect(result.xml).toContain('<cbc:ID>B001-00000015</cbc:ID>');
    expect(result.xml).toContain('<cbc:DocumentTypeCode>03</cbc:DocumentTypeCode>');
  });

  it('rechaza el resumen si se envía más allá del 7mo día calendario', async () => {
    const service = new ResumenDiarioBetaService();

    await expect(service.emitirResumenDiarioBeta({
      ...dtoBase,
      fechaEmisionDocumentos: '2026-09-01',
      fechaGeneracion: '2026-09-22',
    })).rejects.toThrow('7 días calendario');
  });

  it('incluye la referencia al documento modificado cuando la línea es una Nota de Crédito', async () => {
    const service = new ResumenDiarioBetaService();

    const result = await service.emitirResumenDiarioBeta({
      ...dtoBase,
      lineas: [{
        ...dtoBase.lineas[0],
        tipoDocumento: '07',
        serie: 'BC01',
        documentoModificado: { tipoDocumento: '03', serie: 'B001', numero: 15 },
      }],
    });

    expect(result.xml).toContain('<cac:BillingReference>');
    expect(result.xml).toContain('<cbc:ID>B001-00000015</cbc:ID>');
  });
});

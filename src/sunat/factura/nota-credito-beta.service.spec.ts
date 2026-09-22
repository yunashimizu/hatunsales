import { CATALOGO_09_MOTIVO_NOTA_CREDITO } from '../catalogos/sunat.catalogos';
import { EmitirNotaCreditoBetaDto, NotaCreditoBetaService } from './nota-credito-beta.service';

describe('NotaCreditoBetaService', () => {
  const dtoBase: EmitirNotaCreditoBetaDto = {
    rucEmisor: '20123456789',
    razonSocialEmisor: 'HATUNSALES SAC',
    direccionEmisor: 'Av. Central 123',
    ubigeoEmisor: '150101',
    tipoDocumentoCliente: '6',
    numeroDocumentoCliente: '20100000001',
    razonSocialCliente: 'CLIENTE DEMO S.A.C.',
    serie: 'FC01',
    numero: 1,
    fechaEmision: '2026-09-22',
    horaEmision: '12:30:00',
    moneda: 'PEN',
    documentoModificado: { tipoDocumento: '01', serie: 'F001', numero: 5 },
    motivo: CATALOGO_09_MOTIVO_NOTA_CREDITO.DEVOLUCION_TOTAL,
    sustento: 'Devolución por producto defectuoso',
    items: [
      {
        descripcion: 'Caja de tornillos',
        cantidad: 2,
        unidadMedida: 'NIU',
        precioUnitario: 10,
        afectacionIgv: 'gravado',
        descuento: 0,
      },
    ],
  };

  it('genera XML UBL de Nota de Crédito con referencia al documento modificado', async () => {
    const service = new NotaCreditoBetaService();

    const result = await service.emitirNotaCreditoBeta(dtoBase);

    expect(result.ok).toBe(true);
    expect(result.xml).toContain('<CreditNote');
    expect(result.xml).toContain('<cbc:ID>FC01-00000001</cbc:ID>');
    expect(result.xml).toContain('<cac:InvoiceDocumentReference>');
    expect(result.xml).toContain('<cbc:ID>F001-00000005</cbc:ID>');
    expect(result.xml).toContain('<cbc:DocumentTypeCode>01</cbc:DocumentTypeCode>');
    expect(result.xml).toContain(`<cbc:ResponseCode>${CATALOGO_09_MOTIVO_NOTA_CREDITO.DEVOLUCION_TOTAL}</cbc:ResponseCode>`);
  });

  it('rechaza motivos exclusivos de Factura (descuento global) cuando el documento modificado es Boleta', async () => {
    const service = new NotaCreditoBetaService();

    await expect(service.emitirNotaCreditoBeta({
      ...dtoBase,
      serie: 'BC01',
      documentoModificado: { tipoDocumento: '03', serie: 'B001', numero: 5 },
      motivo: CATALOGO_09_MOTIVO_NOTA_CREDITO.DESCUENTO_GLOBAL,
    })).rejects.toThrow('no se puede usar sobre una Boleta');
  });

  it('exige que la serie comparta el prefijo del documento modificado', async () => {
    const service = new NotaCreditoBetaService();

    await expect(service.emitirNotaCreditoBeta({
      ...dtoBase,
      documentoModificado: { tipoDocumento: '03', serie: 'B001', numero: 5 },
      // serie sigue siendo FC01 (factura) aunque el documento modificado es boleta
    })).rejects.toThrow('debe empezar con "B"');
  });
});

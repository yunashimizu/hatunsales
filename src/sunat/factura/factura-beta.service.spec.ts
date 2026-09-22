import { FacturaBetaService, EmitirFacturaBetaDto } from './factura-beta.service';

describe('FacturaBetaService', () => {
  it('genera XML UBL 2.1 con datos fiscales y mapea afectación IGV', async () => {
    const service = new FacturaBetaService();

    const dto: EmitirFacturaBetaDto = {
      rucEmisor: '20123456789',
      razonSocialEmisor: 'HATUNSALES SAC',
      direccionEmisor: 'Av. Central 123',
      ubigeoEmisor: '150101',
      rucCliente: '20100000001',
      razonSocialCliente: 'CLIENTE DEMO S.A.C.',
      direccionCliente: 'Jr. Cliente 456',
      serie: 'F001',
      numero: 1,
      fechaEmision: '2026-09-21',
      horaEmision: '12:30:00',
      moneda: 'PEN',
      tipoOperacion: '0101',
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

    const result = await service.emitirFacturaBeta(dto);

    expect(result.ok).toBe(true);
    expect(result.estado).toBe('PENDIENTE');
    expect(result.xml).toContain('<cbc:UBLVersionID>2.1</cbc:UBLVersionID>');
    // El atributo listID (catalogo 51, "tipo de operacion") en InvoiceTypeCode
    // es obligatorio para SUNAT: sin él, un envío real a Beta se rechaza con
    // "Debe consignar el tipo de operación" (código 3205), confirmado contra
    // el servidor real de SUNAT — no es decorativo, es donde SUNAT lo lee.
    expect(result.xml).toContain('listID="0101"');
    expect(result.xml).toContain('>01</cbc:InvoiceTypeCode>');
    expect(result.xml).toContain('<cbc:ProfileID>0101</cbc:ProfileID>');
    expect(result.xml).toContain('<cbc:ID>F001-00000001</cbc:ID>');
    expect(result.xml).toContain('20123456789');
    expect(result.xml).toContain('20100000001');
    expect(result.xml).toContain('Caja de tornillos');
    expect(result.xml).toContain('<cbc:TaxExemptionReasonCode>10</cbc:TaxExemptionReasonCode>');
    // AlternativeConditionPrice debe llevar el precio CON impuestos (10 + 1.8 de IGV
    // por unidad = 11.80), no el mismo valor sin impuesto que cac:Price. Sin esto,
    // SUNAT rechaza con "el precio unitario... difiere de los cálculos" (código
    // 3270), confirmado contra el servidor real de SUNAT.
    expect(result.xml).toContain('<cbc:PriceAmount currencyID="PEN">11.80</cbc:PriceAmount>');
  });
});

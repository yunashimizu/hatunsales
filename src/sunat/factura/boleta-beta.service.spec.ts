import { BoletaBetaService, EmitirBoletaBetaDto } from './boleta-beta.service';

describe('BoletaBetaService', () => {
  const dtoBase: EmitirBoletaBetaDto = {
    rucEmisor: '20123456789',
    razonSocialEmisor: 'HATUNSALES SAC',
    direccionEmisor: 'Av. Central 123',
    ubigeoEmisor: '150101',
    tipoDocumentoCliente: '1',
    numeroDocumentoCliente: '71739060',
    denominacionCliente: 'CLIENTE DEMO',
    serie: 'B001',
    numero: 1,
    fechaEmision: '2026-09-22',
    horaEmision: '12:30:00',
    moneda: 'PEN',
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

  it('genera XML UBL 2.1 de Boleta con cliente DNI y direccion del emisor', async () => {
    const service = new BoletaBetaService();

    const result = await service.emitirBoletaBeta(dtoBase);

    expect(result.ok).toBe(true);
    expect(result.xml).toContain('listID="0101"');
    expect(result.xml).toContain('>03</cbc:InvoiceTypeCode>');
    expect(result.xml).toContain('<cbc:ID>B001-00000001</cbc:ID>');
    expect(result.xml).toContain('71739060');
    expect(result.xml).toContain('Av. Central 123');
    expect(result.xml).toContain('150101');
    expect(result.xml).toContain('<cac:PaymentTerms>');
    expect(result.xml).toContain('<cac:Signature>');
  });

  it('rechaza series que no empiecen con B', async () => {
    const service = new BoletaBetaService();

    await expect(service.emitirBoletaBeta({ ...dtoBase, serie: 'F001' })).rejects.toThrow('formato B###');
  });

  it('permite boleta sin documento de cliente (venta menor)', async () => {
    const service = new BoletaBetaService();

    const result = await service.emitirBoletaBeta({
      ...dtoBase,
      tipoDocumentoCliente: '0',
      numeroDocumentoCliente: '',
      denominacionCliente: 'Cliente varios',
    });

    expect(result.ok).toBe(true);
  });
});

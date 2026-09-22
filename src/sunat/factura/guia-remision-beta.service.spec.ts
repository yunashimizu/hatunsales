import { CATALOGO_20_MOTIVO_TRASLADO, CATALOGO_21_MODALIDAD_TRASLADO } from '../catalogos/sunat.catalogos';
import { EmitirGuiaRemisionBetaDto, GuiaRemisionBetaService } from './guia-remision-beta.service';

describe('GuiaRemisionBetaService', () => {
  const dtoBase: EmitirGuiaRemisionBetaDto = {
    rucEmisor: '20123456789',
    razonSocialEmisor: 'HATUNSALES SAC',
    destinatario: { tipoDocumento: '6', numeroDocumento: '20100000001', razonSocial: 'CLIENTE DEMO' },
    serie: 'T001',
    numero: 1,
    fechaEmision: '2026-09-22',
    motivoTraslado: CATALOGO_20_MOTIVO_TRASLADO.VENTA,
    modalidadTraslado: CATALOGO_21_MODALIDAD_TRASLADO.TRANSPORTE_PRIVADO,
    vehiculoPlaca: 'ABC-123',
    pesoBrutoTotalKg: 50,
    origenUbigeo: '150101',
    origenDireccion: 'Av. Central 123',
    destinoUbigeo: '150102',
    destinoDireccion: 'Jr. Destino 456',
    fechaInicioTraslado: '2026-09-22',
    items: [{ descripcion: 'Caja de tornillos', cantidad: 2, unidadMedida: 'NIU' }],
  };

  it('genera XML DespatchAdvice con motivo, modalidad y datos del vehículo', async () => {
    const service = new GuiaRemisionBetaService();

    const result = await service.emitirGuiaRemisionBeta(dtoBase);

    expect(result.ok).toBe(true);
    expect(result.xml).toContain('<DespatchAdvice');
    expect(result.xml).toContain('<cbc:ID>T001-00000001</cbc:ID>');
    expect(result.xml).toContain(`<cbc:HandlingCode>${CATALOGO_20_MOTIVO_TRASLADO.VENTA}</cbc:HandlingCode>`);
    expect(result.xml).toContain('ABC-123');
  });

  it('exige placa de vehículo en transporte privado', async () => {
    const service = new GuiaRemisionBetaService();

    await expect(service.emitirGuiaRemisionBeta({ ...dtoBase, vehiculoPlaca: undefined }))
      .rejects.toThrow('placa del vehículo');
  });

  it('exige datos del transportista en transporte público', async () => {
    const service = new GuiaRemisionBetaService();

    await expect(service.emitirGuiaRemisionBeta({
      ...dtoBase,
      modalidadTraslado: CATALOGO_21_MODALIDAD_TRASLADO.TRANSPORTE_PUBLICO,
      vehiculoPlaca: undefined,
    })).rejects.toThrow('transportista');
  });

  it('rechaza series que no empiecen con T', async () => {
    const service = new GuiaRemisionBetaService();

    await expect(service.emitirGuiaRemisionBeta({ ...dtoBase, serie: 'F001' })).rejects.toThrow('formato T###');
  });
});

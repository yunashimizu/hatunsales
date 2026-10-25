import { Logger } from '@nestjs/common';
import { ConfiguracionFiscalBussnies } from './configuracion-fiscal.bussnies';
import { CONTEXTO_BETA, CONTEXTO_PRODUCCION } from './comprobante.prueba-spec';

function crear() {
  const config = {
    obtenerVarias: jest.fn().mockResolvedValue({}),
    guardar: jest.fn().mockResolvedValue(undefined),
    limpiarCache: jest.fn(),
  };
  const fiscal = {
    series: jest.fn().mockResolvedValue({ factura: 'F001', boleta: 'B001' }),
    proveedorActivo: jest.fn().mockResolvedValue('nubefact'),
    ambiente: jest.fn().mockResolvedValue('beta'),
    listoParaProduccion: jest.fn().mockResolvedValue({ listo: false }),
    snapshotFresco: jest.fn(),
  };
  const emision = {
    modo: jest.fn().mockResolvedValue({ activo: true, ambiente: 'beta' }),
    contexto: jest.fn().mockResolvedValue(CONTEXTO_BETA),
  };
  const notificador = { notificar: jest.fn() };
  const servicio = new ConfiguracionFiscalBussnies(config as never, fiscal as never, notificador as never, emision as never);
  return { servicio, config, fiscal, emision };
}

describe('ConfiguracionFiscalBussnies.seriesPos (series según el contexto de emisión)', () => {
  beforeAll(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  it('BETA activo: series y aviso del contexto de pruebas', async () => {
    const { servicio } = crear();

    const series = await servicio.seriesPos();

    expect(series).toMatchObject({
      serie_factura: 'FB01',
      serie_boleta: 'BB01',
      por_tipo: { 1: 'FB01', 2: 'BB01' },
      editable_en_pos: false,
      fuente: 'fiscal',
      ambiente: 'beta',
      emision_activa: true,
      beta_pos_directo: true,
      aviso: CONTEXTO_BETA.aviso,
    });
    expect(series.mensaje).toContain('FB01');
    expect(series.codigo).toBeUndefined();
  });

  it('PRODUCCIÓN activa: series configuradas del contexto, sin aviso de pruebas', async () => {
    const { servicio, emision } = crear();
    emision.modo.mockResolvedValue({ activo: true, ambiente: 'produccion' });
    emision.contexto.mockResolvedValue(CONTEXTO_PRODUCCION);

    const series = await servicio.seriesPos();

    expect(series).toMatchObject({ serie_factura: 'F001', serie_boleta: 'B001', ambiente: 'produccion', beta_pos_directo: false, aviso: null });
    expect(series.mensaje).toContain('producción');
  });

  it('inactiva: no falla, explica el motivo y muestra las series fiscales configuradas', async () => {
    const { servicio, emision, fiscal } = crear();
    emision.modo.mockResolvedValue({ activo: false, ambiente: 'produccion', codigo: 'FISCAL_EMISION_INACTIVA', motivo: 'el proveedor no es sunat_directo' });
    emision.contexto.mockRejectedValue(new Error('no listo'));

    const series = await servicio.seriesPos();

    expect(fiscal.series).toHaveBeenCalled();
    expect(series).toMatchObject({
      serie_factura: 'F001',
      serie_boleta: 'B001',
      fuente: 'fiscal',
      emision_activa: false,
      beta_pos_directo: false,
      codigo: 'FISCAL_EMISION_INACTIVA',
    });
    expect(series.mensaje).toContain('el proveedor no es sunat_directo');
    expect(series.mensaje).toContain('se puede emitir después desde Ventas');
  });

  it('si ni la configuración fiscal se puede leer, muestra las series de fábrica en vez de fallar', async () => {
    const { servicio, emision, fiscal } = crear();
    emision.modo.mockResolvedValue({ activo: false, ambiente: 'beta', codigo: 'FISCAL_LECTURA_ERROR', motivo: 'BD caída' });
    emision.contexto.mockRejectedValue(new Error('BD caída'));
    fiscal.series.mockRejectedValue(new Error('BD caída'));

    await expect(servicio.seriesPos()).resolves.toMatchObject({ serie_factura: 'F001', serie_boleta: 'B001' });
  });

  it('guardarAdmin ignora las series del panel anterior (se configuran en Facturación SUNAT)', async () => {
    const { servicio, config } = crear();

    const resultado = await servicio.guardarAdmin({ series: { serie_boleta: 'BBB1', serie_factura: 'FFF1' } });

    expect(config.guardar).not.toHaveBeenCalled();
    expect(resultado.series).toMatchObject({ serie_boleta: 'BB01', serie_factura: 'FB01', editable: false, fuente: 'fiscal' });
  });
});

import { ComprobanteRepository } from '../../repository/Repository/comprobante.repository';
import { ConfiguracionRepository } from '../../repository/Repository/configuracion.repository';
import { Comprobante } from '../../models/DBModel/c-electronico/comprobante.entity';
import type {
  AnularComprobanteRequest,
  ConsultarComprobanteRequest,
  GenerarComprobanteRequest,
} from '../../models/model/c-electronico/comprobante.request';
import { PosBetaService } from '../../sunat/emision/pos-beta.service';
import { ComprobanteBussnies } from './comprobante.bussnies';
import { ReceptorBussnies } from './receptor.bussnies';

describe('ComprobanteBussnies: solo SUNAT directo BETA', () => {
  const repo = {
    buscarPorId: jest.fn(),
    reservarCorrelativo: jest.fn(),
    actualizarRespuesta: jest.fn(),
  };
  const posBeta = { activoEnBeta: jest.fn() };
  let servicio: ComprobanteBussnies;

  beforeEach(() => {
    jest.clearAllMocks();
    servicio = new ComprobanteBussnies(
      repo as unknown as ComprobanteRepository,
      {} as ReceptorBussnies,
      {} as ConfiguracionRepository,
      posBeta as unknown as PosBetaService,
    );
  });

  it('bloquea la emisión si POS BETA no está activa, sin reservar ni usar un proveedor alternativo', async () => {
    posBeta.activoEnBeta.mockResolvedValue(false);

    await expect(servicio.generar({} as GenerarComprobanteRequest)).rejects.toMatchObject({
      status: 503,
      message: expect.stringContaining('no se enviará a ningún proveedor alternativo'),
    });

    expect(repo.reservarCorrelativo).not.toHaveBeenCalled();
  });

  it('no reintenta comprobantes históricos por otro proveedor', async () => {
    repo.buscarPorId.mockResolvedValue({
      id_comprobante: 52,
      proveedor_fiscal: 'nubefact',
      ambiente_fiscal: 'beta',
      estado: 'pendiente',
      serie: 'B001',
      numero: 1,
    } as Comprobante);

    await expect(servicio.reintentar(52)).rejects.toThrow(
      'no pertenece a un envío SUNAT BETA recuperable',
    );
    expect(posBeta.activoEnBeta).not.toHaveBeenCalled();
  });

  it('rechaza consulta, anulación y consulta de anulación sin acceder a servicios externos', async () => {
    await expect(
      servicio.consultar({} as ConsultarComprobanteRequest),
    ).rejects.toThrow('consulta remota de comprobantes aún no está habilitada');
    await expect(
      servicio.anular({} as AnularComprobanteRequest),
    ).rejects.toThrow('anulación electrónica directa todavía no está implementada');
    await expect(
      servicio.consultarAnulacion({} as ConsultarComprobanteRequest),
    ).rejects.toThrow('consulta de anulaciones aún no está habilitada');
    expect(repo.buscarPorId).not.toHaveBeenCalled();
  });

  it('no descarga PDF desde enlaces de comprobantes históricos', async () => {
    repo.buscarPorId.mockResolvedValue({
      id_comprobante: 53,
      proveedor_fiscal: 'nubefact',
      enlace_pdf: 'https://example.invalid/historico.pdf',
    } as Comprobante);

    await expect(servicio.obtenerPdfBuffer(53)).rejects.toThrow(
      'La descarga remota de PDF no está habilitada',
    );
  });
});

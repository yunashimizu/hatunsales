import { ConflictException } from '@nestjs/common';
import * as config from '../config/fiscal-config';
import { FacturaBetaAdminController } from './factura-beta-admin.controller';

describe('FacturaBetaAdminController: rutas heredadas solo BETA', () => {
  afterEach(() => jest.restoreAllMocks());

  it.each(['documento', 'guia', 'resumen', 'ticket'])('bloquea %s antes de cualquier envío cuando el entorno es producción', async (operacion) => {
    jest.spyOn(config, 'getFiscalConfig').mockReturnValue({ ambiente: 'produccion' } as any);
    const proveedor = { preparar: jest.fn() };
    const controlador = new FacturaBetaAdminController(proveedor as any, {} as any);
    const llamada = operacion === 'documento' ? controlador.emitirDocumento({} as any)
      : operacion === 'guia' ? controlador.emitirGuiaRemision({} as any)
      : operacion === 'resumen' ? controlador.enviarResumenDiario({} as any)
      : controlador.consultarResumenDiario('ticket');
    await expect(llamada).rejects.toBeInstanceOf(ConflictException);
    expect(proveedor.preparar).not.toHaveBeenCalled();
  });
});

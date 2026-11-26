import { ROLES_KEY } from '../../guards/roles.decorator';
import { JwtGuard } from '../../guards/jwt.guard';
import { RolesGuard } from '../../guards/roles.guard';
import { ProductoImagenMejoraController } from './producto-imagen-mejora.controller';

describe('ProductoImagenMejoraController', () => {
  const servicio = {
    resumen: jest.fn().mockResolvedValue({ disponible: true, activa: true, version: 1, mejoras: [] }),
    usarOriginal: jest.fn().mockResolvedValue({ imagenes: [], mejoras: [] }),
    usarMejorada: jest.fn().mockResolvedValue({ imagenes: [], mejoras: [] }),
  };
  const controlador = new ProductoImagenMejoraController(servicio as any);

  it('delega en el servicio con los ids numéricos', async () => {
    await controlador.resumen(3);
    await controlador.usarOriginal(3, 5);
    await controlador.aplicar(3, 6);
    expect(servicio.resumen).toHaveBeenCalledWith(3);
    expect(servicio.usarOriginal).toHaveBeenCalledWith(3, 5);
    expect(servicio.usarMejorada).toHaveBeenCalledWith(3, 6);
  });

  it('exige sesión y los mismos roles que suben fotos (admin y vendedor)', () => {
    expect(Reflect.getMetadata(ROLES_KEY, ProductoImagenMejoraController)).toEqual(['admin', 'vendedor']);
    expect(Reflect.getMetadata('__guards__', ProductoImagenMejoraController)).toEqual([JwtGuard, RolesGuard]);
  });

  it('rutas: GET :id/images/mejoras, POST :id/images/:imgId/mejora/original y …/aplicar', () => {
    const ruta = (metodo: keyof ProductoImagenMejoraController) => Reflect.getMetadata('path', ProductoImagenMejoraController.prototype[metodo]);
    expect(Reflect.getMetadata('path', ProductoImagenMejoraController)).toBe('producto');
    expect(ruta('resumen')).toBe(':id/images/mejoras');
    expect(ruta('usarOriginal')).toBe(':id/images/:imgId/mejora/original');
    expect(ruta('aplicar')).toBe(':id/images/:imgId/mejora/aplicar');
  });
});

import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { JwtGuard } from '../../guards/jwt.guard';
import { ROLES_KEY } from '../../guards/roles.decorator';
import { RolesGuard } from '../../guards/roles.guard';
import { ConfigurarFotosRequest, MejorarFotosRequest, RevisarFotosRequest } from '../../models/model/fotos-mejora.request';
import { FotosMejoraController } from './fotos-mejora.controller';

describe('FotosMejoraController', () => {
  const fotos = {
    estado: jest.fn(), iniciarRevision: jest.fn(), verRevision: jest.fn(), iniciarMejora: jest.fn(), deshacer: jest.fn(), detener: jest.fn(),
  };
  const mejora = { fijarInterruptor: jest.fn() };
  const controlador = new FotosMejoraController(fotos as any, mejora as any);

  it('delega en los servicios', () => {
    controlador.estado();
    controlador.revisar({ limite: 50 });
    controlador.verRevision();
    controlador.mejorar({ limite: 200, id_producto: 3 });
    controlador.deshacer({});
    controlador.configurar({ activa: false });
    controlador.detener();
    expect(fotos.iniciarRevision).toHaveBeenCalledWith(50);
    expect(fotos.iniciarMejora).toHaveBeenCalledWith(200, 3);
    expect(fotos.deshacer).toHaveBeenCalledWith(undefined);
    expect(mejora.fijarInterruptor).toHaveBeenCalledWith(false);
    expect(fotos.detener).toHaveBeenCalled();
    expect(fotos.estado).toHaveBeenCalled();
    expect(fotos.verRevision).toHaveBeenCalled();
  });

  it('todo exige sesión y rol admin', () => {
    expect(Reflect.getMetadata(ROLES_KEY, FotosMejoraController)).toEqual(['admin']);
    expect(Reflect.getMetadata('__guards__', FotosMejoraController)).toEqual([JwtGuard, RolesGuard]);
    for (const metodo of Object.getOwnPropertyNames(FotosMejoraController.prototype).filter((m) => m !== 'constructor')) {
      expect(Reflect.getMetadata(ROLES_KEY, (FotosMejoraController.prototype as any)[metodo])).toBeUndefined();
    }
  });

  it('rutas y códigos: revisar y mejorar responden 202', () => {
    const de = (clave: string, metodo: keyof FotosMejoraController) => Reflect.getMetadata(clave, FotosMejoraController.prototype[metodo]);
    expect(Reflect.getMetadata('path', FotosMejoraController)).toBe('fotos-mejora');
    expect(['estado', 'revisar', 'verRevision', 'mejorar', 'deshacer', 'configurar', 'detener'].map((x) => de('path', x as any)))
      .toEqual(['estado', 'diagnostico', 'diagnostico', 'reprocesar', 'deshacer', 'config', 'detener']);
    expect(de('__httpCode__', 'revisar')).toBe(202);
    expect(de('__httpCode__', 'mejorar')).toBe(202);
  });

  it('topes de los pedidos', () => {
    const errores = (clase: any, cuerpo: object) => validateSync(plainToInstance(clase, cuerpo) as object).map((e) => e.property);
    expect(errores(RevisarFotosRequest, {})).toEqual([]);
    expect(errores(RevisarFotosRequest, { limite: 501 })).toEqual(['limite']);
    expect(errores(MejorarFotosRequest, { limite: 2000, id_producto: 1 })).toEqual([]);
    expect(errores(MejorarFotosRequest, { limite: 2001, id_producto: 0 }).sort()).toEqual(['id_producto', 'limite']);
    expect(errores(ConfigurarFotosRequest, { activa: 'false' })).toEqual(['activa']);
    expect(errores(ConfigurarFotosRequest, {})).toEqual(['activa']);
  });
});

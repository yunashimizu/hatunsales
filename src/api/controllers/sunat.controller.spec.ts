import { ForbiddenException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { JwtGuard } from '../../guards/jwt.guard';
import { RolesGuard } from '../../guards/roles.guard';
import { SunatController } from './sunat.controller';

/**
 * GET /sunat/dni/:dni y /sunat/ruc/:ruc gastan la cuota de pago de ApiPeru y devuelven
 * nombres de terceros: solo el personal del panel puede usarlas, no un cliente de la tienda.
 */
function contexto(manejador: (...args: any[]) => unknown, rol: string) {
  return {
    getHandler: () => manejador,
    getClass: () => SunatController,
    switchToHttp: () => ({ getRequest: () => ({ user: { rol, permisos: [] } }) }),
  } as any;
}

describe('SunatController · acceso a consultas de DNI y RUC', () => {
  const guard = new RolesGuard(new Reflector());
  const consultas = [SunatController.prototype.consultarDni, SunatController.prototype.consultarRuc];

  it('un cliente de la tienda recibe 403', () => {
    for (const manejador of consultas) {
      expect(() => guard.canActivate(contexto(manejador, 'cliente'))).toThrow(ForbiddenException);
    }
  });

  it('admin, vendedor y caja sí consultan', () => {
    for (const manejador of consultas) {
      for (const rol of ['admin', 'vendedor', 'caja']) {
        expect(guard.canActivate(contexto(manejador, rol))).toBe(true);
      }
    }
  });

  it('todo el controlador exige sesión y luego rol', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, SunatController)).toEqual([JwtGuard, RolesGuard]);
  });

  it('los POST conservan sus roles', () => {
    expect(() => guard.canActivate(contexto(SunatController.prototype.guardarEmpresaRuc, 'vendedor'))).toThrow(
      ForbiddenException,
    );
    expect(guard.canActivate(contexto(SunatController.prototype.guardarProveedorRuc, 'vendedor'))).toBe(true);
    expect(guard.canActivate(contexto(SunatController.prototype.guardarClienteDni, 'caja'))).toBe(true);
  });
});

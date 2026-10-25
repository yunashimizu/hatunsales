import { ForbiddenException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { JwtGuard } from '../../guards/jwt.guard';
import { RolesGuard } from '../../guards/roles.guard';
import { ClienteController } from './cliente.controller';

/**
 * POST /cliente/registro era pública: cualquiera creaba clientes enlazados a cuentas
 * ajenas y enumeraba DNI/correos. Ahora pide sesión del personal, como POST /cliente.
 */
function contexto(rol: string) {
  return {
    getHandler: () => ClienteController.prototype.registro,
    getClass: () => ClienteController,
    switchToHttp: () => ({ getRequest: () => ({ user: { rol, permisos: [] } }) }),
  } as any;
}

describe('ClienteController · POST /cliente/registro', () => {
  it('exige sesión (JwtGuard) y rol (RolesGuard)', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, ClienteController.prototype.registro)).toEqual([JwtGuard, RolesGuard]);
  });

  it('un cliente de la tienda o la caja reciben 403; admin y vendedor pasan', () => {
    const guard = new RolesGuard(new Reflector());
    expect(() => guard.canActivate(contexto('cliente'))).toThrow(ForbiddenException);
    expect(() => guard.canActivate(contexto('caja'))).toThrow(ForbiddenException);
    expect(guard.canActivate(contexto('admin'))).toBe(true);
    expect(guard.canActivate(contexto('vendedor'))).toBe(true);
  });
});

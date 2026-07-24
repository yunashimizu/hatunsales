import { Reflector } from '@nestjs/core';
import { RolesGuard } from './roles.guard';
import { ROLES_KEY } from './roles.decorator';

describe('RolesGuard', () => {
  it('should allow admin roles even when the user role name uses a different casing or alias', () => {
    const guard = new RolesGuard(new Reflector());

    const context = {
      getHandler: () => ({}),
      getClass: () => ({}),
      switchToHttp: () => ({
        getRequest: () => ({
          user: { rol: 'Administrador', permisos: [] },
        }),
      }),
    } as any;

    const reflector = guard['reflector'] as Reflector;
    jest.spyOn(reflector, 'getAllAndOverride').mockImplementation((key: string) => {
      if (key === ROLES_KEY) return ['admin'];
      return undefined;
    });

    expect(() => guard.canActivate(context)).not.toThrow();
  });
});

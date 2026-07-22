import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from './roles.decorator';
import { PERMISOS_KEY } from './permisos.decorator';

@Injectable()
export class RolesGuard implements CanActivate {

  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const rolesRequeridos = this.reflector.getAllAndOverride<string[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    const permisosRequeridos = this.reflector.getAllAndOverride<string[]>(PERMISOS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!rolesRequeridos && !permisosRequeridos) return true;

    const { user } = context.switchToHttp().getRequest();

    if (rolesRequeridos && !rolesRequeridos.includes(user.rol)) {
      throw new ForbiddenException(`Se requiere rol: ${rolesRequeridos.join(' o ')}`);
    }

    if (permisosRequeridos) {
      const tienePermiso = permisosRequeridos.every((p) =>
        user.permisos?.includes(p)
      );
      if (!tienePermiso) {
        throw new ForbiddenException(`Permisos insuficientes`);
      }
    }

    return true;
  }
}
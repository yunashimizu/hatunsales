import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from './roles.decorator';
import { PERMISOS_KEY } from './permisos.decorator';

@Injectable()
export class RolesGuard implements CanActivate {

  constructor(private reflector: Reflector) {}

  private normalizeRole(role?: string): string {
    if (!role) return '';

    const normalized = role.trim().toLowerCase();
    const aliases: Record<string, string> = {
      administrador: 'admin',
      administradora: 'admin',
      admin: 'admin',
      vendedor: 'vendedor',
      cajero: 'caja',
      caja: 'caja',
      cliente: 'cliente',
    };

    return aliases[normalized] ?? normalized;
  }

  private matchesRole(userRole: string, requiredRoles: string[]): boolean {
    const normalizedUserRole = this.normalizeRole(userRole);
    return requiredRoles.some((requiredRole) => this.normalizeRole(requiredRole) === normalizedUserRole);
  }

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

    if (rolesRequeridos && !this.matchesRole(user?.rol, rolesRequeridos)) {
      throw new ForbiddenException(`Se requiere rol: ${rolesRequeridos.join(' o ')}`);
    }

    if (permisosRequeridos) {
      const tienePermiso = permisosRequeridos.every((p) =>
        user?.permisos?.includes(p)
      );
      if (!tienePermiso) {
        throw new ForbiddenException(`Permisos insuficientes`);
      }
    }

    return true;
  }
}
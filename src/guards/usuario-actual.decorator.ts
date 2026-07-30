import { createParamDecorator, ExecutionContext } from '@nestjs/common';

export interface UsuarioToken {
  id_usuario: number;
  nombre: string;
  email: string;
  rol: string;
  permisos: string[];
}

/** Extrae el usuario que el JwtStrategy dejó en la petición. */
export const UsuarioActual = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): UsuarioToken | undefined => {
    return ctx.switchToHttp().getRequest().user;
  },
);

/** Roles del personal interno; el resto se considera cliente de la tienda. */
export const ROLES_INTERNOS = ['admin', 'vendedor', 'caja', 'consulta', 'superadmin'];

export function esUsuarioInterno(usuario?: UsuarioToken): boolean {
  const rol = (usuario?.rol ?? '').trim().toLowerCase();
  if (!usuario || !rol) return false;
  if (ROLES_INTERNOS.includes(rol)) return true;
  // Alias residuales
  return rol === 'demo' || rol === 'visor' || rol === 'usuario' || rol === 'cajero';
}

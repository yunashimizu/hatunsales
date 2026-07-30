import { jwtConfig } from '../../config/jwt.config';

/** Roles de personal de tienda (turno largo). Incluye alias de BD. */
const ROLES_STAFF = new Set([
  'admin',
  'administrador',
  'administradora',
  'superadmin',
  'caja',
  'cajero',
  'cajeroa',
  'vendedor',
  'vendedora',
  'empleado',
  'empleados',
  'trabajador',
  'trabajadores',
  'consulta',
  'demo',
  'visor',
  /** Nombre viejo del rol id 2 (consulta). */
  'usuario',
]);

export class TokenUtil {

  /** Duración del access token según el rol. */
  static getExpiresIn(rol: string): string {
    const nombre = (rol ?? '').trim().toLowerCase();
    if (ROLES_STAFF.has(nombre)) return jwtConfig.staff.expiresIn;
    return jwtConfig.cliente.expiresIn;
  }

  static getCookieMaxAge(rol: string): number {
    const tiempo = this.getExpiresIn(rol);

    if (tiempo.endsWith('m')) {
      const minutos = parseInt(tiempo.replace('m', ''), 10);
      return minutos * 60 * 1000;
    }

    if (tiempo.endsWith('h')) {
      const horas = parseInt(tiempo.replace('h', ''), 10);
      return horas * 60 * 60 * 1000;
    }

    if (tiempo.endsWith('d')) {
      const dias = parseInt(tiempo.replace('d', ''), 10);
      return dias * 24 * 60 * 60 * 1000;
    }

    return 12 * 60 * 60 * 1000; // fallback staff: 12h
  }

  /**
   * Opciones de cookie de sesión.
   * `secure` solo en producción para no romper http://localhost.
   */
  static cookieOptions(rol: string) {
    const enProduccion =
      process.env.NODE_ENV === 'production' ||
      process.env.COOKIE_SECURE === 'true';

    return {
      httpOnly: true,
      sameSite: 'lax' as const,
      secure: enProduccion,
      maxAge: TokenUtil.getCookieMaxAge(rol),
    };
  }
}

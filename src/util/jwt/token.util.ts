import { jwtConfig } from '../../config/jwt.config';

export class TokenUtil {

  static getExpiresIn(rol: string): string {
    if (rol === 'admin') return jwtConfig.admin.expiresIn;
    return jwtConfig.usuario.expiresIn;
  }

  static getCookieMaxAge(rol: string): number {
    const tiempo = this.getExpiresIn(rol);

    if (tiempo.endsWith('m')) {
      const minutos = parseInt(tiempo.replace('m', ''));
      return minutos * 60 * 1000; // ✅ minutos a ms
    }

    if (tiempo.endsWith('h')) {
      const horas = parseInt(tiempo.replace('h', ''));
      return horas * 60 * 60 * 1000; // ✅ horas a ms
    }

    if (tiempo.endsWith('d')) {
      const dias = parseInt(tiempo.replace('d', ''));
      return dias * 24 * 60 * 60 * 1000; // ✅ días a ms
    }

    return 60 * 60 * 1000; // fallback: 1h
  }
}
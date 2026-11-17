import * as bcrypt from 'bcrypt';
import { createHash, randomBytes } from 'crypto';

export class HashUtil {

  /**
   * Hash de relleno para comparar cuando el usuario no existe o no tiene
   * contraseña: el login tarda lo mismo y no delata qué correos existen.
   * Se calcula una sola vez (la primera vez que hace falta) con el mismo coste.
   */
  private static hashDeRelleno?: Promise<string>;

  static async hashPassword(password: string): Promise<string> {
    return bcrypt.hash(password, 12);
  }

  static async comparePassword(plain: string, hashed: string): Promise<boolean> {
    return bcrypt.compare(plain, hashed);
  }

  /** Gasta el mismo tiempo que una comparación real y siempre devuelve false. */
  static async compararSinCuenta(plain: string): Promise<false> {
    HashUtil.hashDeRelleno ??= bcrypt.hash(randomBytes(16).toString('hex'), 12);
    await bcrypt.compare(plain ?? '', await HashUtil.hashDeRelleno);
    return false;
  }

  /**
   * Huella de la contraseña para el token (`pv`): 16 hex del SHA-256 del hash
   * guardado. Cambia con cada contraseña nueva y no revela nada del hash.
   * Sin contraseña local no hay huella.
   */
  static huella(hashGuardado: string | null | undefined): string | undefined {
    if (!hashGuardado) return undefined;
    return createHash('sha256').update(hashGuardado).digest('hex').slice(0, 16);
  }
}

/**
 * Secretos JWT.
 *
 * El valor real NUNCA va hardcodeado aquí: vive en:
 *   - `.env` (local, gitignored)
 *   - Variables de Railway (producción)
 *
 * Fail-fast en `main.ts` si en prod falta o es el default débil.
 */
export const JWT_DEFAULT_DEV = 'hatunsales_secret_key_2024';

/**
 * Duración del JWT por tipo de usuario.
 *
 * - Staff (admin, caja, vendedor): turno de tienda (~12h)
 * - Cliente (tienda web): más corto por seguridad
 *
 * Se puede sobreescribir con env:
 *   JWT_EXPIRES_STAFF=12h
 *   JWT_EXPIRES_CLIENTE=2h
 */
export const jwtConfig = {
  secret: process.env.JWT_SECRET ?? JWT_DEFAULT_DEV,

  /** Empleados de mostrador y administración */
  staff: {
    expiresIn: process.env.JWT_EXPIRES_STAFF ?? '12h',
  },

  /** Clientes de la tienda online */
  cliente: {
    expiresIn: process.env.JWT_EXPIRES_CLIENTE ?? '2h',
  },

  // Compatibilidad con referencias antiguas
  admin: {
    expiresIn: process.env.JWT_EXPIRES_STAFF ?? '12h',
  },
  usuario: {
    expiresIn: process.env.JWT_EXPIRES_CLIENTE ?? '2h',
  },
};

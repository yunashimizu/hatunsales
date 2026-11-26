/**
 * Fase 2.9: largo mínimo de la contraseña al CREAR un usuario o al CAMBIAR su contraseña (personal y
 * tienda). Nunca se aplica al iniciar sesión: las contraseñas antiguas más cortas siguen entrando.
 */
export const CONTRASENA_MINIMA = 8;

export const MENSAJE_CONTRASENA_MINIMA = `La contraseña debe tener al menos ${CONTRASENA_MINIMA} caracteres. Elija una más larga.`;

/** true si la contraseña (sin espacios al borde) alcanza el mínimo. */
export function contrasenaSuficiente(valor: unknown): boolean {
  return String(valor ?? '').trim().length >= CONTRASENA_MINIMA;
}

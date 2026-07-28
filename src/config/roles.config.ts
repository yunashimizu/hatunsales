/**
 * IDs de rol en la BD HatunSales.
 * 1 admin, 2 usuario (tienda), 3 vendedor, 4 caja → panel solo 1/3/4
 * 5 cliente → tienda con cuenta
 */
export const ROL_IDS = {
  ADMIN: 1,
  USUARIO: 2,
  VENDEDOR: 3,
  CAJA: 4,
  CLIENTE: 5,
} as const;

/** Roles que entran al dashboard admin. */
export const STAFF_ROL_IDS: number[] = [
  ROL_IDS.ADMIN,
  ROL_IDS.VENDEDOR,
  ROL_IDS.CAJA,
];

/** Nombres normalizados de personal interno. */
export const STAFF_ROL_NOMBRES = ['admin', 'superadmin', 'vendedor', 'caja'] as const;

export function esRolStaff(idRol?: number | null, nombreRol?: string | null): boolean {
  if (idRol != null && STAFF_ROL_IDS.includes(Number(idRol))) return true;
  const nombre = (nombreRol ?? '').trim().toLowerCase();
  return (STAFF_ROL_NOMBRES as readonly string[]).includes(nombre);
}

export function esRolCliente(idRol?: number | null, nombreRol?: string | null): boolean {
  if (idRol != null && Number(idRol) === ROL_IDS.CLIENTE) return true;
  const nombre = (nombreRol ?? '').trim().toLowerCase();
  return nombre === 'cliente' || Number(idRol) === ROL_IDS.USUARIO;
}

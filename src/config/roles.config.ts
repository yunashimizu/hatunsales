/**
 * IDs de rol en la BD HatunSales (alineados con `roles`).
 * 1 admin, 2 consulta (solo lectura catálogo), 3 vendedor, 4 caja → panel
 * 5 cliente → tienda (nunca dashboard)
 */
export const ROL_IDS = {
  ADMIN: 1,
  /** Solo lectura catálogo/stock en el panel. */
  CONSULTA: 2,
  /** @deprecated Alias histórico del id 2; usar CONSULTA. */
  USUARIO: 2,
  VENDEDOR: 3,
  CAJA: 4,
  CLIENTE: 5,
} as const;

/** Roles que entran al dashboard admin. */
export const STAFF_ROL_IDS: number[] = [
  ROL_IDS.ADMIN,
  ROL_IDS.CONSULTA,
  ROL_IDS.VENDEDOR,
  ROL_IDS.CAJA,
];

/** Nombres canónicos de personal interno (tras normalizar). */
export const STAFF_ROL_NOMBRES = [
  'admin',
  'superadmin',
  'consulta',
  'vendedor',
  'caja',
] as const;

/** Alias de BD / JWT → nombre canónico. */
const ALIAS_ROL: Record<string, string> = {
  administrador: 'admin',
  administradora: 'admin',
  admin: 'admin',
  superadmin: 'admin',
  'super admin': 'admin',
  vendedor: 'vendedor',
  vendedora: 'vendedor',
  empleado: 'vendedor',
  empleados: 'vendedor',
  trabajador: 'vendedor',
  trabajadores: 'vendedor',
  caja: 'caja',
  cajero: 'caja',
  cajeroa: 'caja',
  consulta: 'consulta',
  demo: 'consulta',
  visor: 'consulta',
  /** Nombre viejo del rol id 2 (ya migrado a consulta en BD). */
  usuario: 'consulta',
  cliente: 'cliente',
};

export function normalizarRol(nombreRol?: string | null): string {
  const clave = (nombreRol ?? '').trim().toLowerCase();
  return ALIAS_ROL[clave] ?? clave;
}

export function esRolStaff(idRol?: number | null, nombreRol?: string | null): boolean {
  if (idRol != null && STAFF_ROL_IDS.includes(Number(idRol))) return true;
  return (STAFF_ROL_NOMBRES as readonly string[]).includes(normalizarRol(nombreRol));
}

/** Solo tienda: id 5 / nombre cliente. El id 2 ya no es cliente. */
export function esRolCliente(idRol?: number | null, nombreRol?: string | null): boolean {
  if (idRol != null && Number(idRol) === ROL_IDS.CLIENTE) return true;
  return normalizarRol(nombreRol) === 'cliente';
}

export function esRolConsulta(idRol?: number | null, nombreRol?: string | null): boolean {
  if (idRol != null && Number(idRol) === ROL_IDS.CONSULTA) return true;
  return normalizarRol(nombreRol) === 'consulta';
}

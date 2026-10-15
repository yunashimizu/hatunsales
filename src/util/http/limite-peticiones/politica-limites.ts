import { createHash } from 'node:crypto';
import { isIPv4, isIPv6 } from 'node:net';
import { booleanoEntorno, numeroEntorno } from '../../../config/runtime.config';
import type { ConsumoLimite } from './almacen-limites';

/**
 * Cubetas de límite por IP:
 *  - auth: login, registro, Google y alta pública de clientes (bcrypt cuesta CPU; fuerza bruta).
 *  - auth_cuenta: además, login por IP + correo (frena la fuerza bruta contra una cuenta).
 *  - documentos: consultas DNI/RUC (cuota de pago de ApiPeru).
 *  - consulta_publica: consulta pública de comprobantes (/cpe/*).
 *  - publico: escrituras anónimas de la tienda (carrito, validar cupón).
 *  - webhook: notificaciones de la pasarela.
 *  - general: todo lo demás, holgado (el local comparte una IP entre varias cajas).
 */
export type NombreCubeta =
  | 'auth'
  | 'auth_cuenta'
  | 'documentos'
  | 'consulta_publica'
  | 'publico'
  | 'webhook'
  | 'general';

export interface LimiteCubeta {
  readonly limite: number;
  readonly ventanaMs: number;
}

export interface ConfigLimites {
  readonly activo: boolean;
  readonly maxClaves: number;
  readonly cubetas: Readonly<Record<NombreCubeta, LimiteCubeta>>;
}

export interface PeticionLimitable {
  readonly metodo: string;
  readonly ruta: string;
  readonly ip?: string | null;
  readonly cuerpo?: unknown;
}

export interface ConsumoCubeta extends ConsumoLimite {
  readonly cubeta: NombreCubeta;
}

const MINUTO_MS = 60_000;

/** Lee los límites de las variables de entorno (todas opcionales). */
export function configLimitesDesdeEntorno(): ConfigLimites {
  const entero = (nombre: string, porDefecto: number, max = 1_000_000) =>
    Math.floor(numeroEntorno(nombre, porDefecto, { min: 1, max }));
  const porMinuto = (nombre: string, porDefecto: number): LimiteCubeta => ({
    limite: entero(nombre, porDefecto),
    ventanaMs: MINUTO_MS,
  });
  return {
    activo: booleanoEntorno('LIMITE_PETICIONES_ACTIVO', true),
    maxClaves: entero('LIMITE_PETICIONES_MAX_CLAVES', 50_000),
    cubetas: {
      auth: porMinuto('LIMITE_AUTH_POR_MIN', 20),
      auth_cuenta: { limite: entero('LIMITE_LOGIN_POR_CUENTA', 10, 1_000), ventanaMs: 10 * MINUTO_MS },
      documentos: porMinuto('LIMITE_DOCUMENTOS_POR_MIN', 40),
      consulta_publica: porMinuto('LIMITE_CONSULTA_PUBLICA_POR_MIN', 20),
      publico: porMinuto('LIMITE_PUBLICO_POR_MIN', 60),
      webhook: porMinuto('LIMITE_WEBHOOK_POR_MIN', 300),
      general: porMinuto('LIMITE_GENERAL_POR_MIN', 3_000),
    },
  };
}

interface Regla {
  readonly cubeta: NombreCubeta;
  /** Vacío = cualquier método. */
  readonly metodos: ReadonlySet<string>;
  readonly exactas?: readonly string[];
  /** Coinciden con la ruta exacta o con cualquier subruta (`/a` cubre `/a/b`, no `/ab`). */
  readonly prefijos?: readonly string[];
}

const CUALQUIERA: ReadonlySet<string> = new Set();
const SOLO_POST: ReadonlySet<string> = new Set(['POST']);
const ESCRITURAS: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** La primera regla que coincide decide la cubeta; sin coincidencia → general. */
const REGLAS: readonly Regla[] = [
  { cubeta: 'auth', metodos: SOLO_POST, exactas: ['/auth/login', '/auth/register', '/auth/google', '/cliente/registro'] },
  { cubeta: 'consulta_publica', metodos: CUALQUIERA, prefijos: ['/cpe'] },
  {
    cubeta: 'documentos',
    metodos: CUALQUIERA,
    prefijos: ['/sunat/dni', '/sunat/ruc', '/cliente/sunat', '/receptor/consultar', '/receptor/buscar'],
  },
  { cubeta: 'webhook', metodos: SOLO_POST, prefijos: ['/tienda/pagos/webhook'] },
  { cubeta: 'publico', metodos: SOLO_POST, exactas: ['/tienda/checkout/validar-cupon'] },
  { cubeta: 'publico', metodos: ESCRITURAS, prefijos: ['/tienda/carrito'] },
];

/** Monitoreo y healthcheck de Railway: nunca se limitan. */
const RUTAS_EXENTAS: ReadonlySet<string> = new Set(['/', '/salud']);

const MENSAJES: Readonly<Record<NombreCubeta, string>> = {
  auth: 'Demasiados intentos de acceso desde esta conexión.',
  auth_cuenta: 'Demasiados intentos de inicio de sesión para esta cuenta.',
  documentos: 'Demasiadas consultas de DNI/RUC seguidas.',
  consulta_publica: 'Demasiadas consultas de comprobantes seguidas.',
  publico: 'Demasiadas solicitudes seguidas.',
  webhook: 'Demasiadas notificaciones seguidas.',
  general: 'Demasiadas solicitudes seguidas.',
};

/** `/Auth/Login/` → `/auth/login` (Express ignora mayúsculas y la barra final). */
export function normalizarRuta(ruta: string): string {
  const sinQuery = String(ruta ?? '').split(/[?#]/, 1)[0].toLowerCase();
  const sinBarra = sinQuery.replace(/\/+$/, '');
  return sinBarra.startsWith('/') ? sinBarra || '/' : `/${sinBarra}`;
}

function expandirIpv6(ip: string): string[] {
  const [cabeza, cola] = ip.split('::');
  const izquierda = cabeza ? cabeza.split(':') : [];
  if (cola === undefined) return izquierda;
  const derecha = cola ? cola.split(':') : [];
  const ceros = Array<string>(Math.max(0, 8 - izquierda.length - derecha.length)).fill('0');
  return [...izquierda, ...ceros, ...derecha];
}

/**
 * Clave de IP: IPv4 tal cual (también las IPv4 mapeadas en IPv6) e IPv6 por su
 * prefijo /64, porque un mismo cliente IPv6 puede rotar direcciones dentro de él.
 */
export function claveIp(ip: string | null | undefined): string {
  let texto = String(ip ?? '').trim().toLowerCase();
  if (!texto) return 'desconocida';
  const zona = texto.indexOf('%');
  if (zona >= 0) texto = texto.slice(0, zona);
  if (texto.startsWith('::ffff:') && isIPv4(texto.slice(7))) return texto.slice(7);
  if (isIPv4(texto)) return texto;
  if (isIPv6(texto)) {
    const grupos = expandirIpv6(texto).slice(0, 4).map((g) => g.replace(/^0+(?=.)/, '') || '0');
    return `${grupos.join(':')}::/64`;
  }
  return texto.slice(0, 64);
}

/** Correo del cuerpo del login, normalizado, o null. */
function correoDe(cuerpo: unknown): string | null {
  const email = (cuerpo as { email?: unknown } | null | undefined)?.email;
  if (typeof email !== 'string') return null;
  const limpio = email.trim().toLowerCase();
  return limpio && limpio.length <= 254 ? limpio : null;
}

/** El correo no se guarda en claro en memoria: solo una huella. */
function huella(texto: string): string {
  return createHash('sha256').update(texto).digest('base64url').slice(0, 16);
}

function coincide(regla: Regla, metodo: string, ruta: string): boolean {
  if (regla.metodos.size && !regla.metodos.has(metodo)) return false;
  if (regla.exactas?.includes(ruta)) return true;
  return regla.prefijos?.some((p) => ruta === p || ruta.startsWith(`${p}/`)) ?? false;
}

/** Decide qué contadores consume cada petición. */
export class PoliticaLimites {
  constructor(private readonly config: ConfigLimites) {}

  get activa(): boolean {
    return this.config.activo;
  }

  get maxClaves(): number {
    return this.config.maxClaves;
  }

  cubetaDe(metodo: string, ruta: string): NombreCubeta {
    const m = metodo.toUpperCase();
    const r = normalizarRuta(ruta);
    return REGLAS.find((regla) => coincide(regla, m, r))?.cubeta ?? 'general';
  }

  /** Contadores a consumir; vacío si la petición no se limita. */
  consumosPara(peticion: PeticionLimitable): ConsumoCubeta[] {
    if (!this.config.activo) return [];
    const metodo = String(peticion.metodo ?? 'GET').toUpperCase();
    const ruta = normalizarRuta(peticion.ruta);
    if (metodo === 'OPTIONS') return [];
    if ((metodo === 'GET' || metodo === 'HEAD') && RUTAS_EXENTAS.has(ruta)) return [];

    const ip = claveIp(peticion.ip);
    const cubeta = this.cubetaDe(metodo, ruta);
    const consumos = [this.consumo(cubeta, ip)];
    if (cubeta === 'auth' && ruta === '/auth/login') {
      const correo = correoDe(peticion.cuerpo);
      if (correo) consumos.push(this.consumo('auth_cuenta', `${ip}|${huella(correo)}`));
    }
    return consumos;
  }

  /** Mensaje en español para el 429, con el tiempo de espera. */
  mensaje(cubeta: NombreCubeta, segundos: number): string {
    const espera = segundos < 60 ? `${segundos} s` : `${Math.ceil(segundos / 60)} min`;
    return `${MENSAJES[cubeta]} Intente de nuevo en ${espera}.`;
  }

  private consumo(cubeta: NombreCubeta, sufijo: string): ConsumoCubeta {
    const { limite, ventanaMs } = this.config.cubetas[cubeta];
    return { cubeta, clave: `${cubeta}|${sufijo}`, limite, ventanaMs };
  }
}

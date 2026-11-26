import { createHash } from 'crypto';
import { BadRequestException, HttpException, HttpStatus, Injectable, Logger, Optional, UnprocessableEntityException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { jwtConfig } from '../config/jwt.config';
import { normalizarRol } from '../config/roles.config';
import { ConfiguracionRepository } from '../repository/Repository/configuracion.repository';
import { BitacoraService } from '../bitacora/bitacora.service';
import { ACCIONES_BITACORA } from '../bitacora/bitacora.acciones';
import { HashUtil } from '../util/jwt/hash.util';
import type { UsuarioToken } from '../guards/usuario-actual.decorator';
import {
  CLAVES_CONTROL_REBAJA,
  ConfigControlRebaja,
  configControlDesdeValores,
  MODOS_CONTROL_REBAJA,
  ModoControlRebaja,
} from '../util/precios/control-rebaja';
import {
  claveDePermiso,
  crearDatosPermiso,
  firmarPermiso,
  ResultadoPermiso,
  verificarPermiso,
} from './permiso-autorizacion';

/** Cuerpo de `PUT configuracion/control-rebaja`: todo opcional, solo cambia lo que llega. */
export interface CambioControlRebaja {
  modo?: unknown;
  tope_pct?: unknown;
  bajo_costo?: unknown;
}

export interface AdministradorAutorizante {
  id_usuario: number;
  nombre: string;
}

/** Respuesta 422 (no 401: el front cierra la sesión del cajero ante cualquier 401). */
export const CODIGO_AUTORIZACION_RECHAZADA = 'AUTORIZACION_RECHAZADA';
const MENSAJE_RECHAZO = 'Correo o contraseña de administrador incorrectos, o la cuenta no es de un administrador activo.';
const MAX_USADOS = 5_000;

/** 429 del freno fino: el front lo distingue del 429 genérico por este código. */
export const CODIGO_AUTORIZACION_BLOQUEADA = 'AUTORIZACION_BLOQUEADA';
/** Freno fino (solo intentos FALLIDOS): por quien pide y por el correo de administrador probado. */
export const FRENO_AUTORIZACION = {
  solicitante: { fallos: 5, ventanaMs: 5 * 60_000 },
  correo: { fallos: 10, ventanaMs: 15 * 60_000 },
} as const;
const MAX_CLAVES_FRENO = 5_000;

/**
 * Control de rebajas (Fase 6.4): configuración, verificación del administrador y permisos firmados.
 *
 * - La lectura de la configuración para la venta (`configuracionParaVenta`) NUNCA lanza: ante un fallo
 *   devuelve null y la venta sigue como antes de este control.
 * - El permiso es de uso único (en memoria de este proceso): se marca después de que la venta quedó
 *   guardada; un reintento idempotente de esa misma venta se resuelve antes de mirar el permiso.
 */
@Injectable()
export class ControlRebajaService {
  private readonly log = new Logger(ControlRebajaService.name);
  /** Del mismo lugar que el módulo JWT (`jwtConfig.secret`), derivada: nunca el secreto tal cual. */
  private readonly clave = claveDePermiso(jwtConfig.secret);
  /** firma → vencimiento. */
  private readonly usados = new Map<string, number>();
  /** Fallos recientes (marcas de tiempo) por solicitante y por huella del correo probado. */
  private readonly fallosSolicitante = new Map<string, number[]>();
  private readonly fallosCorreo = new Map<string, number[]>();
  /** Reloj (las pruebas lo reemplazan). */
  ahora: () => number = () => Date.now();

  constructor(
    private readonly config: ConfiguracionRepository,
    @InjectDataSource('pgConnection') private readonly dataSource: DataSource,
    @Optional() private readonly bitacora?: BitacoraService,
  ) {}

  // ── Configuración ───────────────────────────────────────────

  /** Configuración vigente (caché de 60 s de ConfiguracionRepository). Puede lanzar: es para la pantalla de admin. */
  async configuracion(): Promise<ConfigControlRebaja> {
    const valores = await this.config.obtenerVarias([
      CLAVES_CONTROL_REBAJA.modo,
      CLAVES_CONTROL_REBAJA.tope,
      CLAVES_CONTROL_REBAJA.bajoCosto,
    ]);
    return configControlDesdeValores(valores);
  }

  /** Para la venta, la vista previa y el contexto del POS: null si no se pudo leer (la venta sigue como hoy). Nunca lanza. */
  async configuracionParaVenta(): Promise<ConfigControlRebaja | null> {
    try {
      return await this.configuracion();
    } catch (error) {
      this.log.warn(`No se pudo leer la configuración del control de rebajas; la venta sigue sin control: ${(error as Error)?.message ?? error}`);
      return null;
    }
  }

  /** Guarda solo lo que cambió y lo anota en la bitácora (`configuracion.control_rebaja`). */
  async guardar(cambio: CambioControlRebaja, usuario?: UsuarioToken): Promise<ConfigControlRebaja> {
    const nuevo = this.validarCambio(cambio ?? {});
    const antes = await this.configuracion();
    const despues: ConfigControlRebaja = { ...antes, ...nuevo };

    if (despues.modo !== antes.modo) await this.config.guardar(CLAVES_CONTROL_REBAJA.modo, despues.modo);
    if (despues.tope_pct !== antes.tope_pct) await this.config.guardar(CLAVES_CONTROL_REBAJA.tope, String(despues.tope_pct));
    if (despues.bajo_costo !== antes.bajo_costo) {
      await this.config.guardar(CLAVES_CONTROL_REBAJA.bajoCosto, despues.bajo_costo ? 'true' : 'false');
    }

    const cambio_hecho = despues.modo !== antes.modo || despues.tope_pct !== antes.tope_pct || despues.bajo_costo !== antes.bajo_costo;
    if (cambio_hecho) {
      await this.bitacora?.registrarCon(() => ({
        accion: ACCIONES_BITACORA.CONFIGURACION_CONTROL_REBAJA,
        id_usuario: usuario?.id_usuario ?? null,
        rol: usuario?.rol ?? null,
        entidad: 'configuracion',
        antes: { modo: antes.modo, tope_pct: antes.tope_pct, bajo_costo: antes.bajo_costo },
        despues: { modo: despues.modo, tope_pct: despues.tope_pct, bajo_costo: despues.bajo_costo },
      }));
    }
    return despues;
  }

  private validarCambio(cambio: CambioControlRebaja): Partial<ConfigControlRebaja> {
    const nuevo: Partial<ConfigControlRebaja> = {};
    if (cambio.modo !== undefined && cambio.modo !== null) {
      const modo = String(cambio.modo).trim().toLowerCase();
      if (!(MODOS_CONTROL_REBAJA as readonly string[]).includes(modo)) {
        throw new BadRequestException(`El modo debe ser uno de: ${MODOS_CONTROL_REBAJA.join(', ')}.`);
      }
      nuevo.modo = modo as ModoControlRebaja;
    }
    if (cambio.tope_pct !== undefined && cambio.tope_pct !== null) {
      const tope = Number(String(cambio.tope_pct).trim().replace(',', '.'));
      if (String(cambio.tope_pct).trim() === '' || !Number.isFinite(tope) || tope < 0 || tope > 100) {
        throw new BadRequestException('El tope de rebaja debe ser un porcentaje entre 0 y 100.');
      }
      nuevo.tope_pct = Math.round(tope * 100) / 100;
    }
    if (cambio.bajo_costo !== undefined && cambio.bajo_costo !== null) {
      if (typeof cambio.bajo_costo !== 'boolean') throw new BadRequestException('«bajo_costo» debe ser verdadero o falso.');
      nuevo.bajo_costo = cambio.bajo_costo;
    }
    return nuevo;
  }

  // ── Administrador que autoriza ──────────────────────────────

  /**
   * Correo y contraseña de un administrador ACTIVO. Igual que el login: sin cuenta (o sin contraseña) se
   * compara contra un hash de relleno, y una cuenta que no es admin compara igual; el tiempo no delata
   * nada. Responde 422 (no 401). La contraseña no se escribe en ningún log.
   */
  async verificarAdministrador(email: unknown, password: unknown, solicitante?: number | null): Promise<AdministradorAutorizante> {
    const correo = typeof email === 'string' ? email.trim().toLowerCase() : '';
    // Mientras dure un bloqueo no se consulta la base ni se compara la contraseña.
    const claves = this.clavesDeFreno(solicitante, correo);
    this.exigirSinBloqueo(claves);
    try {
      const admin = await this.compararAdministrador(correo, password);
      if (claves.solicitante) this.fallosSolicitante.delete(claves.solicitante);
      return admin;
    } catch (error) {
      // Solo cuentan los rechazos (credenciales); un fallo de la base no es un intento fallido.
      if (error instanceof UnprocessableEntityException) this.anotarFallo(claves);
      throw error;
    }
  }

  private async compararAdministrador(correo: string, password: unknown): Promise<AdministradorAutorizante> {
    const clave = typeof password === 'string' ? password : '';
    if (!correo || !clave) {
      throw new UnprocessableEntityException({ codigo: CODIGO_AUTORIZACION_RECHAZADA, message: 'Indique el correo y la contraseña del administrador.' });
    }

    const filas = await this.dataSource.query(
      `SELECT u.id_usuario, u.nombre, u.password, r.nombre AS rol
         FROM usuarios u
         LEFT JOIN roles r ON r.id_rol = u.id_rol
        WHERE LOWER(u.email) = $1 AND u.estado = true
        ORDER BY u.id_usuario ASC
        LIMIT 1`,
      [correo],
    );
    const usuario = filas?.[0];
    if (!usuario || !usuario.password) {
      await HashUtil.compararSinCuenta(clave);
      throw this.rechazo();
    }
    const valida = await HashUtil.comparePassword(clave, String(usuario.password));
    if (!valida || normalizarRol(usuario.rol) !== 'admin') throw this.rechazo();
    return { id_usuario: Number(usuario.id_usuario), nombre: String(usuario.nombre ?? '').trim() };
  }

  // ── Freno fino de intentos fallidos (en memoria de este proceso) ──

  /** El correo se guarda como huella (nunca en claro) y cuenta igual exista o no: no revela nada. */
  private clavesDeFreno(solicitante: number | null | undefined, correo: string): { solicitante: string | null; correo: string | null } {
    const id = Number(solicitante);
    return {
      solicitante: Number.isSafeInteger(id) && id > 0 ? String(id) : null,
      correo: correo ? createHash('sha256').update(`autorizacion:${correo}`).digest('base64url') : null,
    };
  }

  /** Marcas dentro de la ventana (limpia las viejas; borra la entrada si queda vacía). */
  private recientes(mapa: Map<string, number[]>, clave: string, ventanaMs: number, ahora: number): number[] {
    const vigentes = (mapa.get(clave) ?? []).filter((t) => t > ahora - ventanaMs);
    if (vigentes.length) mapa.set(clave, vigentes);
    else mapa.delete(clave);
    return vigentes;
  }

  /** ms que faltan para que caiga bajo el límite, o 0 si no está bloqueado. */
  private esperaMs(mapa: Map<string, number[]>, clave: string | null, limite: { fallos: number; ventanaMs: number }, ahora: number): number {
    if (!clave) return 0;
    const vigentes = this.recientes(mapa, clave, limite.ventanaMs, ahora);
    if (vigentes.length < limite.fallos) return 0;
    // Se desbloquea cuando la marca que lo dejó en el límite sale de la ventana.
    const decisiva = vigentes[vigentes.length - limite.fallos];
    return Math.max(1, decisiva + limite.ventanaMs - ahora);
  }

  private exigirSinBloqueo(claves: { solicitante: string | null; correo: string | null }): void {
    const ahora = this.ahora();
    const espera = Math.max(
      this.esperaMs(this.fallosSolicitante, claves.solicitante, FRENO_AUTORIZACION.solicitante, ahora),
      this.esperaMs(this.fallosCorreo, claves.correo, FRENO_AUTORIZACION.correo, ahora),
    );
    if (!espera) return;
    const minutos = Math.max(1, Math.ceil(espera / 60_000));
    throw new HttpException(
      {
        statusCode: HttpStatus.TOO_MANY_REQUESTS,
        codigo: CODIGO_AUTORIZACION_BLOQUEADA,
        message: `Demasiados intentos fallidos de autorización. Espere ${minutos} ${minutos === 1 ? 'minuto' : 'minutos'} antes de volver a intentarlo.`,
        reintentarEnSeg: Math.ceil(espera / 1000),
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }

  private anotarFallo(claves: { solicitante: string | null; correo: string | null }): void {
    try {
      const ahora = this.ahora();
      const anotar = (mapa: Map<string, number[]>, clave: string | null, ventanaMs: number) => {
        if (!clave) return;
        if (mapa.size >= MAX_CLAVES_FRENO && !mapa.has(clave)) {
          for (const k of [...mapa.keys()]) this.recientes(mapa, k, ventanaMs, ahora);
          if (mapa.size >= MAX_CLAVES_FRENO) mapa.delete(mapa.keys().next().value as string);
        }
        mapa.set(clave, [...this.recientes(mapa, clave, ventanaMs, ahora), ahora]);
      };
      anotar(this.fallosSolicitante, claves.solicitante, FRENO_AUTORIZACION.solicitante.ventanaMs);
      anotar(this.fallosCorreo, claves.correo, FRENO_AUTORIZACION.correo.ventanaMs);
    } catch {
      /* el freno es una ayuda: un fallo aquí no cambia la respuesta */
    }
  }

  private rechazo(): UnprocessableEntityException {
    return new UnprocessableEntityException({ codigo: CODIGO_AUTORIZACION_RECHAZADA, message: MENSAJE_RECHAZO });
  }

  // ── Permiso ─────────────────────────────────────────────────

  emitirPermiso(solicitante: number, autorizador: number, huella: string): { permiso: string; vence: number } {
    const datos = crearDatosPermiso(solicitante, autorizador, huella, this.ahora());
    return { permiso: firmarPermiso(datos, this.clave), vence: datos.vence };
  }

  /** Firma, vencimiento, solicitante, huella y uso único. Nunca lanza. */
  verificarPermiso(permiso: unknown, solicitante: number, huella: string): ResultadoPermiso | { valido: false; motivo: 'usado' } {
    try {
      const ahora = this.ahora();
      const resultado = verificarPermiso(permiso, { solicitante, huella, ahora }, this.clave);
      if (resultado.valido) {
        const usado = this.usados.get(resultado.firma);
        if (usado !== undefined && usado > ahora) return { valido: false, motivo: 'usado' };
      }
      return resultado;
    } catch (error) {
      this.log.warn(`No se pudo verificar un permiso de autorización: ${(error as Error)?.message ?? error}`);
      return { valido: false, motivo: 'mal_formado' };
    }
  }

  /** Después de guardar la venta: ese permiso ya no sirve para otra. Nunca lanza. */
  marcarUsado(firma: string, vence: number): void {
    try {
      const ahora = this.ahora();
      if (this.usados.size >= MAX_USADOS) {
        for (const [f, v] of this.usados) if (v <= ahora) this.usados.delete(f);
        if (this.usados.size >= MAX_USADOS) this.usados.clear();
      }
      this.usados.set(firma, vence);
    } catch {
      /* uso único en memoria: un fallo aquí no frena nada */
    }
  }
}

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { BitacoraService } from '../../bitacora/bitacora.service';
import { ACCIONES_BITACORA } from '../../bitacora/bitacora.acciones';
import { CajaSesionRepository } from '../../repository/Repository/caja-sesion.repository';
import type { LocalCaja, OcupanteCaja } from '../../repository/Repository/caja-sesion.repository';
import type { UsuarioToken } from '../../guards/usuario-actual.decorator';
import { CodigoError, cuerpoError } from '../../util/errores-operativos';
import { normalizarRol } from '../../config/roles.config';
import {
  AbrirCajaRequest,
  ActualizarCajaRequest,
  CerrarCajaRequest,
  CrearCajaRequest,
} from '../../models/model/caja.request';
import { CajaArqueoBussnies } from './caja-arqueo.bussnies';
import type { ResultadoPreparacionCierre } from '../Ibussnies/ICajaArqueoBussniees';
import { relanzarHttp } from '../../caja/http/errores-caja.http';
import { Dinero } from '../../caja/dominio/dinero';
import { CodigoErrorCaja, ErrorCaja } from '../../caja/dominio/errores-caja';
import { ControlCajaService } from '../../caja/configuracion/control-caja.service';
import { ocultaEsperadoA } from '../../caja/configuracion/control-caja';
import { resumenTurnoCiego } from '../../caja/arqueo/arqueo-ciego';
import type { ResumenTurno } from '../../repository/Repository/caja-sesion.repository';

/** Tope del efectivo inicial de un turno (S/). */
export const MONTO_INICIAL_MAXIMO = 9_999_999.99;

/**
 * Efectivo inicial del turno. «Sin efectivo» → 0.00 (ignora el monto). Sin monto → 0.00
 * explícito (compatibilidad con el front viejo). Negativo, NaN, con más de 2 decimales o
 * mayor al tope → 400 CAJA_MONTO_INICIAL_INVALIDO.
 */
export function montoInicialDeApertura(body: Pick<AbrirCajaRequest, 'monto_inicial' | 'sin_efectivo'>): Dinero {
  if (body?.sin_efectivo === true) return Dinero.CERO;
  const crudo: unknown = body?.monto_inicial;
  if (crudo === undefined || crudo === null || (typeof crudo === 'string' && crudo.trim() === '')) {
    return Dinero.CERO;
  }
  const invalido = (mensaje: string) =>
    ErrorCaja.datoInvalido(mensaje, CodigoErrorCaja.CAJA_MONTO_INICIAL_INVALIDO);
  const n = typeof crudo === 'number' ? crudo : Number(crudo);
  if (!Number.isFinite(n)) throw invalido('El efectivo inicial debe ser un número.');
  if (n < 0) throw invalido('El efectivo inicial no puede ser negativo.');
  if (n > MONTO_INICIAL_MAXIMO) throw invalido('El efectivo inicial es demasiado alto (máximo S/ 9,999,999.99).');
  try {
    return Dinero.deSoles(n);
  } catch {
    throw invalido('El efectivo inicial admite como máximo 2 decimales.');
  }
}

/**
 * Turno de caja (apertura / cierre). Sin DDL: el esquema se lee del catálogo una sola vez
 * y la configuración (caja_modo) sale de ConfiguracionRepository con su caché.
 */
@Injectable()
export class CajaSesionBussnies {
  constructor(
    private readonly repo: CajaSesionRepository,
    private readonly arqueos: CajaArqueoBussnies,
    /** Bitácora (Fase 6.3): cierre del turno de otro usuario. Nunca hace fallar el cierre. */
    @Optional() private readonly bitacora?: BitacoraService,
    /** Fase 7.3 (arqueo ciego). Nest siempre lo inyecta; sin él, todo como antes. */
    @Optional() private readonly controlCaja?: ControlCajaService,
  ) {}

  /** Fase 7.3: con `arqueo_ciego` encendido, caja y vendedor no ven montos del turno hasta su conteo. Nunca lanza. */
  private async ocultaEsperado(usuario?: UsuarioToken): Promise<boolean> {
    if (!this.controlCaja) return false;
    return ocultaEsperadoA(normalizarRol(usuario?.rol), await this.controlCaja.arqueoCiego());
  }

  private resumenVisible(resumen: ResumenTurno, oculto: boolean) {
    return oculto ? resumenTurnoCiego(resumen) : resumen;
  }

  /** GET /caja/sesion (dashboard y POS): modo y turno en paralelo. */
  async sesion(usuario: UsuarioToken) {
    const idUsuario = Number(usuario?.id_usuario);
    const [modo, apertura] = await Promise.all([
      this.repo.modoCaja(),
      idUsuario ? this.repo.sesionUsuario(idUsuario) : Promise.resolve(null),
    ]);
    if (!idUsuario) {
      return { modo, abierta: false, apertura: null, resumen: null };
    }
    const resumen = apertura ? await this.repo.resumenTurno(apertura) : null;
    const oculto = resumen ? await this.ocultaEsperado(usuario) : false;
    return {
      modo,
      abierta: !!apertura,
      apertura,
      resumen: resumen ? this.resumenVisible(resumen, oculto) : null,
      /** Fase 7.3: true = los montos del resumen van en null (arqueo ciego). */
      resumen_oculto: oculto,
    };
  }

  async resumenTurno(usuario: UsuarioToken) {
    const idUsuario = Number(usuario?.id_usuario);
    if (!idUsuario) {
      throw new ForbiddenException('Sesión inválida');
    }
    const apertura = await this.repo.sesionUsuario(idUsuario);
    if (!apertura) {
      throw new NotFoundException(
        cuerpoError(CodigoError.CAJA_NO_ABIERTA, 'No hay caja abierta para resumir'),
      );
    }
    const resumen = await this.repo.resumenTurno(apertura);
    const oculto = await this.ocultaEsperado(usuario);
    return { apertura, resumen: this.resumenVisible(resumen, oculto), resumen_oculto: oculto };
  }

  /**
   * Cajas con quién tiene cada una (ocupada_por, abierta_en, es_mia) y todos los locales.
   * El ocupante y los locales son informativos: si su consulta falla, las cajas se devuelven igual
   * que antes (campos nuevos en null/false y `sucursales: []`). Quien no es admin no recibe las
   * cajas desactivadas; el admin las recibe todas (con `activa: false`).
   */
  async disponibles(usuario?: UsuarioToken) {
    const idUsuario = Number(usuario?.id_usuario) || null;
    const esAdmin = normalizarRol(usuario?.rol) === 'admin';
    const [cajas, ocupantes, sucursales] = await Promise.all([
      this.repo.listarDisponibles(),
      Promise.resolve()
        .then(() => this.repo.ocupantesDeCajas())
        .catch(() => new Map<number, OcupanteCaja>()),
      Promise.resolve()
        .then(() => this.repo.listarLocales())
        .catch((): LocalCaja[] => []),
    ]);
    const items = cajas
      .filter((c) => esAdmin || c.activa !== false)
      .map((c) => this.conOcupante(c, ocupantes, idUsuario));
    return { items, sucursales };
  }

  private conOcupante<T extends { id_caja: number; ocupada: boolean }>(
    c: T,
    ocupantes: Map<number, OcupanteCaja>,
    idUsuario: number | null,
  ) {
    const o = c.ocupada ? ocupantes.get(c.id_caja) : undefined;
    return {
      ...c,
      ocupada_por: o?.usuario_nombre ?? null,
      abierta_en: o?.abierta_en ?? null,
      es_mia: !!o && idUsuario != null && o.id_usuario === idUsuario,
    };
  }

  /** Nombre recortado; null si vino vacío. Más de 100 caracteres → 400. */
  private nombreDeCaja(crudo: unknown): string | null {
    const nombre = typeof crudo === 'string' ? crudo.trim() : '';
    if (nombre.length > 100) {
      throw new BadRequestException('El nombre de la caja admite como máximo 100 caracteres');
    }
    return nombre === '' ? null : nombre;
  }

  /** La caja recién creada o cambiada, con la forma de `disponibles`. */
  private async respuestaCaja<T extends { id_caja: number; ocupada: boolean }>(caja: T, usuario?: UsuarioToken) {
    const idUsuario = Number(usuario?.id_usuario) || null;
    const ocupantes = await Promise.resolve()
      .then(() => this.repo.ocupantesDeCajas())
      .catch(() => new Map<number, OcupanteCaja>());
    return this.conOcupante(caja, ocupantes, idUsuario);
  }

  /** POST /caja/cajas (solo admin, lo exige el controlador). */
  async crearCaja(body: CrearCajaRequest, usuario?: UsuarioToken) {
    const idSucursal = Number(body?.id_sucursal);
    if (!Number.isInteger(idSucursal) || idSucursal <= 0) {
      throw new NotFoundException(cuerpoError(CodigoError.ENTIDAD_NO_ENCONTRADA, 'Local no encontrado'));
    }
    const nombre = this.nombreDeCaja(body?.nombre);
    try {
      const creada = await this.repo.crearCaja({ idSucursal, nombre });
      return await this.respuestaCaja(creada, usuario);
    } catch (e: any) {
      this.mapErrorCaja(e);
    }
  }

  /** PATCH /caja/cajas/:id (solo admin, lo exige el controlador). */
  async actualizarCaja(idCaja: number, body: ActualizarCajaRequest, usuario?: UsuarioToken) {
    if (!Number.isInteger(idCaja) || idCaja <= 0) {
      throw new NotFoundException(cuerpoError(CodigoError.ENTIDAD_NO_ENCONTRADA, 'Caja no encontrada'));
    }
    const cambios: { nombre?: string; activa?: boolean } = {};
    if (body?.nombre !== undefined) {
      const nombre = this.nombreDeCaja(body.nombre);
      if (nombre == null) throw new BadRequestException('El nombre de la caja no puede quedar vacío');
      cambios.nombre = nombre;
    }
    if (body?.activa !== undefined) cambios.activa = body.activa === true;
    if (cambios.nombre === undefined && cambios.activa === undefined) {
      throw new BadRequestException('Indique el nombre o si la caja está activa');
    }
    try {
      const actual = await this.repo.actualizarCaja(idCaja, cambios);
      return await this.respuestaCaja(actual, usuario);
    } catch (e: any) {
      this.mapErrorCaja(e);
    }
  }

  private mapErrorCaja(e: any): never {
    const code = String(e?.message ?? e);
    if (code === 'SUCURSAL_NO_ENCONTRADA') {
      throw new NotFoundException(cuerpoError(CodigoError.ENTIDAD_NO_ENCONTRADA, 'Local no encontrado'));
    }
    if (code === 'CAJA_NO_ENCONTRADA') {
      throw new NotFoundException(cuerpoError(CodigoError.ENTIDAD_NO_ENCONTRADA, 'Caja no encontrada'));
    }
    if (code === 'CAJA_NOMBRE_REPETIDO') {
      throw new ConflictException(
        cuerpoError(CodigoError.CAJA_NOMBRE_REPETIDO, 'Ya hay una caja con ese nombre en este local'),
      );
    }
    if (code === 'CAJA_CON_TURNO_ABIERTO') {
      throw new ConflictException(
        cuerpoError(CodigoError.CAJA_CON_TURNO_ABIERTO, 'Cierra el turno de esta caja antes de desactivarla'),
      );
    }
    if (code === 'CAJA_ESQUEMA_NO_SOPORTA') {
      throw new BadRequestException(
        'Esta base de datos no permite administrar cajas desde el panel (faltan columnas en la tabla cajas)',
      );
    }
    relanzarHttp(e);
  }

  async abrir(body: AbrirCajaRequest, usuario: UsuarioToken) {
    const idUsuario = Number(usuario?.id_usuario);
    if (!idUsuario) {
      throw new ForbiddenException('Sesión inválida');
    }
    const idCaja = Number(body?.id_caja);
    if (!Number.isInteger(idCaja) || idCaja <= 0) {
      throw new BadRequestException('Indique la caja a abrir (id_caja)');
    }
    let monto: Dinero;
    try {
      monto = montoInicialDeApertura(body);
    } catch (e) {
      relanzarHttp(e);
    }
    if (!(await this.repo.cajaExiste(idCaja))) {
      throw new NotFoundException(
        cuerpoError(CodigoError.ENTIDAD_NO_ENCONTRADA, 'Caja no encontrada'),
      );
    }

    try {
      // El sugerido es informativo: si no se puede leer, el turno se abre igual.
      const sugerido = await this.repo.sugeridoInicial(idCaja).catch(() => null);
      const sesion = await this.repo.abrir({ idCaja, idUsuario, montoInicial: monto.aNumero() });
      return {
        ...sesion,
        sugerido_inicial: sugerido,
        diferencia_sugerido:
          sugerido == null ? null : monto.restar(Dinero.desdeNumeroRedondeado(sugerido)).aNumero(),
      };
    } catch (e: any) {
      this.mapError(e);
    }
  }

  /**
   * Cierra el turno. Si llega id_arqueo (o hay un arqueo de cierre vigente y no se mandó
   * monto_conteo) el conteo sale del arqueo y queda enlazado; sin arqueo, igual que antes.
   * Además guarda el efectivo esperado en cierres_caja.monto_final.
   */
  async cerrar(body: CerrarCajaRequest, usuario: UsuarioToken) {
    const idUsuario = Number(usuario?.id_usuario);
    if (!idUsuario) {
      throw new ForbiddenException('Sesión inválida');
    }

    let idApertura = Number(body?.id_apertura);
    if (!Number.isInteger(idApertura) || idApertura <= 0) {
      const propia = await this.repo.sesionUsuario(idUsuario);
      if (!propia) {
        throw new NotFoundException(
          cuerpoError(
            CodigoError.CAJA_APERTURA_NO_ENCONTRADA,
            'No tiene una apertura abierta para cerrar',
          ),
        );
      }
      idApertura = propia.id_apertura;
    }

    const apertura = await this.repo.obtenerAperturaPorId(idApertura);
    if (!apertura) {
      throw new NotFoundException(
        cuerpoError(CodigoError.CAJA_APERTURA_NO_ENCONTRADA, 'Apertura no encontrada'),
      );
    }

    const esAdmin = normalizarRol(usuario?.rol) === 'admin';
    if (apertura.id_usuario != null && apertura.id_usuario !== idUsuario && !esAdmin) {
      throw new ForbiddenException(
        cuerpoError(
          CodigoError.CAJA_CIERRE_NO_PERMITIDO,
          'Solo puede cerrar su propia apertura (o un admin)',
        ),
      );
    }

    try {
      const resumen = await this.repo.resumenTurno(apertura);
      const ocultar = await this.ocultaEsperado(usuario);
      const info: { valor: ResultadoPreparacionCierre | null } = { valor: null };
      const cerrado = await this.repo.cerrar(
        {
          idApertura,
          idUsuario,
          montoConteo: body?.monto_conteo,
          observacion: body?.observacion,
        },
        async (manager) => {
          info.valor = await this.arqueos.prepararCierre(manager, idApertura, {
            idArqueo: body?.id_arqueo,
            montoConteoCuerpo: body?.monto_conteo,
            ocultarEsperado: ocultar,
          });
          return info.valor.preparacion;
        },
      );
      const extra = info.valor;
      // Fase 6.3: un administrador cerró el turno de otro usuario. Después del COMMIT; nunca frena el cierre.
      if (apertura.id_usuario != null && apertura.id_usuario !== idUsuario) {
        await this.bitacora?.registrarCon(() => ({
          accion: ACCIONES_BITACORA.CAJA_CIERRE_AJENO,
          id_usuario: idUsuario,
          rol: usuario?.rol ?? null,
          entidad: 'apertura_caja',
          id_entidad: idApertura,
          antes: { id_usuario_turno: apertura.id_usuario, id_caja: apertura.id_caja, caja: apertura.caja_nombre },
          despues: {
            monto_conteo: body?.monto_conteo ?? null,
            efectivo_esperado: extra?.efectivo_esperado ?? null,
            id_arqueo: extra?.arqueo?.id_arqueo ?? null,
          },
          motivo: body?.observacion ?? null,
        }));
      }
      // Fase 7.3: con el arqueo ciego, quien cierra SIN conteo no recibe el esperado (con conteo, sí: ya contó).
      const oculto = ocultar && cerrado.monto_conteo == null;
      return {
        ...cerrado,
        resumen: this.resumenVisible(resumen, oculto),
        ...(extra?.efectivo_esperado != null && !oculto ? { efectivo_esperado: extra.efectivo_esperado } : {}),
        ...(oculto ? { esperado_oculto: true } : {}),
        ...(extra?.arqueo ? { arqueo: extra.arqueo } : {}),
        ...(extra?.aviso ? { aviso: extra.aviso } : {}),
      };
    } catch (e: any) {
      this.mapError(e);
    }
  }

  /**
   * Fase 7.4: cierra un turno olvidado (lo llama CierreAutomaticoTarea). Sin conteo: cierres_caja.monto_conteo
   * queda NULL (el arqueo por sucursal lo muestra «sin dato», no como faltante) y monto_final guarda el esperado
   * calculado al cerrar, igual que un cierre a mano. Si había un arqueo de cierre vigente sin usar, se toma su
   * conteo (lo hizo el cajero). La observación dice que fue automático; con sql/fase20 además
   * cierres_caja.automatico = TRUE. Devuelve false si el turno ya estaba cerrado (otra réplica o el cajero).
   */
  async cerrarAutomatico(idApertura: number, horas: number): Promise<boolean> {
    const apertura = await this.repo.obtenerAperturaPorId(idApertura);
    if (!apertura) return false;
    const nota = `Cierre automático: el turno llevaba más de ${horas} h abierto y nadie lo cerró.`;
    const info: { valor: ResultadoPreparacionCierre | null } = { valor: null };
    let cerrado;
    try {
      cerrado = await this.repo.cerrar(
        { idApertura, idUsuario: null, montoConteo: null, observacion: `${nota} Sin conteo de efectivo.`, automatico: true },
        async (manager) => {
          info.valor = await this.arqueos.prepararCierre(manager, idApertura, { montoConteoCuerpo: null });
          const prep = info.valor.preparacion;
          // La marca va siempre delante; si se usó el conteo de un arqueo de cierre, su observación se conserva detrás.
          const conteo = prep.montoConteo != null ? 'Conteo tomado del último arqueo de cierre.' : 'Sin conteo de efectivo.';
          return { ...prep, observacion: [nota, conteo, prep.observacion].filter(Boolean).join(' ') };
        },
      );
    } catch (e: any) {
      if (String(e?.message ?? e) === 'CAJA_YA_CERRADA') return false;
      throw e;
    }
    await this.bitacora?.registrarCon(() => ({
      accion: ACCIONES_BITACORA.CAJA_CIERRE_AUTOMATICO,
      id_usuario: null,
      entidad: 'apertura_caja',
      id_entidad: idApertura,
      antes: { id_usuario_turno: apertura.id_usuario, id_caja: apertura.id_caja, caja: apertura.caja_nombre, abierta_desde: apertura.fecha },
      despues: {
        id_cierre: cerrado.id_cierre,
        monto_conteo: cerrado.monto_conteo,
        efectivo_esperado: info.valor?.efectivo_esperado ?? null,
        id_arqueo: info.valor?.arqueo?.id_arqueo ?? null,
        horas,
      },
      motivo: nota,
    }));
    return true;
  }

  /** Para modo estricto en ventas (C4). */
  async usuarioTieneApertura(idUsuario?: number): Promise<boolean> {
    if (!idUsuario) return false;
    return this.repo.tieneAperturaAbiertaUsuario(idUsuario);
  }

  async configEstricto(): Promise<{ modo: 'blando' | 'estricto'; bypassAdmin: boolean }> {
    const [modo, bypassAdmin] = await Promise.all([this.repo.modoCaja(), this.repo.bypassAdminEstricto()]);
    return { modo, bypassAdmin };
  }

  private mapError(e: any): never {
    const code = String(e?.message ?? e);
    if (code === 'CAJA_YA_ABIERTA_USUARIO') {
      throw new BadRequestException(
        cuerpoError(
          CodigoError.CAJA_YA_ABIERTA_USUARIO,
          'Ya tiene una caja abierta. Ciérrela antes de abrir otra.',
        ),
      );
    }
    if (code === 'CAJA_OCUPADA') {
      throw new BadRequestException(
        cuerpoError(
          CodigoError.CAJA_OCUPADA,
          'Esa caja ya está abierta por otro turno. Elija otra o pida que la cierren.',
        ),
      );
    }
    if (code === 'CAJA_DESACTIVADA') {
      throw new ConflictException(
        cuerpoError(CodigoError.CAJA_DESACTIVADA, 'Esa caja está desactivada. Elige otra o pide que la activen.'),
      );
    }
    if (code === 'CAJA_APERTURA_NO_ENCONTRADA') {
      throw new NotFoundException(
        cuerpoError(CodigoError.CAJA_APERTURA_NO_ENCONTRADA, 'Apertura no encontrada'),
      );
    }
    if (code === 'CAJA_YA_CERRADA') {
      throw new BadRequestException(
        cuerpoError(CodigoError.CAJA_YA_CERRADA, 'Esa apertura ya está cerrada'),
      );
    }
    relanzarHttp(e);
  }
}

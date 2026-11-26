import { Injectable, Logger, Optional } from '@nestjs/common';
import { normalizarRol } from '../../config/roles.config';
import { BitacoraService } from '../../bitacora/bitacora.service';
import { ACCIONES_BITACORA } from '../../bitacora/bitacora.acciones';
import { CajaArqueoRepository } from '../../repository/Repository/caja-arqueo.repository';
import { CajaSesionRepository } from '../../repository/Repository/caja-sesion.repository';
import type { TurnoArqueo } from '../../repository/Irepository/ICajaArqueoRepository';
import { Dinero, DineroInvalidoError } from '../dominio/dinero';
import { CalculadoraEsperado } from '../dominio/esperado-caja';
import { CodigoErrorCaja, ErrorCaja } from '../dominio/errores-caja';
import { EsquemaCajaService } from '../esquema/esquema-caja.service';
import { ControlCajaService } from '../configuracion/control-caja.service';
import { ocultaEsperadoA } from '../configuracion/control-caja';
import { DevolucionCajaRepository, EfectivoDeVenta } from './devolucion-caja.repository';
import { calcularReembolsable, descripcionDevolucion, TipoDevolucion } from './reembolso';

/** Quien devuelve el efectivo (el usuario de la petición). */
export interface QuienDevuelve {
  id_usuario: number | null | undefined;
  rol?: string | null;
}

/** Reembolso ya validado antes de anular o emitir la nota: lo que se registrará si la operación sale bien. */
export interface PlanReembolso {
  id_venta: number;
  monto: Dinero;
  tipo: TipoDevolucion;
  id_apertura: number;
  id_usuario: number;
}

/** Resultado de registrar el egreso (o por qué no se registró: la operación principal ya ocurrió). */
export interface ResultadoReembolso {
  registrado: boolean;
  id_movimiento: number | null;
  monto: number;
  id_apertura: number | null;
  aviso: string | null;
}

/** GET /caja/devolucion/:id_venta: lo que el front necesita para proponer el reembolso. */
export interface ReembolsoVentaResponse {
  id_venta: number;
  estado_venta: string;
  /** false sin sql/fase20: mandar `reembolso_efectivo` respondería 503. */
  disponible: boolean;
  efectivo_cobrado: number;
  abonos_efectivo: number;
  /** null sin sql/fase20 (no se puede saber). */
  ya_reembolsado: number | null;
  turno_venta: { id_apertura: number; caja_nombre: string; usuario_nombre: string | null; abierto: boolean; es_mio: boolean } | null;
  venta_en_turno_abierto: boolean;
  /** Máximo de `reembolso_efectivo` al ANULAR (POST venta/:id/anular). 0 = no corresponde egreso. */
  maximo_anulacion: number;
  /** Máximo de `reembolso_efectivo` en una devolución PARCIAL (POST comprobante/:id/nota-credito). */
  maximo_devolucion_parcial: number;
  turno_usuario: { id_apertura: number; caja_nombre: string } | null;
  /** Hay algo que devolver con egreso y el usuario no tiene caja abierta. */
  requiere_abrir_caja: boolean;
  mensaje: string;
}

const CANDADO_SIN_FASE20 =
  'Para registrar la devolución en efectivo falta ejecutar sql/fase20_caja_devoluciones.sql. No se hizo nada: ' +
  'repita la operación sin indicar el reembolso y registre el egreso a mano en Caja.';

/**
 * Devoluciones de efectivo desde la caja (Fase 7.1) y el bloqueo de 7.2.
 *
 * Flujo con `reembolso_efectivo`: `prevalidar` ANTES de anular o emitir la nota (si algo no cuadra no se
 * anula nada); la operación; `registrar` DESPUÉS, en su propia transacción con el candado de la venta y el
 * de la apertura, revalidando. Si el egreso falla después de anular, la anulación queda y se devuelve un
 * aviso para registrarlo a mano (nunca se deshace una anulación ya hecha en SUNAT).
 */
@Injectable()
export class DevolucionCajaService {
  private readonly log = new Logger(DevolucionCajaService.name);

  constructor(
    private readonly repo: DevolucionCajaRepository,
    private readonly arqueos: CajaArqueoRepository,
    private readonly sesiones: CajaSesionRepository,
    private readonly esquema: EsquemaCajaService,
    @Optional() private readonly control?: ControlCajaService,
    @Optional() private readonly bitacora?: BitacoraService,
  ) {}

  // ── 7.2 (D3): anular una venta a crédito con abonos ────────────

  /**
   * Con `anulacion_credito_con_abonos = bloquear` (por defecto) una venta con abonos no se anula: 409 que guía
   * a la nota de crédito y a la devolución de lo abonado. Sin crédito en el esquema, o con `permitir`, pasa.
   */
  async exigirAnulacionCreditoPermitida(idVenta: number): Promise<void> {
    const abonado = await this.repo.abonosDeVenta(idVenta);
    if (!abonado.esPositivo()) return;
    const modo = this.control ? await this.control.modoAnulacionCredito() : 'bloquear';
    if (modo === 'permitir') return;
    throw ErrorCaja.conflicto(
      CodigoErrorCaja.ANULACION_CREDITO_CON_ABONOS,
      `Esta venta a crédito ya tiene abonos por ${abonado.formatear()}. Emita una nota de crédito y registre la devolución de lo abonado.`,
    );
  }

  /** Turno cuyo esperado cuenta la venta (null: sin turno). Para el aviso de la anulación. */
  turnoDeVenta(idVenta: number) {
    return this.repo.turnoDeVenta(idVenta);
  }

  // ── Lectura para el front ─────────────────────────────────────

  async consultar(idVenta: number, usuario: QuienDevuelve): Promise<ReembolsoVentaResponse> {
    const datos = await this.repo.efectivoDeVenta(idVenta);
    if (!datos) throw ErrorCaja.noEncontrado(CodigoErrorCaja.VENTA_NO_ENCONTRADA, `No existe la venta ${idVenta}.`);
    const idUsuario = Number(usuario?.id_usuario) || null;
    const [disponible, propia] = await Promise.all([
      this.esquema.tiene('movimientoVenta'),
      idUsuario ? this.sesiones.sesionUsuario(idUsuario) : Promise.resolve(null),
    ]);
    const anulacion = calcularReembolsable(datos, 'anulacion');
    const parcial = calcularReembolsable(datos, 'parcial');
    const hayQueDevolver = anulacion.maximo.esPositivo() || parcial.maximo.esPositivo();
    return {
      id_venta: datos.id_venta,
      estado_venta: datos.estado,
      disponible,
      efectivo_cobrado: datos.efectivo_venta.aNumero(),
      abonos_efectivo: datos.abonos_efectivo.aNumero(),
      ya_reembolsado: datos.ya_reembolsado ? datos.ya_reembolsado.aNumero() : null,
      turno_venta: datos.turno
        ? {
            id_apertura: datos.turno.id_apertura,
            caja_nombre: datos.turno.caja_nombre,
            usuario_nombre: datos.turno.usuario_nombre,
            abierto: datos.turno.abierto,
            es_mio: idUsuario != null && datos.turno.id_usuario === idUsuario,
          }
        : null,
      venta_en_turno_abierto: anulacion.venta_en_turno_abierto,
      maximo_anulacion: anulacion.maximo.aNumero(),
      maximo_devolucion_parcial: parcial.maximo.aNumero(),
      turno_usuario: propia ? { id_apertura: propia.id_apertura, caja_nombre: propia.caja_nombre } : null,
      requiere_abrir_caja: hayQueDevolver && !propia,
      mensaje: this.mensajeLectura(datos, anulacion.venta_en_turno_abierto, anulacion.descontado_por_anulacion),
    };
  }

  private mensajeLectura(datos: EfectivoDeVenta, enTurnoAbierto: boolean, descontado: Dinero): string {
    if (datos.efectivo_venta.esCero() && datos.abonos_efectivo.esCero()) {
      return 'La venta no se cobró en efectivo: devolverla no mueve la caja.';
    }
    if (enTurnoAbierto && descontado.esPositivo()) {
      const caja = datos.turno ? ` (${datos.turno.caja_nombre}${datos.turno.usuario_nombre ? `, turno de ${datos.turno.usuario_nombre}` : ''})` : '';
      return `La venta es de un turno abierto${caja}: al anularla, su efectivo esperado ya baja ${descontado.formatear()}. ` +
        'No registre un egreso por ese monto; entregue el dinero desde esa caja.';
    }
    return 'La venta es de un turno ya cerrado (o no tuvo turno): lo que devuelva en efectivo sale de su caja abierta como egreso.';
  }

  // ── Antes de la operación ─────────────────────────────────────

  /**
   * null si no se pidió reembolso (todo como antes). Si se pidió, valida TODO antes de anular o emitir:
   * formato, sql/fase20, venta, máximo reembolsable (y `limite`, el total de la nota), turno abierto del
   * usuario y que haya ese efectivo en su caja. Lanza ErrorCaja (la capa que llama lo traduce a HTTP).
   */
  async prevalidar(
    idVenta: number,
    montoCrudo: unknown,
    tipo: TipoDevolucion,
    usuario: QuienDevuelve,
    limite?: { monto: Dinero; texto: string },
  ): Promise<PlanReembolso | null> {
    if (montoCrudo === undefined || montoCrudo === null) return null;
    const monto = this.leerMonto(montoCrudo);
    if (monto.esCero()) return null;

    if (!(await this.esquema.tiene('movimientoVenta'))) {
      throw new ErrorCaja(CodigoErrorCaja.REEMBOLSO_NO_DISPONIBLE, CANDADO_SIN_FASE20, 503);
    }
    const datos = await this.repo.efectivoDeVenta(idVenta);
    if (!datos) throw ErrorCaja.noEncontrado(CodigoErrorCaja.VENTA_NO_ENCONTRADA, `No existe la venta ${idVenta}.`);
    this.exigirDentroDelMaximo(datos, tipo, monto);
    if (limite && monto.mayorQue(limite.monto)) {
      throw ErrorCaja.datoInvalido(
        `La devolución en efectivo (${monto.formatear()}) supera ${limite.texto} (${limite.monto.formatear()}).`,
        CodigoErrorCaja.REEMBOLSO_EXCEDE,
      );
    }

    const idUsuario = Number(usuario?.id_usuario);
    const propia = idUsuario ? await this.sesiones.sesionUsuario(idUsuario) : null;
    if (!propia) {
      throw ErrorCaja.conflicto(
        CodigoErrorCaja.CAJA_NO_ABIERTA,
        `Para devolver ${monto.formatear()} en efectivo abra su caja: el egreso sale de su turno. No se hizo nada.`,
      );
    }
    const turno = await this.arqueos.turno(propia.id_apertura);
    if (!turno || !turno.abierta) {
      throw ErrorCaja.conflicto(CodigoErrorCaja.CAJA_NO_ABIERTA, 'Su turno de caja ya no está abierto. Abra su caja y vuelva a intentarlo.');
    }
    await this.exigirEfectivoEnCaja(turno, monto, usuario);
    return { id_venta: idVenta, monto, tipo, id_apertura: turno.id_apertura, id_usuario: idUsuario };
  }

  // ── Después de la operación ───────────────────────────────────

  /**
   * Registra el egreso en el turno del plan, revalidando con los candados tomados (venta → apertura). Nunca
   * lanza: la operación principal ya ocurrió; si no se puede, devuelve el aviso para hacerlo a mano.
   */
  async registrar(plan: PlanReembolso, usuario: QuienDevuelve, detalle?: string | null): Promise<ResultadoReembolso> {
    const descripcion = descripcionDevolucion(plan.id_venta, detalle);
    try {
      const id = await this.arqueos.transaccion(async (manager) => {
        await this.repo.bloquearReembolso(manager, plan.id_venta);
        if (!(await this.sesiones.bloquearApertura(manager, plan.id_apertura))) {
          throw ErrorCaja.noEncontrado(CodigoErrorCaja.CAJA_APERTURA_NO_ENCONTRADA, `No existe el turno ${plan.id_apertura}.`);
        }
        const turno = await this.arqueos.turno(plan.id_apertura, manager);
        if (!turno || !turno.abierta) {
          throw ErrorCaja.conflicto(CodigoErrorCaja.ARQUEO_TURNO_CERRADO, 'Su turno de caja se cerró antes de registrar la devolución.');
        }
        const datos = await this.repo.efectivoDeVenta(plan.id_venta, manager);
        if (!datos) throw ErrorCaja.noEncontrado(CodigoErrorCaja.VENTA_NO_ENCONTRADA, `No existe la venta ${plan.id_venta}.`);
        this.exigirDentroDelMaximo(datos, plan.tipo, plan.monto);
        await this.exigirEfectivoEnCaja(turno, plan.monto, usuario, manager);
        const conCategoria = (await this.esquema.snapshot()).tieneColumna('movimientos_caja', 'categoria');
        return this.arqueos.registrarMovimiento(manager, {
          id_apertura: turno.id_apertura,
          id_caja: turno.id_caja,
          id_usuario: plan.id_usuario,
          tipo: 'egreso',
          monto: plan.monto,
          descripcion,
          id_venta: plan.id_venta,
          categoria: conCategoria ? 'devolucion' : null,
        });
      });
      await this.bitacora?.registrarCon(() => ({
        accion: ACCIONES_BITACORA.CAJA_DEVOLUCION_EFECTIVO,
        id_usuario: plan.id_usuario,
        rol: usuario?.rol ?? null,
        entidad: 'venta',
        id_entidad: plan.id_venta,
        despues: { id_movimiento: id, id_apertura: plan.id_apertura, monto: plan.monto.aNumero(), tipo: plan.tipo },
        motivo: descripcion,
      }));
      this.log.log(`Egreso ${id}: ${descripcion} por ${plan.monto.formatear()} en el turno ${plan.id_apertura}.`);
      return { registrado: true, id_movimiento: id, monto: plan.monto.aNumero(), id_apertura: plan.id_apertura, aviso: null };
    } catch (error) {
      const motivo = (error as Error)?.message ?? String(error);
      this.log.error(`No se registró el egreso de la venta ${plan.id_venta} (${plan.monto.formatear()}): ${motivo}`);
      return {
        registrado: false,
        id_movimiento: null,
        monto: plan.monto.aNumero(),
        id_apertura: plan.id_apertura,
        aviso: `No se pudo registrar en Caja la devolución de ${plan.monto.formatear()} (${motivo}). Regístrela a mano como egreso de su turno.`,
      };
    }
  }

  // ── Interno ───────────────────────────────────────────────────

  private leerMonto(crudo: unknown): Dinero {
    const n = typeof crudo === 'number' ? crudo : typeof crudo === 'string' && crudo.trim() !== '' ? Number(crudo) : NaN;
    const invalido = (m: string) => ErrorCaja.datoInvalido(m, CodigoErrorCaja.REEMBOLSO_INVALIDO);
    if (!Number.isFinite(n)) throw invalido('El reembolso en efectivo debe ser un número.');
    if (n < 0) throw invalido('El reembolso en efectivo no puede ser negativo.');
    try {
      return Dinero.deSoles(n);
    } catch (error) {
      if (error instanceof DineroInvalidoError) throw invalido('El reembolso en efectivo admite como máximo 2 decimales.');
      throw error;
    }
  }

  private exigirDentroDelMaximo(datos: EfectivoDeVenta, tipo: TipoDevolucion, monto: Dinero): void {
    const calculo = calcularReembolsable(datos, tipo);
    if (!monto.mayorQue(calculo.maximo)) return;
    const partes = [`lo cobrado en efectivo es ${datos.efectivo_venta.sumar(datos.abonos_efectivo).formatear()}`];
    if (datos.ya_reembolsado?.esPositivo()) partes.push(`ya se devolvió ${datos.ya_reembolsado.formatear()}`);
    if (calculo.descontado_por_anulacion.esPositivo()) {
      partes.push(
        `la venta es de un turno abierto y al anularla su efectivo esperado ya baja ${calculo.descontado_por_anulacion.formatear()} (no lleva egreso)`,
      );
    }
    throw ErrorCaja.datoInvalido(
      `La devolución en efectivo (${monto.formatear()}) supera lo que se puede devolver de la venta ${datos.id_venta} ` +
        `(máximo ${calculo.maximo.formatear()}): ${partes.join('; ')}. No se hizo nada.`,
      CodigoErrorCaja.REEMBOLSO_EXCEDE,
    );
  }

  /** El egreso no puede superar el efectivo esperado del turno (misma regla que POST caja/movimientos). */
  private async exigirEfectivoEnCaja(turno: TurnoArqueo, monto: Dinero, usuario: QuienDevuelve, manager?: Parameters<CajaArqueoRepository['filasEsperado']>[1]): Promise<void> {
    const filas = await this.arqueos.filasEsperado(turno.id_apertura, manager);
    const disponible = CalculadoraEsperado.calcular(turno.monto_inicial, filas).efectivo.esperado;
    if (!monto.mayorQue(disponible)) return;
    const ocultar = this.control ? ocultaEsperadoA(normalizarRol(usuario?.rol), await this.control.arqueoCiego()) : false;
    throw ErrorCaja.conflicto(
      CodigoErrorCaja.CAJA_EGRESO_EXCEDE_EFECTIVO,
      ocultar
        ? `La devolución de ${monto.formatear()} supera el efectivo que debería haber en su caja. No se hizo nada.`
        : `La devolución de ${monto.formatear()} supera el efectivo que debería haber en su caja (${disponible.formatear()}). No se hizo nada.`,
    );
  }
}

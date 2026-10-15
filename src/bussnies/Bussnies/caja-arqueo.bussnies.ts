import { Injectable, Logger } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import type { UsuarioToken } from '../../guards/usuario-actual.decorator';
import { normalizarRol } from '../../config/roles.config';
import { CLAVES_EMISOR, emisorConfig } from '../../config/emisor.config';
import { CajaArqueoRepository } from '../../repository/Repository/caja-arqueo.repository';
import { CajaSesionRepository } from '../../repository/Repository/caja-sesion.repository';
import { CreditoRepository } from '../../repository/Repository/credito.repository';
import { ConfiguracionRepository } from '../../repository/Repository/configuracion.repository';
import type { ArqueoGuardado, TurnoArqueo } from '../../repository/Irepository/ICajaArqueoRepository';
import { EsquemaCajaService } from '../../caja/esquema/esquema-caja.service';
import { Dinero } from '../../caja/dominio/dinero';
import { ConteoEfectivo } from '../../caja/dominio/denominaciones';
import { CalculadoraEsperado, EsperadoCaja } from '../../caja/dominio/esperado-caja';
import { Conciliador, ResultadoConciliacion, TOLERANCIA_MAXIMA } from '../../caja/dominio/conciliacion';
import { categoriaMetodo, seConciliaPorDeclaracion } from '../../caja/dominio/metodo-pago';
import { CodigoErrorCaja, ErrorCaja } from '../../caja/dominio/errores-caja';
import { codigoPg, relanzarHttp } from '../../caja/http/errores-caja.http';
import {
  arqueoDetalleResponse,
  arqueoResumenResponse,
  codigoArqueo,
  denominacionesValidas,
  efectivoResponse,
  metodoEsperadoResponse,
  movimientoResponse,
  resumenMetodosJson,
  turnoResponse,
} from '../../caja/arqueo/arqueo-presentacion';
import { MovimientoCajaRequest } from '../../models/model/caja.request';
import { RegistrarArqueoRequest } from '../../models/model/caja-arqueo.request';
import type {
  ArqueoDetalleResponse,
  ArqueoEsperadoResponse,
  ArqueoResumenResponse,
  MovimientoCajaResponse,
  MovimientosTurnoResponse,
  TurnoArqueoResponse,
} from '../../models/model/caja-arqueo.response';
import { FormatoArqueoPdf, generarArqueoPdf, nombreArchivoArqueo } from '../../util/documentos/arqueo-pdf';
import { obtenerLogoEmisor } from '../../util/documentos/logo-emisor';
import { ICajaArqueoBussniees, ResultadoPreparacionCierre } from '../Ibussnies/ICajaArqueoBussniees';

const LARGO_MINIMO_OBSERVACION = 5;
const CLAVE_TOLERANCIA = 'caja_arqueo_tolerancia';

function esAdmin(usuario?: UsuarioToken): boolean {
  return normalizarRol(usuario?.rol) === 'admin';
}

/**
 * Control del efectivo del turno: efectivo esperado, arqueos parciales y de cierre,
 * ingresos/egresos y el comprobante imprimible. Las cuentas las hacen las clases de dominio
 * (CalculadoraEsperado, ConteoEfectivo, Conciliador) en céntimos; aquí solo se orquesta.
 *
 * Orden de candados: la fila de la apertura (FOR UPDATE) primero, igual que el cierre, así
 * un arqueo, un egreso y el cierre del mismo turno nunca se cruzan.
 */
@Injectable()
export class CajaArqueoBussnies implements ICajaArqueoBussniees {
  private readonly log = new Logger(CajaArqueoBussnies.name);

  constructor(
    private readonly repo: CajaArqueoRepository,
    private readonly sesiones: CajaSesionRepository,
    private readonly creditoRepo: CreditoRepository,
    private readonly config: ConfiguracionRepository,
    private readonly esquema: EsquemaCajaService,
  ) {}

  // ── Consultas ────────────────────────────────────────────────

  async esperado(usuario: UsuarioToken, idApertura?: number): Promise<ArqueoEsperadoResponse> {
    try {
      await this.esquema.exigir('arqueo');
      const turno = await this.turnoAutorizado(usuario, idApertura);
      const [esperado, metodos, tolerancia, ultimos] = await Promise.all([
        this.calcularEsperado(turno),
        this.creditoRepo.metodosConTipo(),
        this.tolerancia(),
        this.repo.listarPorTurno(turno.id_apertura, 1),
      ]);
      return {
        apertura: turnoResponse(turno),
        efectivo: efectivoResponse(esperado.efectivo),
        otros_medios: esperado.otros_medios.map(metodoEsperadoResponse),
        credito: { ventas: esperado.credito.ventas.aNumero(), operaciones: esperado.credito.operaciones },
        ventas_web: { total: esperado.ventas_web.total.aNumero(), cantidad: esperado.ventas_web.cantidad },
        ventas_anuladas: { total: esperado.ventas_anuladas.total.aNumero(), cantidad: esperado.ventas_anuladas.cantidad },
        total_cobrado: esperado.total_cobrado.aNumero(),
        denominaciones: denominacionesValidas(),
        medios_declarables: metodos
          .map((m) => ({ id_metodo: m.id_metodo, nombre: m.nombre, categoria: categoriaMetodo(m.tipo, m.nombre) }))
          .filter((m) => seConciliaPorDeclaracion(m.categoria)),
        tolerancia: tolerancia.aNumero(),
        ultimo_arqueo: ultimos[0] ? arqueoResumenResponse(ultimos[0]) : null,
        generado_en: new Date().toISOString(),
      };
    } catch (error) {
      relanzarHttp(error);
    }
  }

  async listar(
    usuario: UsuarioToken,
    idApertura?: number,
    limite = 50,
  ): Promise<{ apertura: TurnoArqueoResponse; items: ArqueoResumenResponse[] }> {
    try {
      await this.esquema.exigir('arqueo');
      const turno = await this.turnoAutorizado(usuario, idApertura);
      const items = await this.repo.listarPorTurno(turno.id_apertura, Math.min(Math.max(limite, 1), 200));
      return { apertura: turnoResponse(turno), items: items.map(arqueoResumenResponse) };
    } catch (error) {
      relanzarHttp(error);
    }
  }

  async obtener(usuario: UsuarioToken, idArqueo: number): Promise<ArqueoDetalleResponse> {
    try {
      await this.esquema.exigir('arqueo');
      return await this.detalle(usuario, idArqueo);
    } catch (error) {
      relanzarHttp(error);
    }
  }

  async pdf(usuario: UsuarioToken, idArqueo: number, formato: FormatoArqueoPdf) {
    try {
      await this.esquema.exigir('arqueo');
      const arqueo = await this.detalle(usuario, idArqueo);
      const emisor = await this.emisor(formato === 'a4');
      const buffer = await generarArqueoPdf({ arqueo, emisor, formato });
      return { buffer, nombreArchivo: nombreArchivoArqueo(arqueo, formato) };
    } catch (error) {
      relanzarHttp(error);
    }
  }

  // ── Registrar arqueo ─────────────────────────────────────────

  async registrar(usuario: UsuarioToken, dto: RegistrarArqueoRequest): Promise<ArqueoDetalleResponse> {
    const clave = dto.clave_idempotencia?.trim() || null;
    try {
      await this.esquema.exigir('arqueo');
      if (clave) {
        const existente = await this.repo.buscarPorClave(clave);
        if (existente) return { ...(await this.detalle(usuario, existente)), idempotente: true };
      }

      const turnoInicial = await this.turnoAutorizado(usuario, dto.id_apertura);
      const conteo = this.leerConteo(dto);
      const declaraciones = (dto.medios ?? []).map((m) => ({ id_metodo: Number(m.id_metodo), declarado: Dinero.deSoles(m.declarado) }));
      const observacion = dto.observacion?.trim() || null;
      const [metodos, tolerancia] = await Promise.all([this.creditoRepo.metodosConTipo(), this.tolerancia()]);

      const idArqueo = await this.repo.transaccion(async (manager) => {
        const turno = await this.turnoBloqueado(manager, turnoInicial.id_apertura);
        if (!turno.abierta) {
          throw ErrorCaja.conflicto(
            CodigoErrorCaja.ARQUEO_TURNO_CERRADO,
            'El turno ya está cerrado: no se pueden registrar más arqueos.',
          );
        }
        if (clave) {
          const ya = await this.repo.buscarPorClave(clave, manager);
          if (ya) return ya;
        }
        const esperado = await this.calcularEsperado(turno, manager);
        const conciliacion = Conciliador.conciliar(esperado, conteo.contado, declaraciones, metodos, tolerancia);
        this.exigirObservacion(conciliacion, observacion);

        return this.repo.insertar(manager, {
          id_apertura: turno.id_apertura,
          id_caja: turno.id_caja,
          id_usuario: Number(usuario.id_usuario),
          tipo: dto.tipo,
          monto_inicial: turno.monto_inicial,
          efectivo_esperado: esperado.efectivo.esperado,
          efectivo_contado: conteo.contado,
          diferencia: conteo.contado.restar(esperado.efectivo.esperado),
          resumen_metodos: resumenMetodosJson(esperado, conciliacion, tolerancia),
          observacion,
          conteo_por_denominaciones: conteo.porDenominaciones,
          clave_idempotencia: clave,
          denominaciones: conteo.efectivo.lineas,
        });
      });

      const detalle = await this.detalle(usuario, idArqueo);
      this.log.log(`Arqueo ${detalle.codigo} (${detalle.tipo}) del turno ${detalle.id_apertura}: ${detalle.resumen}`);
      return detalle;
    } catch (error) {
      if (clave && codigoPg(error) === '23505') {
        const existente = await this.repo.buscarPorClave(clave).catch(() => null);
        if (existente) return { ...(await this.detalle(usuario, existente)), idempotente: true };
      }
      relanzarHttp(error);
    }
  }

  // ── Ingresos y egresos de efectivo ───────────────────────────

  async registrarMovimiento(usuario: UsuarioToken, dto: MovimientoCajaRequest): Promise<MovimientoCajaResponse> {
    try {
      await this.esquema.exigir('movimientosPorTurno');
      const monto = Dinero.deSoles(dto.monto);
      const descripcion = String(dto.descripcion ?? '').trim();
      if (!monto.esPositivo()) {
        throw ErrorCaja.datoInvalido('El monto debe ser mayor a 0.', CodigoErrorCaja.CAJA_MOVIMIENTO_INVALIDO);
      }
      if (descripcion.length < 3) {
        throw ErrorCaja.datoInvalido('Indique el motivo del movimiento (mínimo 3 caracteres).', CodigoErrorCaja.CAJA_MOVIMIENTO_INVALIDO);
      }
      const turnoInicial = await this.turnoAutorizado(usuario, dto.id_apertura);

      const { id, turno } = await this.repo.transaccion(async (manager) => {
        const turno = await this.turnoBloqueado(manager, turnoInicial.id_apertura);
        if (!turno.abierta) {
          throw ErrorCaja.conflicto(CodigoErrorCaja.ARQUEO_TURNO_CERRADO, 'El turno está cerrado: no se pueden registrar movimientos.');
        }
        if (dto.tipo === 'egreso') {
          const disponible = (await this.calcularEsperado(turno, manager)).efectivo.esperado;
          if (monto.mayorQue(disponible)) {
            throw ErrorCaja.conflicto(
              CodigoErrorCaja.CAJA_EGRESO_EXCEDE_EFECTIVO,
              `El egreso de ${monto.formatear()} supera el efectivo que debería haber en caja (${disponible.formatear()}).`,
            );
          }
        }
        const id = await this.repo.registrarMovimiento(manager, {
          id_apertura: turno.id_apertura,
          id_caja: turno.id_caja,
          id_usuario: Number(usuario.id_usuario),
          tipo: dto.tipo,
          monto,
          descripcion: descripcion.slice(0, 200),
        });
        return { id, turno };
      });

      return movimientoResponse({
        id_movimiento: id,
        id_apertura: turno.id_apertura,
        id_caja: turno.id_caja,
        tipo: dto.tipo,
        monto,
        descripcion: descripcion.slice(0, 200),
        fecha: new Date(),
        id_usuario: Number(usuario.id_usuario),
        usuario_nombre: usuario.nombre ?? null,
      });
    } catch (error) {
      relanzarHttp(error);
    }
  }

  async listarMovimientos(usuario: UsuarioToken, idApertura?: number, limite = 100): Promise<MovimientosTurnoResponse> {
    try {
      await this.esquema.exigir('movimientosPorTurno');
      const turno = await this.turnoAutorizado(usuario, idApertura);
      const items = await this.repo.listarMovimientos(turno.id_apertura, Math.min(Math.max(limite, 1), 200));
      const suma = (tipo: 'ingreso' | 'egreso') =>
        Dinero.sumarTodos(items.filter((m) => m.tipo === tipo).map((m) => m.monto)).aNumero();
      return {
        apertura: turnoResponse(turno),
        items: items.map(movimientoResponse),
        total_ingresos: suma('ingreso'),
        total_egresos: suma('egreso'),
      };
    } catch (error) {
      relanzarHttp(error);
    }
  }

  // ── Integración con el cierre (POST /caja/cerrar) ────────────

  /**
   * Se ejecuta DENTRO de la transacción del cierre, con la apertura ya bloqueada:
   * calcula el efectivo esperado (monto_final) y, si hay arqueo de cierre, toma su conteo.
   * Sin arqueo, el cierre funciona exactamente como antes.
   */
  async prepararCierre(
    manager: EntityManager,
    idApertura: number,
    opciones: { idArqueo?: number; montoConteoCuerpo?: number | null },
  ): Promise<ResultadoPreparacionCierre> {
    const resultado: ResultadoPreparacionCierre = { preparacion: {}, efectivo_esperado: null, arqueo: null };
    const turno = await this.repo.turno(idApertura, manager);
    // El esperado es informativo para el cierre: si falla, se deshace solo ese cálculo (SAVEPOINT).
    const esperado = turno ? await this.repo.conSavepoint(manager, () => this.calcularEsperado(turno, manager)) : null;
    if (esperado) {
      resultado.efectivo_esperado = esperado.efectivo.esperado.aNumero();
      resultado.preparacion.montoFinal = esperado.efectivo.esperado.aTexto();
    }

    const conArqueo = await this.esquema.tiene('arqueo');
    if (opciones.idArqueo != null) {
      if (!conArqueo) throw ErrorCaja.esquemaPendiente('falta la tabla caja_arqueos');
      const arqueo = await this.repo.obtener(opciones.idArqueo, manager);
      this.validarArqueoDeCierre(arqueo, idApertura);
      if (esperado && !arqueo!.efectivo_esperado.igual(esperado.efectivo.esperado)) {
        throw ErrorCaja.conflicto(
          CodigoErrorCaja.ARQUEO_NO_APLICA_CIERRE,
          `El arqueo ${codigoArqueo(arqueo!.id_arqueo)} quedó desactualizado: el efectivo esperado cambió de ` +
            `${arqueo!.efectivo_esperado.formatear()} a ${esperado.efectivo.esperado.formatear()} por movimientos posteriores. ` +
            'Registre un nuevo arqueo de cierre.',
        );
      }
      return this.usarArqueo(resultado, arqueo!);
    }

    if (conArqueo && opciones.montoConteoCuerpo == null) {
      const ultimo = await this.repo.ultimoDeCierre(manager, idApertura);
      if (ultimo && !ultimo.id_cierre) {
        if (esperado && !ultimo.efectivo_esperado.igual(esperado.efectivo.esperado)) {
          resultado.aviso =
            `No se usó el arqueo ${codigoArqueo(ultimo.id_arqueo)}: hubo movimientos después del conteo ` +
            `(esperado ${ultimo.efectivo_esperado.formatear()} → ${esperado.efectivo.esperado.formatear()}).`;
          return resultado;
        }
        return this.usarArqueo(resultado, ultimo);
      }
    }
    return resultado;
  }

  // ── Interno ──────────────────────────────────────────────────

  private usarArqueo(resultado: ResultadoPreparacionCierre, arqueo: ArqueoGuardado): ResultadoPreparacionCierre {
    resultado.preparacion.montoConteo = arqueo.efectivo_contado.aNumero();
    if (arqueo.observacion) resultado.preparacion.observacion = arqueo.observacion;
    resultado.preparacion.alCerrar = (m, idCierre) => this.repo.vincularCierre(m, arqueo.id_arqueo, idCierre);
    resultado.arqueo = arqueoResumenResponse(arqueo);
    return resultado;
  }

  private validarArqueoDeCierre(arqueo: ArqueoGuardado | null, idApertura: number): void {
    if (!arqueo || arqueo.id_apertura !== idApertura) {
      throw ErrorCaja.conflicto(CodigoErrorCaja.ARQUEO_NO_APLICA_CIERRE, 'El arqueo indicado no pertenece a este turno.');
    }
    if (arqueo.tipo !== 'cierre') {
      throw ErrorCaja.conflicto(
        CodigoErrorCaja.ARQUEO_NO_APLICA_CIERRE,
        'Para cerrar el turno use un arqueo de tipo "cierre" (el indicado es parcial).',
      );
    }
    if (arqueo.id_cierre) {
      throw ErrorCaja.conflicto(CodigoErrorCaja.ARQUEO_NO_APLICA_CIERRE, 'Ese arqueo ya se usó en un cierre.');
    }
  }

  /** Turno abierto del usuario, o el indicado si es suyo (o si es admin). */
  private async turnoAutorizado(usuario: UsuarioToken, idApertura?: number): Promise<TurnoArqueo> {
    const idUsuario = Number(usuario?.id_usuario);
    if (!idUsuario) throw ErrorCaja.prohibido(CodigoErrorCaja.CAJA_TURNO_AJENO, 'Sesión inválida.');
    let id = idApertura;
    if (!id) {
      const propia = await this.sesiones.sesionUsuario(idUsuario);
      if (!propia) {
        throw ErrorCaja.noEncontrado(
          CodigoErrorCaja.CAJA_NO_ABIERTA,
          'No tiene una caja abierta. Abra un turno o indique id_apertura.',
        );
      }
      id = propia.id_apertura;
    }
    const turno = await this.repo.turno(id);
    if (!turno) throw ErrorCaja.noEncontrado(CodigoErrorCaja.CAJA_APERTURA_NO_ENCONTRADA, `No existe el turno ${id}.`);
    if (!esAdmin(usuario) && turno.id_usuario !== idUsuario) {
      throw ErrorCaja.prohibido(
        CodigoErrorCaja.CAJA_TURNO_AJENO,
        'Solo puede consultar o arquear su propio turno (o un administrador).',
      );
    }
    return turno;
  }

  private async turnoBloqueado(manager: EntityManager, idApertura: number): Promise<TurnoArqueo> {
    if (!(await this.sesiones.bloquearApertura(manager, idApertura))) {
      throw ErrorCaja.noEncontrado(CodigoErrorCaja.CAJA_APERTURA_NO_ENCONTRADA, `No existe el turno ${idApertura}.`);
    }
    const turno = await this.repo.turno(idApertura, manager);
    if (!turno) throw ErrorCaja.noEncontrado(CodigoErrorCaja.CAJA_APERTURA_NO_ENCONTRADA, `No existe el turno ${idApertura}.`);
    return turno;
  }

  private async calcularEsperado(turno: TurnoArqueo, manager?: EntityManager): Promise<EsperadoCaja> {
    const filas = await this.repo.filasEsperado(turno.id_apertura, manager);
    return CalculadoraEsperado.calcular(turno.monto_inicial, filas);
  }

  /** configuraciones.caja_arqueo_tolerancia (soles, 0 por defecto, máximo S/ 5.00). */
  private async tolerancia(): Promise<Dinero> {
    const valor = await this.config.obtenerNumero(CLAVE_TOLERANCIA, 0);
    if (!(valor > 0)) return Dinero.CERO;
    const t = Dinero.desdeNumeroRedondeado(Math.min(valor, TOLERANCIA_MAXIMA.aNumero()));
    return t.mayorQue(TOLERANCIA_MAXIMA) ? TOLERANCIA_MAXIMA : t;
  }

  private leerConteo(dto: RegistrarArqueoRequest): { contado: Dinero; efectivo: ConteoEfectivo; porDenominaciones: boolean } {
    const declarado = dto.efectivo_contado != null ? Dinero.deSoles(dto.efectivo_contado) : null;
    if (dto.denominaciones && dto.denominaciones.length > 0) {
      const efectivo = ConteoEfectivo.desde(dto.denominaciones);
      const total = efectivo.total();
      if (declarado && !declarado.igual(total)) {
        throw ErrorCaja.datoInvalido(
          `La suma de las denominaciones (${total.formatear()}) no coincide con el efectivo contado (${declarado.formatear()}).`,
        );
      }
      return { contado: total, efectivo, porDenominaciones: true };
    }
    if (!declarado) {
      throw ErrorCaja.datoInvalido('Indique el conteo por denominaciones o el efectivo contado.');
    }
    return { contado: declarado, efectivo: ConteoEfectivo.vacio(), porDenominaciones: false };
  }

  private exigirObservacion(conciliacion: ResultadoConciliacion, observacion: string | null): void {
    if (!conciliacion.hay_diferencia) return;
    if ((observacion ?? '').length >= LARGO_MINIMO_OBSERVACION) return;
    throw ErrorCaja.datoInvalido(
      `Hay diferencias: ${conciliacion.resumen}. Explique el motivo en la observación (mínimo ${LARGO_MINIMO_OBSERVACION} caracteres).`,
      CodigoErrorCaja.ARQUEO_OBSERVACION_REQUERIDA,
    );
  }

  /** Detalle con control de acceso: dueño del turno, autor del arqueo o admin. */
  private async detalle(usuario: UsuarioToken, idArqueo: number): Promise<ArqueoDetalleResponse> {
    const arqueo = await this.repo.obtener(idArqueo);
    if (!arqueo) throw ErrorCaja.noEncontrado(CodigoErrorCaja.ARQUEO_NO_ENCONTRADO, `No existe el arqueo ${idArqueo}.`);
    const turno = await this.repo.turno(arqueo.id_apertura);
    const idUsuario = Number(usuario?.id_usuario);
    const permitido = esAdmin(usuario) || arqueo.id_usuario === idUsuario || turno?.id_usuario === idUsuario;
    if (!permitido) {
      throw ErrorCaja.prohibido(CodigoErrorCaja.CAJA_TURNO_AJENO, 'Solo puede ver los arqueos de su propio turno (o un administrador).');
    }
    return arqueoDetalleResponse(arqueo, turno);
  }

  private async emisor(conLogo: boolean) {
    let valores: Record<string, string | null> = {};
    try {
      valores = await this.config.obtenerVarias([...CLAVES_EMISOR]);
    } catch (error: any) {
      this.log.warn(`No se pudo leer el emisor para el arqueo (${error?.message ?? error}); se usan los datos por defecto.`);
    }
    const dato = (clave: string, porDefecto: string) => String(valores[clave] ?? '').trim() || porDefecto;
    const logoUrl = dato('emisor_logo_url', emisorConfig.logo_url);
    return {
      razon_social: dato('emisor_razon_social', emisorConfig.razon_social),
      ruc: dato('emisor_ruc', emisorConfig.ruc),
      direccion: dato('emisor_direccion', emisorConfig.direccion),
      // obtenerLogoEmisor nunca lanza: sin logo el PDF sale igual.
      logo: conLogo ? await obtenerLogoEmisor(logoUrl) : null,
    };
  }
}

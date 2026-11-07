import { Injectable, Logger, Optional } from '@nestjs/common';
import type { UsuarioToken } from '../../guards/usuario-actual.decorator';
import { normalizarRol } from '../../config/roles.config';
import { CajaSesionRepository } from '../../repository/Repository/caja-sesion.repository';
import type { FilaTurno, FiltroTurnos } from '../../repository/Repository/caja-sesion.repository';
import { CajaArqueoRepository } from '../../repository/Repository/caja-arqueo.repository';
import { Dinero } from '../../caja/dominio/dinero';
import { CalculadoraEsperado, EsperadoCaja } from '../../caja/dominio/esperado-caja';
import { CodigoErrorCaja, ErrorCaja } from '../../caja/dominio/errores-caja';
import { relanzarHttp } from '../../caja/http/errores-caja.http';
import { hoyLima, parsearFiltroFechasLima } from '../../util/fecha-lima';
import { ConfiguracionRepository } from '../../repository/Repository/configuracion.repository';
import { emisorConfig } from '../../config/emisor.config';
import { obtenerLogoEmisor } from '../../util/documentos/logo-emisor';
import {
  FilaResumenCajaPdf,
  generarResumenCajaPdf,
  nombreArchivoResumenCaja,
} from '../../util/documentos/resumen-caja-pdf';

const POR_PAGINA_DEFECTO = 20;
const POR_PAGINA_MAXIMO = 100;
const MAX_DIAS_RANGO = 366;
/** Turnos cuyo esperado se calcula a la vez (cada uno es una consulta; no se agota el pool). */
const CONCURRENCIA_ESPERADO = 4;
const NOMBRE_SIN_SUCURSAL = 'Sin sucursal';

export interface ConsultaAperturas {
  id_sucursal?: number;
  id_caja?: number;
  id_usuario?: number;
  desde?: string;
  hasta?: string;
  pagina?: number;
  por_pagina?: number;
}

export interface ConsultaResumen {
  desde?: string;
  hasta?: string;
  /** Solo esa sucursal (el total pasa a ser el de ella). */
  id_sucursal?: number;
}

export interface AperturaListada {
  id_apertura: number;
  id_caja: number;
  caja_nombre: string;
  id_sucursal: number | null;
  sucursal_nombre: string | null;
  id_usuario: number | null;
  usuario_nombre: string | null;
  abierta_en: string | null;
  cerrada_en: string | null;
  /** null = turno antiguo sin dato (no es 0.00). */
  monto_inicial: number | null;
  efectivo_esperado: number | null;
  efectivo_contado: number | null;
  diferencia: number | null;
  estado: 'abierto' | 'cerrado';
}

export interface ResumenSucursal {
  id_sucursal: number | null;
  nombre: string;
  turnos: number;
  turnos_abiertos: number;
  /** null si ningún turno del grupo tiene monto inicial guardado (turnos antiguos): «sin dato», no 0. */
  efectivo_inicial: number | null;
  ventas_total: number;
  por_metodo: { metodo: string; monto: number }[];
  efectivo_esperado: number;
  efectivo_contado: number;
  diferencia: number;
}

class Acumulado {
  turnos = 0;
  abiertos = 0;
  inicial = Dinero.CERO;
  /** Turnos que sí guardaron su monto inicial. */
  conInicial = 0;
  ventas = Dinero.CERO;
  esperado = Dinero.CERO;
  contado = Dinero.CERO;
  diferencia = Dinero.CERO;
  readonly metodos = new Map<string, { metodo: string; monto: Dinero }>();

  constructor(
    readonly id_sucursal: number | null,
    readonly nombre: string,
  ) {}

  sumarMetodo(clave: string, metodo: string, monto: Dinero): void {
    if (monto.esCero()) return;
    const actual = this.metodos.get(clave);
    this.metodos.set(clave, { metodo, monto: (actual?.monto ?? Dinero.CERO).sumar(monto) });
    this.ventas = this.ventas.sumar(monto);
  }

  absorber(otro: Acumulado): void {
    this.turnos += otro.turnos;
    this.abiertos += otro.abiertos;
    this.inicial = this.inicial.sumar(otro.inicial);
    this.conInicial += otro.conInicial;
    this.esperado = this.esperado.sumar(otro.esperado);
    this.contado = this.contado.sumar(otro.contado);
    this.diferencia = this.diferencia.sumar(otro.diferencia);
    for (const [clave, { metodo, monto }] of otro.metodos) this.sumarMetodo(clave, metodo, monto);
  }

  aRespuesta(): ResumenSucursal {
    return {
      id_sucursal: this.id_sucursal,
      nombre: this.nombre,
      turnos: this.turnos,
      turnos_abiertos: this.abiertos,
      efectivo_inicial: this.conInicial > 0 ? this.inicial.aNumero() : null,
      ventas_total: this.ventas.aNumero(),
      por_metodo: [...this.metodos.values()]
        .sort((a, b) => b.monto.centimos - a.monto.centimos || a.metodo.localeCompare(b.metodo, 'es'))
        .map((m) => ({ metodo: m.metodo, monto: m.monto.aNumero() })),
      efectivo_esperado: this.esperado.aNumero(),
      efectivo_contado: this.contado.aNumero(),
      diferencia: this.diferencia.aNumero(),
    };
  }
}

/**
 * Arqueo por sucursal: listado paginado de turnos (GET /caja/aperturas) y resumen por sede
 * (GET /caja/resumen-sucursales).
 *
 * El efectivo esperado NO se recalcula aquí: es el mismo de GET /caja/arqueo/esperado, turno por
 * turno (CajaArqueoRepository.filasEsperado + CalculadoraEsperado). Permisos con el criterio de
 * turnoAutorizado: un administrador ve todo; el resto solo sus propios turnos y su sede.
 */
@Injectable()
export class CajaTurnosBussnies {
  private readonly log = new Logger(CajaTurnosBussnies.name);

  constructor(
    private readonly sesiones: CajaSesionRepository,
    private readonly arqueos: CajaArqueoRepository,
    @Optional() private readonly config?: ConfiguracionRepository,
  ) {}

  // ── GET /caja/aperturas ──────────────────────────────────────

  async aperturas(usuario: UsuarioToken, consulta: ConsultaAperturas) {
    try {
      const fechas = parsearFiltroFechasLima(
        { desde: consulta.desde, hasta: consulta.hasta },
        { maxDias: MAX_DIAS_RANGO },
      );
      const filtro = await this.filtroAutorizado(usuario, consulta, fechas.desde, fechas.hasta);

      const pagina = Math.max(1, Math.trunc(Number(consulta.pagina) || 1));
      const porPagina = Math.min(
        POR_PAGINA_MAXIMO,
        Math.max(1, Math.trunc(Number(consulta.por_pagina) || POR_PAGINA_DEFECTO)),
      );
      const { filas, total } = await this.sesiones.listarTurnos(filtro, {
        limite: porPagina,
        offset: (pagina - 1) * porPagina,
      });
      const esperados = await this.esperados(filas);

      return {
        items: filas.map((f, i) => this.itemApertura(f, esperados[i])),
        total,
        pagina,
        por_pagina: porPagina,
      };
    } catch (error) {
      relanzarHttp(error);
    }
  }

  private itemApertura(f: FilaTurno, esperado: EsperadoCaja | null): AperturaListada {
    const esperadoEfectivo = esperado?.efectivo.esperado ?? null;
    const contado = f.cerrada ? f.monto_conteo : null;
    return {
      id_apertura: f.id_apertura,
      id_caja: f.id_caja,
      caja_nombre: f.caja_nombre,
      id_sucursal: f.id_sucursal,
      sucursal_nombre: f.sucursal_nombre,
      id_usuario: f.id_usuario,
      usuario_nombre: f.usuario_nombre,
      abierta_en: f.abierta_en,
      cerrada_en: f.cerrada ? f.cerrada_en : null,
      monto_inicial: f.monto_inicial ? f.monto_inicial.aNumero() : null,
      efectivo_esperado: esperadoEfectivo ? esperadoEfectivo.aNumero() : null,
      efectivo_contado: contado ? contado.aNumero() : null,
      diferencia: contado && esperadoEfectivo ? contado.restar(esperadoEfectivo).aNumero() : null,
      estado: f.cerrada ? 'cerrado' : 'abierto',
    };
  }

  // ── GET /caja/resumen-sucursales ─────────────────────────────

  async resumenSucursales(usuario: UsuarioToken, consulta: ConsultaResumen) {
    try {
      const hoy = hoyLima();
      const desdeCrudo = consulta.desde?.trim() || undefined;
      const hastaCrudo = consulta.hasta?.trim() || undefined;
      // Sin fechas: hoy. Con una sola, la otra se completa para no devolver un rango abierto.
      const fechas = parsearFiltroFechasLima(
        { desde: desdeCrudo ?? hastaCrudo ?? hoy, hasta: hastaCrudo ?? hoy },
        { maxDias: MAX_DIAS_RANGO },
      );
      const desde = fechas.desde!;
      const hasta = fechas.hasta!;
      const filtro = await this.filtroAutorizado(usuario, { id_sucursal: consulta.id_sucursal }, desde, hasta);

      const { filas } = await this.sesiones.listarTurnos(filtro);
      const esperados = await this.esperados(filas);

      const grupos = new Map<string, Acumulado>();
      filas.forEach((f, i) => {
        const clave = f.id_sucursal == null ? 'sin' : String(f.id_sucursal);
        let grupo = grupos.get(clave);
        if (!grupo) {
          const nombre =
            f.id_sucursal == null ? NOMBRE_SIN_SUCURSAL : f.sucursal_nombre?.trim() || `Sucursal ${f.id_sucursal}`;
          grupo = new Acumulado(f.id_sucursal, nombre);
          grupos.set(clave, grupo);
        }
        this.acumularTurno(grupo, f, esperados[i]);
      });

      const lista = [...grupos.values()].sort((a, b) => {
        if (a.id_sucursal == null) return 1;
        if (b.id_sucursal == null) return -1;
        return a.nombre.localeCompare(b.nombre, 'es');
      });
      const total = new Acumulado(null, 'Total');
      for (const g of lista) total.absorber(g);

      return {
        desde,
        hasta,
        sucursales: lista.map((g) => g.aRespuesta()),
        total: total.aRespuesta(),
      };
    } catch (error) {
      relanzarHttp(error);
    }
  }

  // ── GET /caja/resumen-sucursales/pdf ─────────────────────────

  /** PDF del mismo resumen (mismos permisos y fechas); no recalcula nada. */
  async resumenSucursalesPdf(usuario: UsuarioToken, consulta: ConsultaResumen) {
    try {
      const resumen = await this.resumenSucursales(usuario, consulta);
      const emisor = await this.emisorPdf();
      const filtrada = consulta.id_sucursal != null;
      const buffer = await generarResumenCajaPdf({
        desde: resumen.desde,
        hasta: resumen.hasta,
        sucursales: resumen.sucursales.map((s) => this.filaPdf(s)),
        total: resumen.sucursales.length ? this.filaPdf(resumen.total) : null,
        emisor,
        sucursal_filtrada: filtrada ? (resumen.sucursales[0]?.nombre ?? `Sucursal ${consulta.id_sucursal}`) : null,
      });
      return { buffer, nombreArchivo: nombreArchivoResumenCaja(resumen.desde, resumen.hasta) };
    } catch (error) {
      relanzarHttp(error);
    }
  }

  /** Sin turnos cerrados no hay conteo: contado y diferencia son «sin dato», no 0. */
  private filaPdf(r: ResumenSucursal): FilaResumenCajaPdf {
    const hayConteo = r.turnos - r.turnos_abiertos > 0;
    return {
      ...r,
      efectivo_contado: hayConteo ? r.efectivo_contado : null,
      diferencia: hayConteo ? r.diferencia : null,
    };
  }

  private async emisorPdf() {
    // El logo es decorativo: obtenerLogoEmisor no lanza y un fallo al leer la configuración no impide el PDF.
    const configurado = await this.config
      ?.obtenerVarias(['emisor_logo_url'])
      .then((valores) => String(valores.emisor_logo_url ?? '').trim())
      .catch(() => '');
    const logo = await obtenerLogoEmisor(configurado || emisorConfig.logo_url).catch(() => null);
    return {
      razon_social: emisorConfig.razon_social || 'HATUNSALES S.A.C.',
      ruc: emisorConfig.ruc || '—',
      direccion: [emisorConfig.direccion, emisorConfig.ubicacion].filter(Boolean).join(' · '),
      logo,
    };
  }

  private acumularTurno(grupo: Acumulado, f: FilaTurno, esperado: EsperadoCaja | null): void {
    grupo.turnos += 1;
    if (!f.cerrada) grupo.abiertos += 1;
    // Turno antiguo sin monto inicial: no aporta efectivo inicial (se mostraría como «sin dato»).
    if (f.monto_inicial) {
      grupo.inicial = grupo.inicial.sumar(f.monto_inicial);
      grupo.conInicial += 1;
    }

    if (esperado) {
      grupo.esperado = grupo.esperado.sumar(esperado.efectivo.esperado);
      for (const linea of [...esperado.efectivo.metodos, ...esperado.otros_medios]) {
        grupo.sumarMetodo(linea.clave, linea.nombre, linea.ventas);
      }
      grupo.sumarMetodo('credito', 'Crédito', esperado.credito.ventas);
    }
    if (f.cerrada && f.monto_conteo) {
      grupo.contado = grupo.contado.sumar(f.monto_conteo);
      if (esperado) grupo.diferencia = grupo.diferencia.sumar(f.monto_conteo.restar(esperado.efectivo.esperado));
    }
  }

  // ── Permisos y cálculo compartidos ───────────────────────────

  /**
   * Admin: los filtros tal cual. Resto: siempre solo sus turnos; pedir otro usuario, o una
   * sucursal/caja fuera de su sede (las sucursales donde tuvo turnos), es 403 como en turnoAutorizado.
   */
  private async filtroAutorizado(
    usuario: UsuarioToken,
    consulta: Pick<ConsultaAperturas, 'id_sucursal' | 'id_caja' | 'id_usuario'>,
    desde?: string,
    hasta?: string,
  ): Promise<FiltroTurnos> {
    const filtro: FiltroTurnos = {
      idSucursal: consulta.id_sucursal,
      idCaja: consulta.id_caja,
      idUsuario: consulta.id_usuario,
      desde,
      hasta,
    };
    if (normalizarRol(usuario?.rol) === 'admin') return filtro;

    const idUsuario = Number(usuario?.id_usuario);
    if (!idUsuario) throw ErrorCaja.prohibido(CodigoErrorCaja.CAJA_TURNO_AJENO, 'Sesión inválida.');
    const ajeno = (detalle: string) =>
      ErrorCaja.prohibido(CodigoErrorCaja.CAJA_TURNO_AJENO, `Solo puede consultar ${detalle} (o un administrador).`);

    if (consulta.id_usuario != null && consulta.id_usuario !== idUsuario) throw ajeno('sus propios turnos');
    if (consulta.id_sucursal != null || consulta.id_caja != null) {
      const sedes = await this.sesiones.sucursalesDeUsuario(idUsuario);
      if (consulta.id_sucursal != null && !sedes.includes(consulta.id_sucursal)) throw ajeno('los turnos de su sede');
      if (consulta.id_caja != null) {
        const sucursalCaja = await this.sesiones.sucursalDeCaja(consulta.id_caja);
        if (sucursalCaja !== undefined && !sedes.includes(sucursalCaja)) throw ajeno('los turnos de su sede');
      }
    }
    return { ...filtro, idUsuario };
  }

  /** Esperado de cada turno con el cálculo del arqueo; null si no se pudo (esquema incompleto). */
  private async esperados(filas: FilaTurno[]): Promise<(EsperadoCaja | null)[]> {
    const salida: (EsperadoCaja | null)[] = new Array(filas.length).fill(null);
    for (let i = 0; i < filas.length; i += CONCURRENCIA_ESPERADO) {
      const bloque = filas.slice(i, i + CONCURRENCIA_ESPERADO);
      const calculados = await Promise.all(bloque.map((f) => this.esperadoDeTurno(f)));
      calculados.forEach((c, j) => {
        salida[i + j] = c;
      });
    }
    return salida;
  }

  private async esperadoDeTurno(f: FilaTurno): Promise<EsperadoCaja | null> {
    try {
      const filasFuente = await this.arqueos.filasEsperado(f.id_apertura);
      return CalculadoraEsperado.calcular(f.monto_inicial ?? Dinero.CERO, filasFuente);
    } catch (error) {
      this.log.warn(`Esperado del turno ${f.id_apertura} no disponible: ${(error as Error)?.message ?? error}`);
      return null;
    }
  }
}

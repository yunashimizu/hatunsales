import { BadRequestException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { emisorConfig } from '../../config/emisor.config';
import { correoValido, leerConfigCorreo } from '../../correo/correo.config';
import { EnviadorCorreo } from '../../correo/enviador-correo.contrato';
import {
  armarCorreoResumenDiario,
  DatosResumenDiario,
  nombreEstadoComprobante,
} from '../../correo/plantilla-resumen-diario';
import { ConfiguracionRepository } from '../../repository/Repository/configuracion.repository';
import { CreditoRepository } from '../../repository/Repository/credito.repository';
import { InventarioRepository } from '../../repository/Repository/inventario.repository';
import { ReportesRepository } from '../../repository/Repository/reportes.repository';
import { horaLima, hoyLima, sumarDiasYmd } from '../../util/fecha-lima';
import type { UsuarioToken } from '../../guards/usuario-actual.decorator';
import { CajaTurnosBussnies } from './caja-turnos.bussnies';
import { ComprobanteBussnies } from './comprobante.bussnies';
import { ReportesBussnies } from './reportes.bussnies';

export const CLAVE_RESUMEN_ACTIVO = 'resumen_diario_activo';
export const CLAVE_RESUMEN_HORA = 'resumen_diario_hora';
export const CLAVE_RESUMEN_CORREOS = 'resumen_diario_correos';
export const CLAVE_RESUMEN_ULTIMO_ENVIO = 'resumen_diario_ultimo_envio';
/** 'AAAA-MM-DD:N' = cuántos envíos fallaron ese día (para no insistir más de tres veces). */
export const CLAVE_RESUMEN_FALLOS = 'resumen_diario_fallos';

export const HORA_RESUMEN_DEFECTO = '20:30';
export const MAX_FALLOS_POR_DIA = 3;
const MAX_CORREOS = 10;
const TOP_STOCK = 10;
const TOP_DEUDA = 5;
const TOP_COMPROBANTES = 5;
const PATRON_HORA = /^([01]\d|2[0-3]):[0-5]\d$/;
/** Un usuario administrador de mentira para pedir el resumen de caja de todas las sedes. */
const USUARIO_SISTEMA = { id_usuario: 0, nombre: 'Resumen diario', email: '', rol: 'admin', permisos: [] } as UsuarioToken;

export interface ConfigResumenDiario {
  activo: boolean;
  /** 'HH:MM' en hora de Lima. */
  hora: string;
  /** Correos escritos por la persona (puede estar vacío). */
  correos: string[];
  /** A quién llegará de verdad: los correos escritos o, si no hay, el correo del emisor. */
  destinatarios: string[];
  /** Día del último envío automático correcto ('AAAA-MM-DD') o null. */
  ultimo_envio: string | null;
  /** Cómo sale el correo: brevo, resend o archivo (en «archivo» no llega a ninguna bandeja). */
  proveedor: string;
}

export interface ResultadoEnvioResumen {
  enviados: string[];
  fallidos: Array<{ correo: string; motivo: string }>;
  asunto: string;
  proveedor: string;
}

export type ResultadoVuelta =
  | 'enviado'
  | 'inactivo'
  | 'antes_de_hora'
  | 'ya_enviado'
  | 'agotado'
  | 'sin_destinatarios'
  | 'fallo';

/** Lo que la tarea del resumen pide al envío: la configuración, el cálculo del día y el correo. */
@Injectable()
export class ResumenDiarioBussnies {
  private readonly log = new Logger(ResumenDiarioBussnies.name);
  private avisoSinDestino: string | null = null;

  constructor(
    private readonly config: ConfiguracionRepository,
    private readonly reportes: ReportesBussnies,
    private readonly reportesRepo: ReportesRepository,
    private readonly caja: CajaTurnosBussnies,
    private readonly comprobantes: ComprobanteBussnies,
    private readonly credito: CreditoRepository,
    private readonly inventario: InventarioRepository,
    private readonly enviador: EnviadorCorreo,
  ) {}

  // ── Configuración ───────────────────────────────────────────

  async obtenerConfiguracion(): Promise<ConfigResumenDiario> {
    const v = await this.config.obtenerVarias([
      CLAVE_RESUMEN_ACTIVO,
      CLAVE_RESUMEN_HORA,
      CLAVE_RESUMEN_CORREOS,
      CLAVE_RESUMEN_ULTIMO_ENVIO,
    ]);
    const hora = (v[CLAVE_RESUMEN_HORA] ?? '').trim();
    const correos = this.separarCorreos(v[CLAVE_RESUMEN_CORREOS] ?? '').validos;
    const ultimo = (v[CLAVE_RESUMEN_ULTIMO_ENVIO] ?? '').trim();
    return {
      activo: (v[CLAVE_RESUMEN_ACTIVO] ?? '').trim().toLowerCase() === 'true',
      hora: PATRON_HORA.test(hora) ? hora : HORA_RESUMEN_DEFECTO,
      correos,
      destinatarios: await this.destinatarios(correos),
      ultimo_envio: /^\d{4}-\d{2}-\d{2}$/.test(ultimo) ? ultimo : null,
      proveedor: leerConfigCorreo().proveedor,
    };
  }

  async guardarConfiguracion(cambios: {
    activo?: unknown;
    hora?: unknown;
    correos?: unknown;
  }): Promise<ConfigResumenDiario> {
    const pendientes: Array<[string, string]> = [];
    if (cambios.activo !== undefined) {
      if (typeof cambios.activo !== 'boolean') throw new BadRequestException('«activo» debe ser verdadero o falso.');
      pendientes.push([CLAVE_RESUMEN_ACTIVO, cambios.activo ? 'true' : 'false']);
    }
    if (cambios.hora !== undefined) {
      const hora = String(cambios.hora).trim();
      if (!PATRON_HORA.test(hora)) throw new BadRequestException('La hora debe tener el formato HH:MM (por ejemplo 20:30).');
      pendientes.push([CLAVE_RESUMEN_HORA, hora]);
    }
    if (cambios.correos !== undefined) {
      const crudo = Array.isArray(cambios.correos) ? cambios.correos.map(String).join(',') : String(cambios.correos ?? '');
      const { validos, invalidos } = this.separarCorreos(crudo);
      if (invalidos.length) {
        throw new BadRequestException(`Estos correos no parecen válidos: ${invalidos.join(', ')}.`);
      }
      if (validos.length > MAX_CORREOS) throw new BadRequestException(`Use como máximo ${MAX_CORREOS} correos.`);
      pendientes.push([CLAVE_RESUMEN_CORREOS, validos.join(',')]);
    }
    for (const [clave, valor] of pendientes) await this.config.guardar(clave, valor);
    return this.obtenerConfiguracion();
  }

  // ── Envío ───────────────────────────────────────────────────

  /** «Enviar ahora de prueba»: arma el resumen de hoy y lo envía ya, sin marcar el día como enviado. */
  async enviarAhora(ahora: Date = new Date()): Promise<ResultadoEnvioResumen> {
    const config = await this.obtenerConfiguracion();
    if (!config.destinatarios.length) {
      throw new BadRequestException(
        'No hay a quién enviarlo: escriba al menos un correo o configure el correo del emisor en Facturación.',
      );
    }
    const datos = await this.recopilar(hoyLima(ahora), true);
    const resultado = await this.enviarA(config.destinatarios, datos);
    if (!resultado.enviados.length) {
      throw new ServiceUnavailableException(
        `No se pudo enviar el correo: ${resultado.fallidos[0]?.motivo ?? 'el proveedor de correo no respondió'}.`,
      );
    }
    return resultado;
  }

  /**
   * Una vuelta de la tarea: envía una sola vez al día cuando la hora de Lima llega a la configurada. Si el envío
   * falla no se marca el día y se reintenta en la vuelta siguiente, hasta MAX_FALLOS_POR_DIA veces.
   */
  async enviarSiToca(ahora: Date = new Date()): Promise<ResultadoVuelta> {
    const config = await this.obtenerConfiguracion();
    if (!config.activo) return 'inactivo';

    const hoy = hoyLima(ahora);
    if (horaLima(ahora).slice(0, 5) < config.hora) return 'antes_de_hora';
    if (config.ultimo_envio === hoy) return 'ya_enviado';

    const fallos = await this.fallosDeHoy(hoy);
    if (fallos >= MAX_FALLOS_POR_DIA) return 'agotado';

    if (!config.destinatarios.length) {
      if (this.avisoSinDestino !== hoy) {
        this.avisoSinDestino = hoy;
        this.log.warn('El resumen diario está encendido pero no tiene destinatarios: escriba un correo en Configuración.');
      }
      return 'sin_destinatarios';
    }

    try {
      const datos = await this.recopilar(hoy, false);
      const resultado = await this.enviarA(config.destinatarios, datos);
      if (resultado.enviados.length) {
        await this.config.guardar(CLAVE_RESUMEN_ULTIMO_ENVIO, hoy);
        if (fallos > 0) await this.config.guardar(CLAVE_RESUMEN_FALLOS, '');
        this.log.log(`Resumen diario ${hoy} enviado a ${resultado.enviados.join(', ')}.`);
        return 'enviado';
      }
      throw new Error(resultado.fallidos[0]?.motivo ?? 'el proveedor de correo no respondió');
    } catch (error) {
      const motivo = error instanceof Error ? error.message : String(error);
      await this.config.guardar(CLAVE_RESUMEN_FALLOS, `${hoy}:${fallos + 1}`);
      this.log.warn(`El resumen diario ${hoy} no se pudo enviar (intento ${fallos + 1} de ${MAX_FALLOS_POR_DIA}): ${motivo}`);
      return 'fallo';
    }
  }

  private async fallosDeHoy(hoy: string): Promise<number> {
    const crudo = ((await this.config.obtener(CLAVE_RESUMEN_FALLOS)) ?? '').trim();
    const [dia, n] = crudo.split(':');
    return dia === hoy ? Math.max(0, Number(n) || 0) : 0;
  }

  private async enviarA(destinatarios: string[], datos: DatosResumenDiario): Promise<ResultadoEnvioResumen> {
    const armado = armarCorreoResumenDiario(datos);
    const enviados: string[] = [];
    const fallidos: Array<{ correo: string; motivo: string }> = [];
    for (const para of destinatarios) {
      try {
        await this.enviador.enviar({ para, asunto: armado.asunto, html: armado.html, texto: armado.texto, adjuntos: [] });
        enviados.push(para);
      } catch (error) {
        fallidos.push({ correo: para, motivo: error instanceof Error ? error.message : String(error) });
      }
    }
    return { enviados, fallidos, asunto: armado.asunto, proveedor: this.enviador.nombre };
  }

  // ── Destinatarios ───────────────────────────────────────────

  private separarCorreos(texto: string): { validos: string[]; invalidos: string[] } {
    const vistos = new Set<string>();
    const validos: string[] = [];
    const invalidos: string[] = [];
    for (const crudo of texto.split(/[,;\n]/)) {
      const correo = crudo.trim();
      if (!correo) continue;
      if (!correoValido(correo)) {
        invalidos.push(correo);
        continue;
      }
      const clave = correo.toLowerCase();
      if (vistos.has(clave)) continue;
      vistos.add(clave);
      validos.push(correo);
    }
    return { validos, invalidos };
  }

  /** Los correos escritos o, si no hay ninguno, el correo del emisor (configuración fiscal o variable de entorno). */
  private async destinatarios(escritos: string[]): Promise<string[]> {
    if (escritos.length) return escritos;
    const emisor = ((await this.config.obtener('emisor_email')) ?? emisorConfig.email ?? '').trim();
    return correoValido(emisor) ? [emisor] : [];
  }

  // ── Datos del día ───────────────────────────────────────────

  /** Una sección que falla no tumba el correo: sale con «no se pudo leer» y queda en el log. */
  private async seccion<T>(nombre: string, trabajo: () => Promise<T>): Promise<T | null> {
    try {
      return await trabajo();
    } catch (error) {
      this.log.warn(`Resumen diario: no se pudo leer «${nombre}»: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  async recopilar(hoy: string, esPrueba: boolean): Promise<DatosResumenDiario> {
    const [ventas, caja, comprobantes, deuda, stock, pedidos] = await Promise.all([
      this.seccion('ventas', async () => {
        const [dHoy, dAyer, dSemana] = await Promise.all([
          this.reportes.resumenDia(hoy),
          this.reportes.resumenDia(sumarDiasYmd(hoy, -1)),
          this.reportes.resumenDia(sumarDiasYmd(hoy, -7)),
        ]);
        return { hoy: dHoy, ayer: dAyer, semana_pasada: dSemana };
      }),
      this.seccion('caja', async () => {
        const resumen = await this.caja.resumenSucursales(USUARIO_SISTEMA, { desde: hoy, hasta: hoy });
        // El crédito no es plata cobrada hoy: se deja fuera de «cobros».
        const por_metodo = resumen.total.por_metodo.filter((m) => m.monto !== 0 && !/^cr[eé]dito$/i.test(m.metodo.trim()));
        return {
          total: por_metodo.reduce((acc, m) => Math.round((acc + m.monto) * 100) / 100, 0),
          turnos_abiertos: resumen.total.turnos_abiertos,
          por_metodo,
        };
      }),
      this.seccion('comprobantes', async () => {
        const [conteo, recientes] = await Promise.all([
          this.comprobantes.monitorAtencion(),
          this.reportesRepo.obtenerComprobantesConProblema(TOP_COMPROBANTES),
        ]);
        return {
          pendientes: conteo.pendientes,
          errores: conteo.errores,
          recientes: recientes.map((c) => ({
            numero: c.serie && c.numero ? `${c.serie}-${String(c.numero).padStart(8, '0')}` : `N.° ${c.id_comprobante}`,
            estado: nombreEstadoComprobante(c.estado, c.estado_sunat),
          })),
        };
      }),
      this.seccion('deuda', () => this.credito.deudaVencida(TOP_DEUDA)),
      this.seccion('stock', async () => {
        const [resumen, alertas] = await Promise.all([
          this.inventario.resumen(),
          this.inventario.listarDetallado({ solo_alertas: true, por_pagina: 200 }),
        ]);
        // Primero lo que de verdad faltó (sin existencias y con mínimo), luego lo que está bajo el mínimo; al final los
        // productos sin existencias que nunca tuvieron mínimo (suelen ser fichas sin stock cargado).
        const rango = (f: { stock: number; stock_minimo: number }) =>
          f.stock <= 0 && f.stock_minimo > 0 ? 0 : f.stock > 0 ? 1 : 2;
        const criticos = alertas.datos
          .filter((f) => f.estado !== 'ok')
          .sort((a, b) => rango(a) - rango(b) || a.producto.localeCompare(b.producto, 'es'))
          .slice(0, TOP_STOCK)
          .map((f) => ({ producto: f.producto, almacen: f.almacen, stock: f.stock, minimo: f.stock_minimo }));
        return { sin_stock: resumen.sin_stock, bajo_stock: resumen.bajo_stock, criticos };
      }),
      this.seccion('pedidos', async () => {
        const p = await this.reportesRepo.contarPedidosWeb();
        return { pendientes: p.pendientes, pagados: p.pagados };
      }),
    ]);

    const emisor = ((await this.config.obtener('emisor_razon_social')) ?? emisorConfig.razon_social ?? '').trim();
    return { fecha: hoy, negocio: emisor || 'HatunSales', esPrueba, ventas, caja, comprobantes, deuda, stock, pedidos };
  }
}

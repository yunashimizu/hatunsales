import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { NotaCreditoBussnies } from '../Bussnies/nota-credito.bussnies';
import { FiscalConfigService } from '../../sunat/config/fiscal-config.service';
import { OyenteEnvioFiscal, OyentesEnvioFiscal } from '../../sunat/emision/emision.contrato';
import type { EventoEnvioCompletado } from '../../sunat/emision/emision.contrato';

/** Primera vuelta: entre 90 y 150 s después de arrancar (el azar separa a las réplicas). */
const RETRASO_INICIAL_MS = 90_000;
const DISPERSION_INICIAL_MS = 60_000;

/**
 * Efectos de las notas de crédito cuando SUNAT las acepta (PLAN V3, D8): reingreso de stock, baja de la
 * cuenta por cobrar y anulación de la venta. Llegan por dos caminos que terminan en el mismo método
 * idempotente (NotaCreditoBussnies.aplicarEfectos, que reclama la nota con efectos_aplicados):
 *  - al instante, como oyente de los envíos a SUNAT (el aviso llega con CUALQUIER resultado: solo una
 *    nota ACEPTADA tiene efectos; una rechazada no aplica nada y queda visible en Documentos);
 *  - cada 5 minutos, un barrido de las notas aceptadas que quedaron pendientes (el proceso cayó entre
 *    la aceptación y los efectos, o los efectos fallaron). Solo corre con fiscal_tareas_activas.
 * Varias réplicas: cada nota se reclama con UPDATE … WHERE efectos_aplicados = false, así nunca se
 * aplican dos veces; no se usan candados de sesión.
 *
 * También anula la venta y el comprobante cuando SUNAT acepta la baja (RA) o el resumen (RC) con que se
 * anula SIN nota (evento con `operacion` 'baja' | 'resumen' y barrido de lotes aceptados): el mismo
 * camino, con NotaCreditoBussnies.aplicarBajaAceptada, que también es idempotente.
 */
@Injectable()
export class EfectosNotasTarea implements OnModuleInit, OnApplicationBootstrap, OnModuleDestroy, OyenteEnvioFiscal {
  static readonly INTERVALO_MS = 5 * 60_000;
  static readonly NOTAS_POR_VUELTA = 20;

  private readonly log = new Logger(EfectosNotasTarea.name);
  private temporizador: NodeJS.Timeout | null = null;
  private primera: NodeJS.Timeout | null = null;
  private enCurso = false;

  constructor(
    private readonly notas: NotaCreditoBussnies,
    private readonly oyentes: OyentesEnvioFiscal,
    private readonly config: FiscalConfigService,
  ) {}

  onModuleInit(): void {
    this.oyentes.registrar(this);
  }

  onApplicationBootstrap(): void {
    const retraso = RETRASO_INICIAL_MS + Math.floor(Math.random() * DISPERSION_INICIAL_MS);
    this.primera = setTimeout(() => void this.ejecutar(), retraso);
    this.primera.unref?.();
    this.temporizador = setInterval(() => void this.ejecutar(), EfectosNotasTarea.INTERVALO_MS);
    this.temporizador.unref?.();
  }

  onModuleDestroy(): void {
    if (this.primera) clearTimeout(this.primera);
    if (this.temporizador) clearInterval(this.temporizador);
    this.primera = null;
    this.temporizador = null;
  }

  /** Oyente de envíos: nunca lanza (un fallo queda en el log y lo retoma el barrido). */
  async alCompletarEnvio(evento: EventoEnvioCompletado): Promise<void> {
    if (evento.aceptado === true && (evento.operacion === 'baja' || evento.operacion === 'resumen')) {
      await this.aplicarBaja(evento);
      return;
    }
    if (evento.aceptado !== true || evento.tipo_documento !== '07' || !evento.id_comprobante) return;
    try {
      await this.notas.aplicarEfectos(evento.id_comprobante);
    } catch (error) {
      this.log.error(
        `No se aplicaron los efectos de la nota ${evento.id_comprobante} (envío ${evento.id_envio}): ${this.mensajeDe(error)}. El barrido lo reintentará.`,
      );
    }
  }

  /** Una baja (RA) o un resumen (RC) aceptado: anula el comprobante y la venta. Nunca lanza (lo retoma el barrido). */
  private async aplicarBaja(evento: EventoEnvioCompletado): Promise<void> {
    try {
      await this.notas.aplicarBajaAceptada(evento.id_envio);
    } catch (error) {
      this.log.error(
        `No se aplicaron los efectos de la baja del envío ${evento.id_envio}: ${this.mensajeDe(error)}. El barrido lo reintentará.`,
      );
    }
  }

  /** Una vuelta del barrido: devuelve cuántas notas aplicó (0 si no le tocaba o si otra réplica las tomó). */
  async ejecutar(): Promise<number> {
    if (this.enCurso) return 0;
    this.enCurso = true;
    try {
      if (!(await this.config.tareasActivas())) return 0;
      const pendientes = await this.notas.notasConEfectosPendientes(EfectosNotasTarea.NOTAS_POR_VUELTA);
      let aplicadas = 0;
      for (const idNota of pendientes) {
        try {
          if (await this.notas.aplicarEfectos(idNota)) aplicadas += 1;
        } catch (error) {
          this.log.warn(`No se pudieron aplicar los efectos de la nota ${idNota}: ${this.mensajeDe(error)}`);
        }
      }
      if (aplicadas > 0) this.log.log(`${aplicadas} nota(s) de crédito aceptadas con efectos aplicados por el barrido.`);

      // Bajas (RA) y resúmenes (RC) aceptados por SUNAT cuyo comprobante sigue sin anular.
      const bajas = await this.notas.bajasConEfectosPendientes(EfectosNotasTarea.NOTAS_POR_VUELTA);
      let anuladas = 0;
      for (const idEnvio of bajas) {
        try {
          anuladas += await this.notas.aplicarBajaAceptada(idEnvio);
        } catch (error) {
          this.log.warn(`No se pudieron aplicar los efectos de la baja (envío ${idEnvio}): ${this.mensajeDe(error)}`);
        }
      }
      if (anuladas > 0) this.log.log(`${anuladas} comprobante(s) dados de baja en SUNAT anulados por el barrido.`);
      return aplicadas + anuladas;
    } catch (error) {
      this.log.warn(`El barrido de efectos de notas de crédito no pudo completar la vuelta: ${this.mensajeDe(error)}`);
      return 0;
    } finally {
      this.enCurso = false;
    }
  }

  private mensajeDe(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}

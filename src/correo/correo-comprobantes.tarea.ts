import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { FiscalConfigService } from '../sunat/config/fiscal-config.service';
import { ComprobanteCorreosRepository } from './comprobante-correos.repository';
import { CorreoComprobanteService } from './correo-comprobante.service';

/** Primera vuelta: entre 60 y 120 s después de arrancar (el azar separa a las réplicas). */
const RETRASO_INICIAL_MS = 60_000;
const DISPERSION_INICIAL_MS = 60_000;

/**
 * Envía solo los correos de comprobantes (PLAN_ENVIO_COMPROBANTE_CORREO). Cada 30 s: omite los pendientes
 * cuyo comprobante quedó rechazado o anulado, siembra las filas de los comprobantes con enviar_cliente y
 * envía hasta 10 por vuelta con espera creciente (1, 5, 15, 60 y 60 min; al quinto fallo queda en ERROR).
 *
 * Solo corre con tareasActivas() (no en pruebas), con la tabla comprobante_correos aplicada y con el
 * interruptor `correo_envio_activo` encendido (apagado por defecto). Varias réplicas: cada correo se reclama
 * por separado (FOR UPDATE SKIP LOCKED + plazo en bloqueado_hasta), así dos instancias nunca envían el mismo.
 */
@Injectable()
export class CorreoComprobantesTarea implements OnApplicationBootstrap, OnModuleDestroy {
  static readonly INTERVALO_MS = 30_000;
  static readonly SEMBRADOS_POR_VUELTA = 50;
  static readonly CORREOS_POR_VUELTA = 10;

  private readonly log = new Logger(CorreoComprobantesTarea.name);
  private temporizador: NodeJS.Timeout | null = null;
  private primera: NodeJS.Timeout | null = null;
  private enCurso = false;

  constructor(
    private readonly config: FiscalConfigService,
    private readonly repo: ComprobanteCorreosRepository,
    private readonly correo: CorreoComprobanteService,
  ) {}

  onApplicationBootstrap(): void {
    const retraso = RETRASO_INICIAL_MS + Math.floor(Math.random() * DISPERSION_INICIAL_MS);
    this.primera = setTimeout(() => void this.ejecutar(), retraso);
    this.primera.unref?.();
    this.temporizador = setInterval(() => void this.ejecutar(), CorreoComprobantesTarea.INTERVALO_MS);
    this.temporizador.unref?.();
  }

  onModuleDestroy(): void {
    if (this.primera) clearTimeout(this.primera);
    if (this.temporizador) clearInterval(this.temporizador);
    this.primera = null;
    this.temporizador = null;
  }

  /** Una vuelta: devuelve cuántos correos procesó (0 si no le tocaba o si otra réplica los tomó). */
  async ejecutar(): Promise<number> {
    if (this.enCurso) return 0;
    this.enCurso = true;
    try {
      if (!(await this.config.tareasActivas())) return 0;
      if (!(await this.correo.tablaDisponible()) || !(await this.correo.activo())) return 0;

      await this.repo.omitirRechazados();
      await this.repo.sembrar(CorreoComprobantesTarea.SEMBRADOS_POR_VUELTA);
      const candidatos = await this.repo.candidatos(CorreoComprobantesTarea.CORREOS_POR_VUELTA);

      let procesados = 0;
      for (const idCorreo of candidatos) {
        try {
          // null: otra réplica lo tomó primero, o ya cambió de estado.
          if ((await this.correo.procesar(idCorreo)) !== null) procesados += 1;
        } catch (error) {
          this.log.warn(`No se pudo procesar el correo ${idCorreo}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      if (procesados > 0) this.log.log(`${procesados} correo(s) de comprobantes procesados.`);
      return procesados;
    } catch (error) {
      this.log.warn(`La tarea de correos de comprobantes no pudo completar la vuelta: ${error instanceof Error ? error.message : String(error)}`);
      return 0;
    } finally {
      this.enCurso = false;
    }
  }
}

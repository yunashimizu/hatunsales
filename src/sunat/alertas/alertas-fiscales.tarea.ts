import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { FiscalConfigService } from '../config/fiscal-config.service';
import { RelojFiscal } from '../config/reloj-fiscal';
import { horaLima } from '../nucleo/fechas-fiscales';
import { AlertasFiscalesService, HORA_ALERTAS_LIMA } from './alertas-fiscales.service';

/** Primera vuelta: entre 2 y 3 minutos después de arrancar (el azar separa a las réplicas). */
const RETRASO_INICIAL_MS = 120_000;
const DISPERSION_INICIAL_MS = 60_000;

/**
 * Aviso diario por correo (S7): revisa cada 10 minutos y, desde las 08:00 de Lima, hace UNA revisión por día. Si el
 * correo falla, la revisión no se da por hecha y se reintenta en la vuelta siguiente; el mismo aviso nunca sale dos
 * veces el mismo día (la bitácora fiscal lo recuerda, también entre réplicas). Solo corre con fiscal_tareas_activas.
 */
@Injectable()
export class AlertasFiscalesTarea implements OnApplicationBootstrap, OnModuleDestroy {
  static readonly INTERVALO_MS = 10 * 60_000;

  private readonly log = new Logger(AlertasFiscalesTarea.name);
  private temporizador: NodeJS.Timeout | null = null;
  private primera: NodeJS.Timeout | null = null;
  private enCurso = false;
  private ultimoDiaRevisado: string | null = null;

  constructor(
    private readonly config: FiscalConfigService,
    private readonly alertas: AlertasFiscalesService,
    private readonly reloj: RelojFiscal,
  ) {}

  onApplicationBootstrap(): void {
    const retraso = RETRASO_INICIAL_MS + Math.floor(Math.random() * DISPERSION_INICIAL_MS);
    this.primera = setTimeout(() => void this.ejecutar(), retraso);
    this.primera.unref?.();
    this.temporizador = setInterval(() => void this.ejecutar(), AlertasFiscalesTarea.INTERVALO_MS);
    this.temporizador.unref?.();
  }

  onModuleDestroy(): void {
    if (this.primera) clearTimeout(this.primera);
    if (this.temporizador) clearInterval(this.temporizador);
    this.primera = null;
    this.temporizador = null;
  }

  /** true si hizo la revisión del día en esta vuelta. */
  async ejecutar(): Promise<boolean> {
    if (this.enCurso) return false;
    this.enCurso = true;
    try {
      if (!(await this.config.tareasActivas())) return false;
      const ahora = this.reloj.ahora();
      const hoy = this.reloj.fechaLima(ahora);
      if (this.ultimoDiaRevisado === hoy) return false;
      // horaLima devuelve HH:mm:ss; la comparación de texto funciona porque el formato es fijo.
      if (horaLima(ahora) < `${HORA_ALERTAS_LIMA}:00`) return false;

      await this.alertas.enviarDelDia();
      this.ultimoDiaRevisado = hoy;
      return true;
    } catch (error) {
      this.log.warn(`La tarea de avisos fiscales no pudo completar la vuelta: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    } finally {
      this.enCurso = false;
    }
  }
}

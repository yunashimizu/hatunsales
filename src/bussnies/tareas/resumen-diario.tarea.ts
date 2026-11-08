import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { FiscalConfigService } from '../../sunat/config/fiscal-config.service';
import { ResultadoVuelta, ResumenDiarioBussnies } from '../Bussnies/resumen-diario.bussnies';

/** Primera vuelta: entre 90 y 150 s después de arrancar (el azar separa a las réplicas). */
const RETRASO_INICIAL_MS = 90_000;
const DISPERSION_INICIAL_MS = 60_000;

/**
 * Resumen diario al dueño por correo (PLAN_PANEL_MERCADO_FASES_E_F, F3). Cada 5 minutos pregunta a ResumenDiarioBussnies
 * si toca: envía una sola vez al día, cuando la hora de Lima llega a `resumen_diario_hora` (por defecto 20:30), solo con
 * `resumen_diario_activo` encendido. Si el envío falla no marca el día y reintenta en la vuelta siguiente (tres veces al día
 * como máximo). Solo corre con tareasActivas() (no en pruebas ni con FISCAL_TAREAS_DESACTIVADAS=true).
 */
@Injectable()
export class ResumenDiarioTarea implements OnApplicationBootstrap, OnModuleDestroy {
  static readonly INTERVALO_MS = 5 * 60_000;

  private readonly log = new Logger(ResumenDiarioTarea.name);
  private temporizador: NodeJS.Timeout | null = null;
  private primera: NodeJS.Timeout | null = null;
  private enCurso = false;

  constructor(
    private readonly fiscal: FiscalConfigService,
    private readonly resumen: ResumenDiarioBussnies,
  ) {}

  onApplicationBootstrap(): void {
    const retraso = RETRASO_INICIAL_MS + Math.floor(Math.random() * DISPERSION_INICIAL_MS);
    this.primera = setTimeout(() => void this.ejecutar(), retraso);
    this.primera.unref?.();
    this.temporizador = setInterval(() => void this.ejecutar(), ResumenDiarioTarea.INTERVALO_MS);
    this.temporizador.unref?.();
  }

  onModuleDestroy(): void {
    if (this.primera) clearTimeout(this.primera);
    if (this.temporizador) clearInterval(this.temporizador);
    this.primera = null;
    this.temporizador = null;
  }

  /** Una vuelta; devuelve qué pasó (nunca lanza: un fallo queda en el log y se reintenta en la vuelta siguiente). */
  async ejecutar(ahora: Date = new Date()): Promise<ResultadoVuelta | 'tareas_apagadas' | 'en_curso' | 'error'> {
    if (this.enCurso) return 'en_curso';
    this.enCurso = true;
    try {
      if (!(await this.fiscal.tareasActivas())) return 'tareas_apagadas';
      return await this.resumen.enviarSiToca(ahora);
    } catch (error) {
      this.log.warn(`Vuelta del resumen diario con error: ${error instanceof Error ? error.message : String(error)}`);
      return 'error';
    } finally {
      this.enCurso = false;
    }
  }
}

import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { FiscalConfigError } from '../config/fiscal-errores';
import { FiscalConfigService } from '../config/fiscal-config.service';
import { EmisionDirecta } from '../emision/emision.contrato';
import { LoteFiscalRepository } from './lote-fiscal.repository';
import { LotesFiscalesService } from './lotes-fiscales.service';

/** Primera vuelta: entre 60 y 120 s después de arrancar (el azar separa a las réplicas). */
const RETRASO_INICIAL_MS = 60_000;
const DISPERSION_INICIAL_MS = 60_000;

/**
 * Tarea programada de los lotes fiscales (bajas RA y resúmenes RC): cada 2 minutos toma hasta 10 lotes del
 * ambiente VIGENTE que esperan algo de SUNAT y los resuelve por el mismo camino seguro del reintento manual:
 * los TICKET_PENDIENTE consultan su ticket cuando les llega el turno (1, 2, 5, 15, 30 y 60 min) y los
 * PENDIENTE_REENVIO (o ENVIANDO con el reclamo vencido) mandan otra vez el MISMO ZIP. Cuando SUNAT acepta un
 * lote, el servicio avisa a los oyentes y el negocio anula la venta.
 *
 * Varias réplicas: cada lote se reclama por separado con un UPDATE condicionado (plazo de 60 s), así dos
 * instancias nunca lo procesan a la vez; no se usan candados de sesión. Solo corre con
 * fiscal_tareas_activas y la emisión activa.
 */
@Injectable()
export class LotesFiscalesTarea implements OnApplicationBootstrap, OnModuleDestroy {
  static readonly INTERVALO_MS = 2 * 60_000;
  static readonly LOTES_POR_VUELTA = 10;

  private readonly log = new Logger(LotesFiscalesTarea.name);
  private temporizador: NodeJS.Timeout | null = null;
  private primera: NodeJS.Timeout | null = null;
  private enCurso = false;

  constructor(
    private readonly config: FiscalConfigService,
    private readonly emisionDirecta: EmisionDirecta,
    private readonly lotes: LotesFiscalesService,
    private readonly repositorio: LoteFiscalRepository,
  ) {}

  onApplicationBootstrap(): void {
    const retraso = RETRASO_INICIAL_MS + Math.floor(Math.random() * DISPERSION_INICIAL_MS);
    this.primera = setTimeout(() => void this.ejecutar(), retraso);
    this.primera.unref?.();
    this.temporizador = setInterval(() => void this.ejecutar(), LotesFiscalesTarea.INTERVALO_MS);
    this.temporizador.unref?.();
  }

  onModuleDestroy(): void {
    if (this.primera) clearTimeout(this.primera);
    if (this.temporizador) clearInterval(this.temporizador);
    this.primera = null;
    this.temporizador = null;
  }

  /** Una vuelta: devuelve cuántos lotes procesó (0 si no le tocaba o si otra réplica los tomó). */
  async ejecutar(): Promise<number> {
    if (this.enCurso) return 0;
    this.enCurso = true;
    try {
      if (!(await this.config.tareasActivas())) return 0;
      const modo = await this.emisionDirecta.modo();
      if (!modo.activo) return 0;

      const candidatos = await this.repositorio.candidatosTarea(modo.ambiente, LotesFiscalesTarea.LOTES_POR_VUELTA);
      let procesados = 0;
      for (const idEnvio of candidatos) {
        try {
          await this.lotes.reintentar(idEnvio, 'tarea');
          procesados += 1;
        } catch (error) {
          // SUNAT acaba de rechazar la credencial o el certificado: no se insiste con los demás.
          if (FiscalConfigError.es(error, 'FISCAL_EMISION_BLOQUEADA')) break;
          // Otra réplica (o el administrador) lo tomó primero, o ya cambió de estado.
          if (FiscalConfigError.es(error, 'FISCAL_ENVIO_EN_CURSO') || FiscalConfigError.es(error, 'FISCAL_REENVIO_NO_PERMITIDO')) continue;
          this.log.warn(`No se pudo procesar el lote ${idEnvio}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      if (procesados > 0) this.log.log(`${procesados} lote(s) fiscal(es) (baja/resumen) procesados en ${modo.ambiente}.`);
      return procesados;
    } catch (error) {
      this.log.warn(`La tarea de lotes fiscales no pudo completar la vuelta: ${error instanceof Error ? error.message : String(error)}`);
      return 0;
    } finally {
      this.enCurso = false;
    }
  }
}

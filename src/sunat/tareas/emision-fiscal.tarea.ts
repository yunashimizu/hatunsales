import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { FiscalConfigError } from '../config/fiscal-errores';
import { FiscalConfigService } from '../config/fiscal-config.service';
import type { EstadoOperativoFiscal, FuenteEstadoOperativoFiscal } from '../config/fiscal-tokens';
import { RelojFiscal } from '../config/reloj-fiscal';
import { EmisionDirecta } from '../emision/emision.contrato';
import { EnvioFiscalRepository } from '../emision/envio-fiscal.repository';
import { SunatEmisionService } from '../emision/sunat-emision.service';

/** Primera vuelta: entre 60 y 120 s después de arrancar (el azar separa a las réplicas). */
const RETRASO_INICIAL_MS = 60_000;
const DISPERSION_INICIAL_MS = 60_000;

/**
 * Tarea programada de la emisión (D7): cada 2 minutos toma hasta 10 envíos del ambiente VIGENTE que
 * quedaron pendientes de reintento (cuando les llega el turno del backoff 2, 5, 15, 30 y 60 min) o en
 * ENVIANDO con el reclamo vencido (el proceso cayó tras el COMMIT), y los manda por el MISMO camino
 * seguro del reintento manual: en producción las facturas consultan antes su CDR, se respetan los
 * plazos y el interruptor, y tras 6 intentos el envío queda en EXCEPCION para revisarlo a mano.
 * Nunca toca los que esperan recuperar el CDR o una confirmación manual (RECUPERAR_CDR).
 *
 * Varias réplicas: cada envío se reclama por separado (FOR UPDATE SKIP LOCKED + plazo de 60 s), así
 * dos instancias nunca mandan el mismo; no se usan candados de sesión. Solo corre con
 * fiscal_tareas_activas y la emisión activa. También aporta la cola y los plazos a GET /fiscal/estado.
 */
@Injectable()
export class EmisionFiscalTarea implements OnApplicationBootstrap, OnModuleDestroy, FuenteEstadoOperativoFiscal {
  static readonly INTERVALO_MS = 2 * 60_000;
  static readonly ENVIOS_POR_VUELTA = 10;

  private readonly log = new Logger(EmisionFiscalTarea.name);
  private temporizador: NodeJS.Timeout | null = null;
  private primera: NodeJS.Timeout | null = null;
  private enCurso = false;
  private ultimaEjecucion: string | null = null;

  constructor(
    private readonly config: FiscalConfigService,
    private readonly emisionDirecta: EmisionDirecta,
    private readonly emision: SunatEmisionService,
    private readonly envios: EnvioFiscalRepository,
    private readonly reloj: RelojFiscal,
  ) {}

  onApplicationBootstrap(): void {
    const retraso = RETRASO_INICIAL_MS + Math.floor(Math.random() * DISPERSION_INICIAL_MS);
    this.primera = setTimeout(() => void this.ejecutar(), retraso);
    this.primera.unref?.();
    this.temporizador = setInterval(() => void this.ejecutar(), EmisionFiscalTarea.INTERVALO_MS);
    this.temporizador.unref?.();
  }

  onModuleDestroy(): void {
    if (this.primera) clearTimeout(this.primera);
    if (this.temporizador) clearInterval(this.temporizador);
    this.primera = null;
    this.temporizador = null;
  }

  /** Una vuelta: devuelve cuántos envíos procesó (0 si no le tocaba o si otra réplica los tomó). */
  async ejecutar(): Promise<number> {
    if (this.enCurso) return 0;
    this.enCurso = true;
    try {
      if (!(await this.config.tareasActivas())) return 0;
      const modo = await this.emisionDirecta.modo();
      if (!modo.activo) return 0;
      this.ultimaEjecucion = this.reloj.ahora().toISOString();

      const candidatos = await this.envios.candidatosTarea(modo.ambiente, EmisionFiscalTarea.ENVIOS_POR_VUELTA);
      let procesados = 0;
      for (const idEnvio of candidatos) {
        try {
          await this.emision.reintentar(idEnvio, 'tarea');
          procesados += 1;
        } catch (error) {
          // SUNAT acaba de rechazar la credencial o el certificado: no se insiste con los demás.
          if (FiscalConfigError.es(error, 'FISCAL_EMISION_BLOQUEADA')) break;
          // Otra réplica (o el administrador) lo tomó primero, o ya cambió de estado.
          if (FiscalConfigError.es(error, 'FISCAL_ENVIO_EN_CURSO') || FiscalConfigError.es(error, 'FISCAL_REENVIO_NO_PERMITIDO')) continue;
          this.log.warn(`No se pudo reintentar el envío ${idEnvio}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      if (procesados > 0) this.log.log(`${procesados} envío(s) a SUNAT reintentados en ${modo.ambiente}.`);
      return procesados;
    } catch (error) {
      this.log.warn(`La tarea de emisión fiscal no pudo completar la vuelta: ${error instanceof Error ? error.message : String(error)}`);
      return 0;
    } finally {
      this.enCurso = false;
    }
  }

  /** Cola {pendientes, inciertos} y plazos {vencen_hoy, vencidos} del ambiente vigente para GET /fiscal/estado. */
  async estadoOperativo(): Promise<EstadoOperativoFiscal> {
    const modo = await this.emisionDirecta.modo();
    const [contadores, activas] = await Promise.all([
      this.envios.contadores(modo.ambiente, this.reloj.fechaLima()),
      this.config.tareasActivas(),
    ]);
    return {
      emision: modo.activo
        ? { activa: true, ambiente: modo.ambiente }
        : { activa: false, ambiente: modo.ambiente, codigo: modo.codigo, motivo: modo.motivo },
      cola: { pendientes: contadores.pendientes, inciertos: contadores.inciertos },
      plazos: { vencen_hoy: contadores.vencen_hoy, vencidos: contadores.vencidos },
      tareas: { activas, ultima_ejecucion: this.ultimaEjecucion },
    };
  }
}

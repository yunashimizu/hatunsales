import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { FiscalConfigError } from '../config/fiscal-errores';
import { FiscalConfigService } from '../config/fiscal-config.service';
import { ACTOR_SISTEMA } from '../config/fiscal-config.tipos';
import type { AmbienteFiscal } from '../config/fiscal-config.tipos';
import { RelojFiscal } from '../config/reloj-fiscal';
import { EmisionDirecta } from '../emision/emision.contrato';
import { horaLima } from '../nucleo/fechas-fiscales';
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
 * Además crea los resúmenes diarios de adición (RC, condición 1): en el modo «resumen» de boletas, uno por fecha de
 * emisión a la hora configurada (fiscal_resumen_hora, Lima) y, en cualquier vuelta, para las fechas anteriores que
 * todavía tengan boletas POR_RESUMIR; y en cualquier modo, uno por fecha con las boletas que fallaron en el envío
 * individual y ya pasaron los 5 días (todavía dentro de los 7), para que un corte largo de SUNAT no las deje fuera de plazo.
 * Lo que SUNAT ya rechazó en un resumen no se vuelve a intentar solo.
 *
 * Varias réplicas: cada lote se reclama por separado con un UPDATE condicionado (plazo de 60 s), así dos
 * instancias nunca lo procesan a la vez; no se usan candados de sesión. Solo corre con
 * fiscal_tareas_activas y la emisión activa.
 */
@Injectable()
export class LotesFiscalesTarea implements OnApplicationBootstrap, OnModuleDestroy {
  static readonly INTERVALO_MS = 2 * 60_000;
  static readonly LOTES_POR_VUELTA = 10;
  /** Resúmenes de adición que una vuelta puede crear (cada uno ya se envía en el acto). */
  static readonly RESUMENES_POR_VUELTA = 3;

  private readonly log = new Logger(LotesFiscalesTarea.name);
  private temporizador: NodeJS.Timeout | null = null;
  private primera: NodeJS.Timeout | null = null;
  private enCurso = false;

  constructor(
    private readonly config: FiscalConfigService,
    private readonly emisionDirecta: EmisionDirecta,
    private readonly lotes: LotesFiscalesService,
    private readonly repositorio: LoteFiscalRepository,
    private readonly reloj: RelojFiscal,
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

      const creados = await this.crearResumenes(modo.ambiente);
      const candidatos = await this.repositorio.candidatosTarea(modo.ambiente, LotesFiscalesTarea.LOTES_POR_VUELTA);
      let procesados = creados;
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
      if (procesados > 0) this.log.log(`${procesados} lote(s) fiscal(es) (baja/resumen) procesados o creados en ${modo.ambiente}.`);
      return procesados;
    } catch (error) {
      this.log.warn(`La tarea de lotes fiscales no pudo completar la vuelta: ${error instanceof Error ? error.message : String(error)}`);
      return 0;
    } finally {
      this.enCurso = false;
    }
  }

  /**
   * Crea los resúmenes de adición que toquen en esta vuelta (ver la descripción de la clase). Nunca lanza: un fallo se
   * deja en el log y no impide procesar los lotes pendientes. Devuelve cuántos resúmenes creó.
   */
  private async crearResumenes(ambiente: AmbienteFiscal): Promise<number> {
    let creados = 0;
    try {
      const snapshot = await this.config.snapshot();
      const hoy = this.reloj.fechaLima();
      const horaActual = horaLima(this.reloj.ahora()).slice(0, 5);
      const enModoResumen = snapshot.boletasModo === 'resumen';

      const crear = async (fecha: string): Promise<boolean> => {
        try {
          const resultado = await this.lotes.crearResumenAdicion({ fecha_emision: fecha, actor: ACTOR_SISTEMA, origen: 'tarea' });
          if (resultado) creados += 1;
          return true;
        } catch (error) {
          // La emisión quedó detenida: no se insiste con ninguna fecha más en esta vuelta.
          if (FiscalConfigError.es(error, 'FISCAL_EMISION_BLOQUEADA')) return false;
          // Otro proceso tomó alguna boleta a la vez, o ya pasó el plazo: se revisa en la próxima vuelta.
          if (FiscalConfigError.es(error, 'FISCAL_ENVIO_EN_CURSO') || FiscalConfigError.es(error, 'FISCAL_RESUMEN_FUERA_DE_PLAZO')) return true;
          this.log.warn(`No se pudo crear el resumen diario del ${fecha}: ${error instanceof Error ? error.message : String(error)}`);
          return true;
        }
      };

      // Boletas del modo «resumen»: las de hoy esperan la hora configurada; las de días anteriores van en cuanto se pueda.
      const porResumir = await this.repositorio.fechasConResumenPendiente({ ambiente, hoy, grupo: 'por_resumir', limite: 8 });
      for (const { fecha } of porResumir) {
        if (creados >= LotesFiscalesTarea.RESUMENES_POR_VUELTA) return creados;
        if (enModoResumen && fecha === hoy && horaActual < snapshot.resumenHora) continue;
        if (!(await crear(fecha))) return creados;
      }

      // Boletas que fallaron en el envío individual y ya pasaron los 5 días: entran solas a un resumen (hasta el 7.º día).
      const atrasadas = await this.repositorio.fechasConResumenPendiente({ ambiente, hoy, grupo: 'atrasadas', limite: 4 });
      for (const { fecha } of atrasadas) {
        if (creados >= LotesFiscalesTarea.RESUMENES_POR_VUELTA) return creados;
        if (!(await crear(fecha))) return creados;
      }
    } catch (error) {
      this.log.warn(`La tarea de lotes fiscales no pudo revisar los resúmenes diarios: ${error instanceof Error ? error.message : String(error)}`);
    }
    return creados;
  }
}

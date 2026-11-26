import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { CajaSesionRepository } from '../../repository/Repository/caja-sesion.repository';
import { CajaSesionBussnies } from '../../bussnies/Bussnies/caja-sesion.bussnies';
import { ControlCajaService } from '../configuracion/control-caja.service';

/**
 * Tarea programada (Fase 7.4, D8): cierra los turnos de caja que quedaron abiertos más de
 * `caja_cierre_automatico_horas` (configuraciones; 0 = apagado, que es el valor por defecto; sugerido 16).
 *
 * Mismo patrón que CreditoVencimientosTarea: un temporizador por proceso y, con varias réplicas, solo una
 * busca los turnos en cada vuelta (pg_try_advisory_xact_lock en CajaSesionRepository.turnosOlvidados).
 * La clave se lee en cada vuelta (caché de 60 s): encenderla o apagarla no requiere reiniciar.
 * CAJA_CIERRE_AUTOMATICO_INTERVALO_MIN (minutos, por defecto 15; 0 apaga el temporizador por completo).
 */
const MINUTOS_POR_DEFECTO = 15;
const RETRASO_INICIAL_MS = 120_000;
/** Turnos que se cierran como máximo en una vuelta (los demás, en la siguiente). */
const POR_VUELTA = 20;

export function intervaloCierreAutomaticoMs(valor = process.env.CAJA_CIERRE_AUTOMATICO_INTERVALO_MIN): number {
  if (valor === undefined || valor.trim() === '') return MINUTOS_POR_DEFECTO * 60_000;
  const minutos = Number(valor);
  if (!Number.isFinite(minutos) || minutos <= 0) return 0;
  return Math.max(5, Math.min(minutos, 24 * 60)) * 60_000;
}

@Injectable()
export class CierreAutomaticoTarea implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger(CierreAutomaticoTarea.name);
  private temporizador: NodeJS.Timeout | null = null;
  private primera: NodeJS.Timeout | null = null;
  private enCurso = false;

  constructor(
    private readonly repo: CajaSesionRepository,
    private readonly sesiones: CajaSesionBussnies,
    private readonly control: ControlCajaService,
  ) {}

  onApplicationBootstrap(): void {
    const cada = intervaloCierreAutomaticoMs();
    if (!cada) {
      this.log.log('Tarea de cierre automático de turnos desactivada (CAJA_CIERRE_AUTOMATICO_INTERVALO_MIN=0).');
      return;
    }
    this.primera = setTimeout(() => void this.ejecutar(), RETRASO_INICIAL_MS);
    this.primera.unref?.();
    this.temporizador = setInterval(() => void this.ejecutar(), cada);
    this.temporizador.unref?.();
  }

  onModuleDestroy(): void {
    if (this.primera) clearTimeout(this.primera);
    if (this.temporizador) clearInterval(this.temporizador);
    this.primera = null;
    this.temporizador = null;
  }

  /** Una vuelta: devuelve cuántos turnos cerró (0 con la clave en 0, sin turnos olvidados o si otra réplica la tomó). */
  async ejecutar(): Promise<number> {
    if (this.enCurso) return 0;
    this.enCurso = true;
    try {
      const horas = await this.control.horasCierreAutomatico();
      if (!(horas > 0)) return 0;
      const ids = await this.repo.turnosOlvidados(horas, POR_VUELTA);
      let cerrados = 0;
      for (const id of ids) {
        try {
          if (await this.sesiones.cerrarAutomatico(id, horas)) cerrados += 1;
        } catch (error: any) {
          // Un turno que falla no frena a los demás; se reintenta en la próxima vuelta.
          this.log.warn(`No se pudo cerrar automáticamente el turno ${id}: ${error?.message ?? error}`);
        }
      }
      if (cerrados > 0) this.log.log(`${cerrados} turno(s) de caja cerrados automáticamente (más de ${horas} h abiertos).`);
      return cerrados;
    } catch (error: any) {
      this.log.warn(`No se pudo revisar los turnos olvidados: ${error?.message ?? error}`);
      return 0;
    } finally {
      this.enCurso = false;
    }
  }
}

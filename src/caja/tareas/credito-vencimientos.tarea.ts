import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { CreditoRepository } from '../../repository/Repository/credito.repository';

/**
 * Tarea programada: marca como 'vencido' las cuentas por cobrar cuya fecha de vencimiento
 * (hora de Lima) ya pasó. Antes se hacía con un UPDATE en cada GET /credito/cuentas; ahora los
 * GET no escriben (calculan el estado al leer) y esto persiste el estado una vez por hora.
 *
 * Con varias réplicas solo una lo ejecuta en cada vuelta (pg_try_advisory_xact_lock en el
 * repositorio). CREDITO_VENCIMIENTO_INTERVALO_MIN (minutos, por defecto 60; 0 lo apaga).
 */
const MINUTOS_POR_DEFECTO = 60;
const RETRASO_INICIAL_MS = 90_000;

export function intervaloVencimientosMs(valor = process.env.CREDITO_VENCIMIENTO_INTERVALO_MIN): number {
  if (valor === undefined || valor.trim() === '') return MINUTOS_POR_DEFECTO * 60_000;
  const minutos = Number(valor);
  if (!Number.isFinite(minutos) || minutos <= 0) return 0;
  return Math.max(5, Math.min(minutos, 24 * 60)) * 60_000;
}

@Injectable()
export class CreditoVencimientosTarea implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger(CreditoVencimientosTarea.name);
  private temporizador: NodeJS.Timeout | null = null;
  private primera: NodeJS.Timeout | null = null;
  private enCurso = false;

  constructor(private readonly repo: CreditoRepository) {}

  onApplicationBootstrap(): void {
    const cada = intervaloVencimientosMs();
    if (!cada) {
      this.log.log('Tarea de vencimientos de crédito desactivada (CREDITO_VENCIMIENTO_INTERVALO_MIN=0).');
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

  /** Una vuelta: devuelve cuántas cuentas pasó a 'vencido' (0 si otra réplica la tomó). */
  async ejecutar(): Promise<number> {
    if (this.enCurso) return 0;
    this.enCurso = true;
    try {
      const cambiadas = await this.repo.marcarVencidas();
      if (cambiadas > 0) this.log.log(`${cambiadas} cuenta(s) por cobrar pasaron a vencido.`);
      return cambiadas;
    } catch (error: any) {
      this.log.warn(`No se pudieron marcar los vencimientos de crédito: ${error?.message ?? error}`);
      return 0;
    } finally {
      this.enCurso = false;
    }
  }
}

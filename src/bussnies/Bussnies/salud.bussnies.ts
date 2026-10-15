import { Injectable } from '@nestjs/common';
import { versionDespliegue } from '../../config/runtime.config';
import type { ResultadoPingBd, SaludResponse } from '../../models/model/salud.response';
import { SaludRepository } from '../../repository/Repository/salud.repository';
import type { ISaludBussniees } from '../Ibussnies/ISaludBussniees';

/** Tiempo máximo del ping a la BD. */
export const TIEMPO_MAXIMO_PING_MS = 3_000;
/** Un monitor agresivo (o un ataque) no genera más de un SELECT 1 cada 2 s. */
export const CACHE_PING_MS = 2_000;

@Injectable()
export class SaludBussnies implements ISaludBussniees {
  private ultimoPing: { readonly valor: Promise<ResultadoPingBd>; readonly vence: number } | null = null;

  constructor(private readonly saludRepo: SaludRepository) {}

  async estado(): Promise<SaludResponse> {
    const ping = await this.pingCompartido();
    const bdOk = ping.estado === 'ok';
    return {
      estado: bdOk ? 'ok' : 'degradado',
      bd: ping.estado,
      bd_ms: bdOk ? ping.ms : null,
      version: versionDespliegue(),
      uptime_s: Math.floor(process.uptime()),
      fecha: new Date().toISOString(),
    };
  }

  /** Las peticiones simultáneas comparten el mismo ping (y su resultado por 2 s). */
  private pingCompartido(): Promise<ResultadoPingBd> {
    const ahora = Date.now();
    if (this.ultimoPing && ahora < this.ultimoPing.vence) return this.ultimoPing.valor;
    const valor = this.saludRepo.ping(TIEMPO_MAXIMO_PING_MS);
    this.ultimoPing = { valor, vence: ahora + CACHE_PING_MS };
    return valor;
  }
}

import { numeroEntorno } from '../../../config/runtime.config';

/**
 * Separación mínima por omisión entre dos peticiones a un mismo servicio de SUNAT. En BETA, dos envíos
 * pegados (menos de ~100 ms) reciben un 401 de nginx sin SOAP Fault; con 150 ms pasaron todos.
 */
export const RITMO_MINIMO_POR_OMISION_MS = 300;
export const RITMO_MAXIMO_MS = 5_000;

const esperarPorOmision = (ms: number) => new Promise<void>((resolver) => setTimeout(resolver, ms));

/**
 * Ordena las salidas hacia SUNAT dentro del proceso: cada petición a un mismo servicio sale al menos
 * `minimoMs` después de la anterior (de cualquier cliente SOAP, de la venta o de las tareas).
 * El turno se reserva de forma síncrona, así que varias llamadas simultáneas quedan escalonadas.
 * Con `minimoMs` en 0 no espera nunca.
 */
export class RitmoPeticiones {
  private readonly ultimaSalida = new Map<string, number>();

  constructor(
    private readonly minimoMs: number,
    private readonly ahora: () => number = Date.now,
    private readonly esperar: (ms: number) => Promise<void> = esperarPorOmision,
  ) {}

  async turno(servicio: string): Promise<void> {
    if (this.minimoMs <= 0) return;
    const ahora = this.ahora();
    const anterior = this.ultimaSalida.get(servicio);
    const salida = anterior === undefined ? ahora : Math.max(ahora, anterior + this.minimoMs);
    this.ultimaSalida.set(servicio, salida);
    if (salida > ahora) await this.esperar(salida - ahora);
  }
}

/** `SUNAT_RITMO_MIN_MS`: milisegundos entre peticiones a SUNAT (0 lo desactiva). */
export function ritmoMinimoDesdeEntorno(): number {
  return Math.trunc(numeroEntorno('SUNAT_RITMO_MIN_MS', RITMO_MINIMO_POR_OMISION_MS, { min: 0, max: RITMO_MAXIMO_MS }));
}

/** Ritmo compartido por todos los clientes SOAP del proceso. */
export const RITMO_SUNAT = new RitmoPeticiones(ritmoMinimoDesdeEntorno());

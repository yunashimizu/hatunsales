import type { ResultadoPingBd } from '../../models/model/salud.response';

export interface ISaludRepository {
  /** `SELECT 1` con tiempo máximo; nunca lanza. */
  ping(tiempoMaximoMs: number): Promise<ResultadoPingBd>;
}

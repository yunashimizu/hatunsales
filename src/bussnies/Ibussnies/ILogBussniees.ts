import type { RegistroLogResponse } from '../../models/model/log.response';

export interface ILogBussniees {
  /** Últimas acciones registradas (máximo 500). */
  listar(): Promise<RegistroLogResponse[]>;
}

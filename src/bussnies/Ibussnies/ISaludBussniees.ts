import type { SaludResponse } from '../../models/model/salud.response';

export interface ISaludBussniees {
  /** Estado del servicio y de la base de datos (para monitores externos). */
  estado(): Promise<SaludResponse>;
}

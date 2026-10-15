import type { RegistroLogResponse } from '../../models/model/log.response';

export interface ILogRepository {
  /** Registra una acción; nunca hace fallar la operación principal. */
  registrar(accion: string, entidad: string, idUsuario?: number | null): Promise<void>;
  /** Últimas acciones, de la más reciente a la más antigua. */
  ultimos(limite: number): Promise<RegistroLogResponse[]>;
  /** true si la tabla `auditoria` existe (lee el catálogo, sin DDL). */
  tablaDisponible(): Promise<boolean>;
}

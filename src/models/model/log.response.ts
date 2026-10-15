/** Fila de GET /log: misma forma que tenía el log antiguo de SQLite. */
export interface RegistroLogResponse {
  idlog: number;
  accion: string;
  entidad: string;
  fecha: Date | null;
}

import { Injectable } from '@nestjs/common';
import type { RegistroLogResponse } from '../../models/model/log.response';
import { LogRepository } from '../../repository/Repository/log-repository';
import { EsquemaPendienteError } from '../../util/http/errores/esquema-pendiente.error';
import type { ILogBussniees } from '../Ibussnies/ILogBussniees';

export const SCRIPT_TABLA_AUDITORIA = 'sql/fase10_indices_rendimiento.sql';

@Injectable()
export class LogBussnies implements ILogBussniees {
  static readonly MAXIMO_FILAS = 500;

  constructor(private readonly logRepo: LogRepository) {}

  async listar(): Promise<RegistroLogResponse[]> {
    if (!(await this.logRepo.tablaDisponible())) {
      throw new EsquemaPendienteError(SCRIPT_TABLA_AUDITORIA, 'falta la tabla auditoria');
    }
    return this.logRepo.ultimos(LogBussnies.MAXIMO_FILAS);
  }
}

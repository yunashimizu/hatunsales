import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

/** Lo único que los repositorios fiscales necesitan para hablar SQL (DataSource o EntityManager). */
export interface EjecutorSql {
  query(sql: string, parametros?: unknown[]): Promise<any>;
}

/**
 * Filas de un resultado de `query()`. En PostgreSQL, TypeORM devuelve
 * `[filas, filasAfectadas]` para UPDATE y DELETE (con o sin RETURNING) y
 * directamente las filas para SELECT e INSERT. Las filas son objetos, nunca
 * arreglos, así que la forma es inequívoca.
 */
export function filasDe<T>(resultado: unknown): T[] {
  if (!Array.isArray(resultado)) return [];
  if (resultado.length === 2 && Array.isArray(resultado[0]) && typeof resultado[1] === 'number') {
    return resultado[0] as T[];
  }
  return resultado as T[];
}

/**
 * Unidad de trabajo: agrupa escrituras de varios repositorios en una sola
 * transacción corta. Todas fijan lock_timeout y statement_timeout locales para
 * no quedarse esperando detrás de otra transacción (ni bloquear a las cajas).
 */
export abstract class TransaccionesFiscales {
  abstract ejecutar<T>(trabajo: (ejecutor: EjecutorSql) => Promise<T>): Promise<T>;
}

@Injectable()
export class TransaccionesFiscalesPg extends TransaccionesFiscales {
  static readonly LOCK_TIMEOUT = '5s';
  static readonly STATEMENT_TIMEOUT = '20s';

  constructor(
    @InjectDataSource('pgConnection')
    private readonly dataSource: DataSource,
  ) {
    super();
  }

  ejecutar<T>(trabajo: (ejecutor: EjecutorSql) => Promise<T>): Promise<T> {
    return this.dataSource.transaction(async (manager) => {
      await manager.query(
        `SELECT set_config('lock_timeout', $1, true), set_config('statement_timeout', $2, true)`,
        [TransaccionesFiscalesPg.LOCK_TIMEOUT, TransaccionesFiscalesPg.STATEMENT_TIMEOUT],
      );
      return trabajo(manager);
    });
  }
}

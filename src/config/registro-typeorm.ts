import { Logger } from '@nestjs/common';
import type { Logger as LoggerTypeorm } from 'typeorm';
import { ContextoPeticion } from '../util/http/contexto-peticion';
import { mensajePgSeguro, sqlSeguro } from '../util/http/enmascarar';
import { esErrorPgOperativo } from '../util/http/errores/reglas-postgres';

type Registrador = Pick<Logger, 'warn' | 'log' | 'debug'>;

/**
 * Logger de TypeORM sin datos personales: NUNCA escribe los parámetros de las
 * consultas (llevan DNI, correos y hashes) y enmascara literales del SQL.
 * Registra consultas lentas (maxQueryExecutionTime) y fallos operativos
 * (bloqueos, timeouts, conexión, esquema) con el id de la petición.
 */
export class RegistroTypeorm implements LoggerTypeorm {
  constructor(private readonly registrador: Registrador = new Logger('BD')) {}

  logQuery(): void {
    // Cada consulta: demasiado volumen para producción.
  }

  logQueryError(error: string | Error, query: string): void {
    const codigo = typeof error === 'object' && error ? String((error as { code?: unknown }).code ?? '') : '';
    const mensaje = typeof error === 'string' ? error : error?.message;
    const linea = `Consulta fallida${codigo ? ` (${codigo})` : ''}${this.idPeticion()}: ${mensajePgSeguro(mensaje)} · SQL: ${sqlSeguro(query)}`;
    // Duplicados, FK y datos inválidos los traduce el filtro global: aquí solo van a debug.
    if (!codigo || esErrorPgOperativo(codigo)) this.registrador.warn(linea);
    else this.registrador.debug(linea);
  }

  logQuerySlow(tiempo: number, query: string): void {
    this.registrador.warn(`Consulta lenta (${Math.round(tiempo)} ms)${this.idPeticion()}: ${sqlSeguro(query)}`);
  }

  logSchemaBuild(): void {
    // synchronize está apagado: no hay construcción de esquema.
  }

  logMigration(): void {
    // Las migraciones son scripts SQL manuales (carpeta sql/).
  }

  log(nivel: 'log' | 'info' | 'warn', mensaje: unknown): void {
    const texto = mensajePgSeguro(String(mensaje ?? ''));
    if (nivel === 'warn') this.registrador.warn(texto);
    else this.registrador.log(texto);
  }

  private idPeticion(): string {
    const id = ContextoPeticion.idActual();
    return id ? ` [${id}]` : '';
  }
}

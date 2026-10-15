/**
 * Normaliza lo que devuelve `DataSource.query` / `EntityManager.query` de TypeORM 0.3 con
 * PostgreSQL: en SELECT e INSERT devuelve las filas, pero en UPDATE y DELETE devuelve
 * `[filas, filasAfectadas]` (PostgresQueryRunner). Leer `resultado[0]` de un UPDATE … RETURNING
 * daba el arreglo de filas (siempre "verdadero") en vez de la primera fila.
 */
export function filasDe<T = any>(resultado: unknown): T[] {
  if (
    Array.isArray(resultado)
    && resultado.length === 2
    && Array.isArray(resultado[0])
    && typeof resultado[1] === 'number'
  ) {
    return resultado[0] as T[];
  }
  return Array.isArray(resultado) ? (resultado as T[]) : [];
}

/** Filas afectadas de un UPDATE/DELETE (o filas devueltas si no viene el conteo). */
export function afectadasDe(resultado: unknown): number {
  if (
    Array.isArray(resultado)
    && resultado.length === 2
    && Array.isArray(resultado[0])
    && typeof resultado[1] === 'number'
  ) {
    return resultado[1];
  }
  return Array.isArray(resultado) ? resultado.length : 0;
}

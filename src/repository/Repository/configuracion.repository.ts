import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

/**
 * Lectura y escritura de la tabla `configuraciones`, que es un simple
 * diccionario clave/valor.
 *
 * Los valores se guardan en memoria por un rato porque se consultan en cada
 * venta y casi nunca cambian.
 */

const VIGENCIA_CACHE_MS = 60_000;

@Injectable()
export class ConfiguracionRepository {

  private cache = new Map<string, { valor: string | null; expira: number }>();

  constructor(
    @InjectDataSource('pgConnection')
    private readonly dataSource: DataSource,
  ) {}

  async obtener(clave: string): Promise<string | null> {
    const enCache = this.cache.get(clave);
    if (enCache && enCache.expira > Date.now()) return enCache.valor;

    const filas = await this.dataSource.query(
      'SELECT valor FROM configuraciones WHERE clave = $1 LIMIT 1',
      [clave],
    );

    const bruto = filas[0]?.valor;
    const valor = bruto === undefined || bruto === null || bruto === '' ? null : String(bruto);
    this.cache.set(clave, { valor, expira: Date.now() + VIGENCIA_CACHE_MS });
    return valor;
  }

  async obtenerNumero(clave: string, porDefecto: number): Promise<number> {
    const valor = await this.obtener(clave);
    const numero = Number(valor);
    return Number.isFinite(numero) ? numero : porDefecto;
  }

  async obtenerBooleano(clave: string, porDefecto: boolean): Promise<boolean> {
    const valor = await this.obtener(clave);
    if (valor === null) return porDefecto;
    return ['true', '1', 'si', 'sí'].includes(valor.toLowerCase());
  }

  async obtenerTexto(clave: string, porDefecto: string): Promise<string> {
    return (await this.obtener(clave)) ?? porDefecto;
  }

  /** Trae varias claves de una sola consulta. */
  async obtenerVarias(claves: string[]): Promise<Record<string, string | null>> {
    if (!claves.length) return {};

    const filas = await this.dataSource.query(
      'SELECT clave, valor FROM configuraciones WHERE clave = ANY($1)',
      [claves],
    );

    const resultado: Record<string, string | null> = {};
    for (const clave of claves) resultado[clave] = null;
    for (const fila of filas) {
      const valor = fila.valor === '' || fila.valor === null ? null : String(fila.valor);
      resultado[fila.clave] = valor;
      this.cache.set(fila.clave, { valor, expira: Date.now() + VIGENCIA_CACHE_MS });
    }
    return resultado;
  }

  async guardar(clave: string, valor: string): Promise<void> {
    await this.dataSource.query(
      `INSERT INTO configuraciones (clave, valor) VALUES ($1, $2)
       ON CONFLICT (clave) DO UPDATE SET valor = EXCLUDED.valor`,
      [clave, valor],
    );
    this.cache.delete(clave);
  }

  limpiarCache(): void {
    this.cache.clear();
  }
}

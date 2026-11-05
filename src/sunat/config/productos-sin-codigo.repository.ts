import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

/**
 * Cuenta los productos activos sin código de producto SUNAT (catálogo 25) para la advertencia del
 * checklist de activación. Solo lee: no es un requisito bloqueante y nunca debe tumbar la evaluación.
 */
@Injectable()
export class ProductosSinCodigoSunatRepository {
  private readonly logger = new Logger(ProductosSinCodigoSunatRepository.name);

  constructor(@InjectDataSource('pgConnection') private readonly dataSource: DataSource) {}

  /** Cantidad de productos activos sin código; `null` si no se pudo consultar (tabla o columna ausente). */
  async contar(): Promise<number | null> {
    try {
      const filas: Array<{ total: number | string }> = await this.dataSource.query(
        `SELECT COUNT(*)::int AS total FROM productos WHERE codigo_sunat IS NULL AND COALESCE(estado, true)`,
      );
      const total = Number(filas?.[0]?.total);
      return Number.isFinite(total) ? total : null;
    } catch (error) {
      this.logger.warn(`No se pudo contar los productos sin código SUNAT: ${(error as Error)?.message ?? error}`);
      return null;
    }
  }
}

import { EntitiesMetadataStorage } from '@nestjs/typeorm/dist/entities-metadata.storage';
import { DataSource } from 'typeorm';
// Registra las entidades de forFeature, incluidas las aportadas por REGISTROS.
import '../app.module';
import { AbonoCredito } from '../models/DBModel/abono-credito.entity';
import { postgresConfig } from './database.config';

class DataSourceSinConexion extends DataSource {
  validarMetadatos(): Promise<void> {
    return this.buildMetadatas();
  }
}

describe('metadatos de todas las entidades PostgreSQL del backend', () => {
  it('supera la validación de arranque de TypeORM sin conectarse ni modificar la base', async () => {
    const configuradas = postgresConfig.entities ?? [];
    const base = Array.isArray(configuradas) ? configuradas : Object.values(configuradas);
    const entidades = [...new Set([
      ...base,
      ...EntitiesMetadataStorage.getEntitiesByDataSource('pgConnection'),
    ])];
    const fuente = new DataSourceSinConexion({
      type: 'postgres', entities: entidades, synchronize: false,
    });

    await expect(fuente.validarMetadatos()).resolves.toBeUndefined();
    expect(fuente.hasMetadata(AbonoCredito)).toBe(true);
    expect(fuente.entityMetadatas.length).toBeGreaterThanOrEqual(entidades.length);
    expect(fuente.isInitialized).toBe(false);
  });
});

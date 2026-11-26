import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { CacheTtl } from '../sunat/config/cache-ttl';
import { filasDe } from '../sunat/config/transacciones-fiscales';

/**
 * ¿Existe la tabla productos_imagenes_mejora (sql/fase23_mejora_fotos.sql)? La usan el repositorio de la
 * mejora y BaseDatosAlmacen (que elige entre dos textos del borrado: una consulta que nombra una tabla
 * inexistente falla entera). Propia del dominio: no depende de EsquemaCajaService.
 *
 * Se pregunta una vez cada 10 minutos si existe y cada 60 s mientras falte: tras correr el script se
 * activa sola en menos de un minuto.
 */
@Injectable()
export class EsquemaMejoraFotos {
  private readonly cache = new CacheTtl<boolean>((existe) => (existe ? 10 * 60_000 : 60_000));

  constructor(@InjectDataSource('pgConnection') private readonly bd: DataSource) {}

  disponible(): Promise<boolean> {
    return this.cache.obtener('tabla', async () => {
      try {
        const filas = filasDe<{ existe: boolean }>(
          await this.bd.query(`SELECT to_regclass('public.productos_imagenes_mejora') IS NOT NULL AS existe`),
        );
        return filas[0]?.existe === true;
      } catch {
        return false;
      }
    });
  }
}

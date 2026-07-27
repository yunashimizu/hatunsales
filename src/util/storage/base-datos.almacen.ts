import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { createHash } from 'crypto';
import { AlmacenArchivos, ArchivoEntrada, ArchivoGuardado } from './almacen.interface';

/**
 * Guarda la imagen dentro de PostgreSQL, en la tabla `archivos`.
 *
 * Es el proveedor por defecto porque sobrevive a los despliegues sin depender
 * de ningún servicio externo. Se sirve por `/archivos/:id` con cabeceras de
 * caché largas, así el navegador la pide una sola vez.
 */
@Injectable()
export class BaseDatosAlmacen implements AlmacenArchivos {

  readonly nombre = 'base_datos';

  constructor(
    @InjectDataSource('pgConnection')
    private readonly dataSource: DataSource,
  ) {}

  async guardar(entrada: ArchivoEntrada): Promise<ArchivoGuardado> {
    // El hash permite reutilizar la fila si se sube dos veces la misma imagen.
    const hash = createHash('sha256').update(entrada.buffer).digest('hex');

    const existente = await this.dataSource.query(
      'SELECT id_archivo FROM archivos WHERE hash = $1 LIMIT 1',
      [hash],
    );

    const idArchivo = existente[0]?.id_archivo
      ? Number(existente[0].id_archivo)
      : await this.insertar(entrada, hash);

    const url = `/archivos/${idArchivo}`;

    return {
      url,
      thumb_url: url,
      clave: String(idArchivo),
      mime: entrada.mime,
      size: entrada.buffer.length,
      proveedor: this.nombre,
    };
  }

  private async insertar(entrada: ArchivoEntrada, hash: string): Promise<number> {
    const filas = await this.dataSource.query(
      `INSERT INTO archivos (nombre, mime, size, hash, carpeta, contenido, creado_en)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       RETURNING id_archivo`,
      [
        entrada.nombre_original.slice(0, 200),
        entrada.mime,
        entrada.buffer.length,
        hash,
        entrada.carpeta,
        entrada.buffer,
      ],
    );
    return Number(filas[0].id_archivo);
  }

  async eliminar(clave: string): Promise<void> {
    const id = Number(clave);
    if (!Number.isFinite(id)) return;
    await this.dataSource.query('DELETE FROM archivos WHERE id_archivo = $1', [id]);
  }

  async leer(id: number): Promise<{ contenido: Buffer; mime: string; hash: string } | null> {
    const filas = await this.dataSource.query(
      'SELECT contenido, mime, hash FROM archivos WHERE id_archivo = $1 LIMIT 1',
      [id],
    );

    const fila = filas[0];
    if (!fila) return null;

    return {
      contenido: Buffer.isBuffer(fila.contenido) ? fila.contenido : Buffer.from(fila.contenido),
      mime: fila.mime ?? 'application/octet-stream',
      hash: fila.hash ?? String(id),
    };
  }
}

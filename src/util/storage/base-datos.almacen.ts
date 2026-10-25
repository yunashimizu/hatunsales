import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { createHash } from 'crypto';
import { AlmacenArchivos, ArchivoEntrada, ArchivoGuardado } from './almacen.interface';

/**
 * Borra la fila solo si nadie más la usa. $1 = id_archivo, $2 = URL pública
 * (`/archivos/N`), $3 = clave guardada en productos_imagenes (el id como texto).
 * Revisa todo lo que guarda esa URL: imágenes de producto, fotos de recepción y
 * la foto copiada en los ítems de pedidos de la tienda.
 */
export const SQL_BORRAR_ARCHIVO_SIN_USO = `
  DELETE FROM archivos a
   WHERE a.id_archivo = $1
     AND NOT EXISTS (
           SELECT 1 FROM productos_imagenes pi
            WHERE pi.url = $2 OR pi.thumb_url = $2
               OR (pi.proveedor = 'base_datos' AND pi.clave_almacen = $3)
         )
     AND NOT EXISTS (SELECT 1 FROM recepcion_adjuntos ra WHERE ra.url = $2)
     AND NOT EXISTS (SELECT 1 FROM pedido_items it WHERE it.imagen_url = $2)`;

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
  private readonly logger = new Logger(BaseDatosAlmacen.name);

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

  /**
   * guardar() reutiliza la fila cuando el hash coincide, así que la misma foto puede
   * servir a dos productos o a un producto y una recepción. Borrarla por id dejaba al
   * otro con /archivos/N en 404: solo se borra si ya nadie la referencia, en una sola
   * sentencia. Quien llama quita antes su propia referencia. Si la consulta falla (una
   * base antigua sin alguna de esas tablas) la fila se conserva: un huérfano es inocuo.
   */
  async eliminar(clave: string): Promise<void> {
    const id = Number(clave);
    if (!Number.isInteger(id) || id <= 0) return;
    try {
      await this.dataSource.query(SQL_BORRAR_ARCHIVO_SIN_USO, [id, `/archivos/${id}`, String(id)]);
    } catch (error: any) {
      this.logger.warn(`Se conserva el archivo ${id}: no se pudo comprobar si sigue en uso (${error?.message ?? error})`);
    }
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

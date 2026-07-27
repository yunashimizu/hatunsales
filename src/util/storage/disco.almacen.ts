import { Injectable, Logger } from '@nestjs/common';
import { join, extname } from 'path';
import { promises as fs } from 'fs';
import { randomUUID } from 'crypto';
import { almacenamientoConfig } from '../../config/almacenamiento.config';
import { AlmacenArchivos, ArchivoEntrada, ArchivoGuardado } from './almacen.interface';

/**
 * Escribe en el disco del servidor. Pensado para desarrollo local.
 *
 * En Railway el sistema de archivos es efímero, así que las imágenes se
 * perderían en el siguiente despliegue.
 */
@Injectable()
export class DiscoAlmacen implements AlmacenArchivos {

  readonly nombre = 'disco';
  private readonly logger = new Logger(DiscoAlmacen.name);

  private get config() {
    return almacenamientoConfig.disco;
  }

  async guardar(entrada: ArchivoEntrada): Promise<ArchivoGuardado> {
    const extension = extname(entrada.nombre_original) || this.extensionDesdeMime(entrada.mime);
    const relativo = join(entrada.carpeta, `${randomUUID()}${extension}`);
    const absoluto = join(this.config.ruta, relativo);

    await fs.mkdir(join(absoluto, '..'), { recursive: true });
    await fs.writeFile(absoluto, entrada.buffer);

    const url = `${this.config.urlPublica}/${relativo}`.replace(/\\/g, '/').replace(/\/+/g, '/');

    return {
      url,
      thumb_url: url,
      clave: relativo,
      mime: entrada.mime,
      size: entrada.buffer.length,
      proveedor: this.nombre,
    };
  }

  async eliminar(clave: string): Promise<void> {
    try {
      await fs.unlink(join(this.config.ruta, clave));
    } catch (error: any) {
      this.logger.warn(`No se pudo eliminar ${clave}: ${error?.message}`);
    }
  }

  private extensionDesdeMime(mime: string): string {
    const mapa: Record<string, string> = {
      'image/jpeg': '.jpg',
      'image/png': '.png',
      'image/webp': '.webp',
      'image/avif': '.avif',
      'image/gif': '.gif',
    };
    return mapa[mime] ?? '.bin';
  }
}

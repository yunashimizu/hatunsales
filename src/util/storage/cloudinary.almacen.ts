import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import axios from 'axios';
import { createHash } from 'crypto';
import { almacenamientoConfig } from '../../config/almacenamiento.config';
import { AlmacenArchivos, ArchivoEntrada, ArchivoGuardado } from './almacen.interface';

/**
 * Subida a Cloudinary usando su API REST firmada.
 *
 * Se habla directo con la API en vez de usar el SDK para no sumar una
 * dependencia por algo que son veinte líneas.
 *
 * Las miniaturas no se generan ni se almacenan: se piden por URL con las
 * transformaciones `f_auto,q_auto`, que además convierten a WebP o AVIF según
 * lo que soporte el navegador. Eso es lo que hace que las imágenes carguen
 * rápido sin trabajo del servidor.
 */
@Injectable()
export class CloudinaryAlmacen implements AlmacenArchivos {

  readonly nombre = 'cloudinary';
  private readonly logger = new Logger(CloudinaryAlmacen.name);

  private get config() {
    return almacenamientoConfig.cloudinary;
  }

  async guardar(entrada: ArchivoEntrada): Promise<ArchivoGuardado> {
    const timestamp = Math.floor(Date.now() / 1000);
    const carpeta = `${this.config.carpeta}/${entrada.carpeta}`.replace(/\/+/g, '/');

    const parametros: Record<string, string> = {
      folder: carpeta,
      timestamp: String(timestamp),
    };

    const cuerpo = new URLSearchParams({
      ...parametros,
      file: `data:${entrada.mime};base64,${entrada.buffer.toString('base64')}`,
      api_key: this.config.api_key,
      signature: this.firmar(parametros),
    });

    try {
      const { data } = await axios.post(
        `https://api.cloudinary.com/v1_1/${this.config.cloud_name}/image/upload`,
        cuerpo,
        {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          timeout: 30_000,
          maxBodyLength: Infinity,
        },
      );

      return {
        url: this.urlTransformada(data.public_id, data.format, 'f_auto,q_auto,w_1200,c_limit'),
        thumb_url: this.urlTransformada(data.public_id, data.format, 'f_auto,q_auto,w_400,h_400,c_fill'),
        clave: data.public_id,
        mime: entrada.mime,
        size: Number(data.bytes ?? entrada.buffer.length),
        width: Number(data.width) || undefined,
        height: Number(data.height) || undefined,
        proveedor: this.nombre,
      };
    } catch (error: any) {
      const detalle = error?.response?.data?.error?.message ?? error?.message;
      this.logger.error(`Subida a Cloudinary fallida: ${detalle}`);
      throw new ServiceUnavailableException(`No se pudo subir la imagen: ${detalle}`);
    }
  }

  async eliminar(clave: string): Promise<void> {
    const timestamp = Math.floor(Date.now() / 1000);
    const parametros = { public_id: clave, timestamp: String(timestamp) };

    try {
      await axios.post(
        `https://api.cloudinary.com/v1_1/${this.config.cloud_name}/image/destroy`,
        new URLSearchParams({
          ...parametros,
          api_key: this.config.api_key,
          signature: this.firmar(parametros),
        }),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 15_000 },
      );
    } catch (error: any) {
      // Que no se pueda borrar en el CDN no debe impedir quitarla del catálogo.
      this.logger.warn(`No se pudo eliminar ${clave} de Cloudinary: ${error?.message}`);
    }
  }

  private urlTransformada(publicId: string, formato: string, transformacion: string): string {
    return `https://res.cloudinary.com/${this.config.cloud_name}/image/upload/${transformacion}/${publicId}.${formato}`;
  }

  /** Firma SHA-1 de los parámetros ordenados alfabéticamente más el secreto. */
  private firmar(parametros: Record<string, string>): string {
    const cadena = Object.keys(parametros)
      .sort()
      .map((clave) => `${clave}=${parametros[clave]}`)
      .join('&');

    return createHash('sha1').update(`${cadena}${this.config.api_secret}`).digest('hex');
  }
}

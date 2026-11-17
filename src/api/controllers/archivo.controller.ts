import { Controller, Get, NotFoundException, Param, Res, Headers } from '@nestjs/common';
import type { Response } from 'express';
import { BaseDatosAlmacen } from '../../util/storage/base-datos.almacen';
import { almacenamientoConfig } from '../../config/almacenamiento.config';

/**
 * Entrega las imágenes guardadas en base de datos.
 *
 * Es público a propósito: son fotos de catálogo que la tienda necesita mostrar
 * sin sesión. Se responde con caché inmutable y ETag, así el navegador solo la
 * descarga la primera vez.
 */
@Controller('archivos')
export class ArchivoController {

  constructor(private readonly almacen: BaseDatosAlmacen) {}

  @Get(':id')
  async servir(
    @Param('id') id: string,
    @Headers('if-none-match') etagRecibido: string,
    @Res() res: Response,
  ) {
    const archivo = await this.almacen.leer(Number(id));
    if (!archivo) throw new NotFoundException('Archivo no encontrado');

    const etag = `"${archivo.hash.slice(0, 32)}"`;

    // Se sirve desde el dominio de la API: aunque alguien haya guardado un
    // archivo activo (SVG, HTML) antes de cerrar la lista, el navegador no
    // ejecuta nada ni adivina otro tipo. Un <img> de otra página no se afecta.
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.setHeader('X-Content-Type-Options', 'nosniff');

    if (etagRecibido === etag) {
      res.status(304).end();
      return;
    }

    const mime = (archivo.mime || '').toLowerCase();
    if (almacenamientoConfig.tiposPermitidos.includes(mime)) {
      res.setHeader('Content-Type', mime);
    } else {
      // Tipo fuera de la lista cerrada: se descarga, nunca se muestra en línea.
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Disposition', 'attachment');
    }
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.setHeader('ETag', etag);
    res.send(archivo.contenido);
  }
}

import { Controller, Get, NotFoundException, Param, Res, Headers } from '@nestjs/common';
import type { Response } from 'express';
import { BaseDatosAlmacen } from '../../util/storage/base-datos.almacen';

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

    if (etagRecibido === etag) {
      res.status(304).end();
      return;
    }

    res.setHeader('Content-Type', archivo.mime);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.setHeader('ETag', etag);
    res.send(archivo.contenido);
  }
}

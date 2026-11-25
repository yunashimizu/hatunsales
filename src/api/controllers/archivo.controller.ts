import { Controller, Get, NotFoundException, Param, Query, Res, Headers } from '@nestjs/common';
import type { Response } from 'express';
import { BaseDatosAlmacen } from '../../util/storage/base-datos.almacen';
import { almacenamientoConfig } from '../../config/almacenamiento.config';
import { RedimensionadorImagen, anchoSolicitado } from '../../util/storage/redimensionador-imagen';

/**
 * Entrega las imágenes guardadas en base de datos.
 *
 * Es público a propósito: son fotos de catálogo que la tienda necesita mostrar
 * sin sesión. Se responde con caché inmutable y ETag, así el navegador solo la
 * descarga la primera vez.
 *
 * `?w=480` pide la imagen reducida a ese ancho (lista cerrada, ver `ANCHOS_IMAGEN`): las
 * tarjetas del catálogo no necesitan la foto de 1600 px. Sin `w` se entrega la original.
 */
@Controller('archivos')
export class ArchivoController {

  constructor(
    private readonly almacen: BaseDatosAlmacen,
    private readonly redimensionador: RedimensionadorImagen,
  ) {}

  @Get(':id')
  async servir(
    @Param('id') id: string,
    @Headers('if-none-match') etagRecibido: string,
    @Res() res: Response,
    @Query('w') anchoPedido?: string,
    @Headers('accept') aceptado?: string,
  ) {
    const archivo = await this.almacen.leer(Number(id));
    if (!archivo) throw new NotFoundException('Archivo no encontrado');

    // Se sirve desde el dominio de la API: aunque alguien haya guardado un
    // archivo activo (SVG, HTML) antes de cerrar la lista, el navegador no
    // ejecuta nada ni adivina otro tipo. Un <img> de otra página no se afecta.
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.setHeader('X-Content-Type-Options', 'nosniff');

    const mime = (archivo.mime || '').toLowerCase();
    const esImagen = almacenamientoConfig.tiposPermitidos.includes(mime);
    const ancho = esImagen ? anchoSolicitado(anchoPedido) : null;
    const aceptaWebp = /image\/webp/i.test(aceptado ?? '');

    // El ETag de una variante incluye el ancho y el formato: así el navegador no confunde
    // la miniatura con la original ni una versión WebP con una JPEG.
    const huella = archivo.hash.slice(0, 32);
    const etagVariante = ancho ? `"${huella}-w${ancho}${aceptaWebp ? 'p' : 'o'}"` : null;
    const etagOriginal = `"${huella}"`;

    if (ancho) res.setHeader('Vary', 'Accept');

    if (etagRecibido === (etagVariante ?? etagOriginal)) {
      res.status(304).end();
      return;
    }

    let contenido = archivo.contenido;
    let tipo = mime;
    let etag = etagOriginal;

    if (ancho) {
      const variante = await this.redimensionador.variante(huella, archivo.contenido, mime, ancho, aceptaWebp);
      if (variante) {
        contenido = variante.contenido;
        tipo = variante.mime;
        etag = etagVariante!;
      }
    }

    if (esImagen) {
      res.setHeader('Content-Type', tipo);
    } else {
      // Tipo fuera de la lista cerrada: se descarga, nunca se muestra en línea.
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Disposition', 'attachment');
    }
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.setHeader('ETag', etag);
    res.send(contenido);
  }
}

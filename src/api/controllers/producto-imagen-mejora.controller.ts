import { Controller, Get, Param, ParseIntPipe, Post, UseGuards } from '@nestjs/common';
import { JwtGuard } from '../../guards/jwt.guard';
import { RolesGuard } from '../../guards/roles.guard';
import { Roles } from '../../guards/roles.decorator';
import { MejoraFotosService } from '../../fotos/mejora-fotos.service';

/**
 * Mejora automática de fotos, por foto (doc/PLAN_MEJORA_AUTOMATICA_DE_FOTOS.md §7.2). Los mismos roles
 * que suben fotos. Las rutas de subida no cambian de forma: el panel pide `…/images/mejoras` después.
 *
 * Sin sql/fase23: el GET responde `{ disponible: false, mejoras: [] }` y los POST 503
 * `{ codigo: 'MEJORA_FOTOS_NO_DISPONIBLE' }`. Foto de otro producto: 404.
 */
@Controller('producto')
@UseGuards(JwtGuard, RolesGuard)
@Roles('admin', 'vendedor')
export class ProductoImagenMejoraController {
  constructor(private readonly mejora: MejoraFotosService) {}

  /** Estado de la mejora de cada foto del producto (original, mejorada, avisos). */
  @Get(':id/images/mejoras')
  resumen(@Param('id', ParseIntPipe) id: number) {
    return this.mejora.resumen(id);
  }

  /** «Usar la original». Idempotente; los dos archivos se conservan. */
  @Post(':id/images/:imgId/mejora/original')
  usarOriginal(@Param('id', ParseIntPipe) id: number, @Param('imgId', ParseIntPipe) imgId: number) {
    return this.mejora.usarOriginal(id, imgId);
  }

  /** «Usar la mejorada»: publica la guardada o la calcula ahora desde la original. */
  @Post(':id/images/:imgId/mejora/aplicar')
  aplicar(@Param('id', ParseIntPipe) id: number, @Param('imgId', ParseIntPipe) imgId: number) {
    return this.mejora.usarMejorada(id, imgId);
  }
}

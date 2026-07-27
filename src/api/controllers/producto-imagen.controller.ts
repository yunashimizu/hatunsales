import {
  Controller, Post, Get, Patch, Put, Delete, Param, Body,
  UseGuards, UseInterceptors, UploadedFile, UploadedFiles, BadRequestException,
} from '@nestjs/common';
import { FileInterceptor, FilesInterceptor } from '@nestjs/platform-express';
import * as multer from 'multer';
import { JwtGuard } from '../../guards/jwt.guard';
import { RolesGuard } from '../../guards/roles.guard';
import { Roles } from '../../guards/roles.decorator';
import { ProductoImagenBussnies } from '../../bussnies/Bussnies/producto-imagen.bussnies';
import { almacenamientoConfig } from '../../config/almacenamiento.config';

const MAXIMO_POR_LOTE = 10;

const opcionesSubida = {
  storage: multer.memoryStorage(),
  limits: { fileSize: almacenamientoConfig.tamanioMaximoBytes, files: MAXIMO_POR_LOTE },
};

@Controller('producto')
export class ProductoImagenController {

  constructor(private readonly service: ProductoImagenBussnies) {}

  // Lectura pública: la ficha de producto de la tienda necesita la galería.
  @Get(':id/images')
  list(@Param('id') id: string) {
    return this.service.listByProduct(Number(id));
  }

  /** Sube hasta diez imágenes en una sola petición. */
  @Post(':id/images/lote')
  @UseGuards(JwtGuard, RolesGuard)
  @Roles('admin', 'vendedor')
  @UseInterceptors(FilesInterceptor('files', MAXIMO_POR_LOTE, opcionesSubida))
  subirVarias(@Param('id') id: string, @UploadedFiles() files: any[]) {
    if (!files?.length) throw new BadRequestException('No se seleccionó ninguna imagen');
    return this.service.subirVarias(Number(id), files);
  }

  @Post(':id/images')
  @UseGuards(JwtGuard, RolesGuard)
  @Roles('admin', 'vendedor')
  @UseInterceptors(FileInterceptor('file', opcionesSubida))
  upload(@Param('id') id: string, @UploadedFile() file: any) {
    if (!file) throw new BadRequestException('No se seleccionó ninguna imagen');
    return this.service.uploadBuffer(Number(id), file.originalname, file.buffer, file.mimetype);
  }

  @Patch(':id/images/:imgId/primary')
  @UseGuards(JwtGuard, RolesGuard)
  @Roles('admin', 'vendedor')
  setPrimary(@Param('id') id: string, @Param('imgId') imgId: string) {
    return this.service.setPrimary(Number(id), Number(imgId));
  }

  /** Nuevo orden de la galería tras arrastrar las miniaturas. */
  @Put(':id/images/orden')
  @UseGuards(JwtGuard, RolesGuard)
  @Roles('admin', 'vendedor')
  reordenar(@Param('id') id: string, @Body() body: { ids: number[] }) {
    return this.service.reordenar(Number(id), body?.ids ?? []);
  }

  @Delete(':id/images/:imgId')
  @UseGuards(JwtGuard, RolesGuard)
  @Roles('admin', 'vendedor')
  remove(@Param('id') id: string, @Param('imgId') imgId: string) {
    return this.service.remove(Number(id), Number(imgId));
  }
}

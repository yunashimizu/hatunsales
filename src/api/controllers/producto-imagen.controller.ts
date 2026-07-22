import { Controller, Post, Get, Patch, Delete, Param, UseGuards, UseInterceptors, UploadedFile, BadRequestException } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import * as multer from 'multer';
import { JwtGuard } from '../../guards/jwt.guard';
import { RolesGuard } from '../../guards/roles.guard';
import { Roles } from '../../guards/roles.decorator';
import { ProductoImagenBussnies } from '../../bussnies/Bussnies/producto-imagen.bussnies';

@Controller('producto')
export class ProductoImagenController {
  constructor(private readonly service: ProductoImagenBussnies) {}

  @Get(':id/images')
  @UseGuards(JwtGuard, RolesGuard)
  @Roles('admin', 'vendedor', 'caja')
  list(@Param('id') id: string) {
    return this.service.listByProduct(Number(id));
  }

  @Post(':id/images')
  @UseGuards(JwtGuard, RolesGuard)
  @Roles('admin', 'vendedor')
  @UseInterceptors(FileInterceptor('file', { storage: multer.memoryStorage() }))
  async upload(@Param('id') id: string, @UploadedFile() file: any) {
    if (!file) throw new BadRequestException('Falta archivo');
    return this.service.uploadBuffer(Number(id), file.originalname, file.buffer, file.mimetype);
  }

  @Patch(':id/images/:imgId/primary')
  @UseGuards(JwtGuard, RolesGuard)
  @Roles('admin', 'vendedor')
  setPrimary(@Param('id') id: string, @Param('imgId') imgId: string) {
    return this.service.setPrimary(Number(id), Number(imgId));
  }

  @Delete(':id/images/:imgId')
  @UseGuards(JwtGuard, RolesGuard)
  @Roles('admin')
  remove(@Param('id') id: string, @Param('imgId') imgId: string) {
    return this.service.remove(Number(id), Number(imgId));
  }
}

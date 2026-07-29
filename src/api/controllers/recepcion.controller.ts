import {
  BadRequestException, Body, Controller, Get, Param, Post, Query,
  UploadedFile, UseGuards, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import * as multer from 'multer';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtGuard } from '../../guards/jwt.guard';
import { RolesGuard } from '../../guards/roles.guard';
import { Roles } from '../../guards/roles.decorator';
import { UsuarioActual } from '../../guards/usuario-actual.decorator';
import type { UsuarioToken } from '../../guards/usuario-actual.decorator';
import { RecepcionBussnies } from '../../bussnies/Bussnies/recepcion.bussnies';
import { almacenamientoConfig } from '../../config/almacenamiento.config';

const opcionesSubida = {
  storage: multer.memoryStorage(),
  limits: { fileSize: almacenamientoConfig.tamanioMaximoBytes },
};

@ApiTags('Recepcion')
@ApiBearerAuth('access-token')
@Controller('recepcion')
@UseGuards(JwtGuard, RolesGuard)
export class RecepcionController {
  constructor(private readonly service: RecepcionBussnies) {}

  @Get()
  @Roles('admin', 'vendedor', 'caja')
  listar() {
    return this.service.listarRecepciones();
  }

  @Get('observaciones')
  @Roles('admin', 'vendedor', 'caja')
  observaciones(@Query('estado') estado?: string) {
    return this.service.listarObservaciones(estado);
  }

  @Get(':id')
  @Roles('admin', 'vendedor', 'caja')
  detalle(@Param('id') id: string) {
    return this.service.detalle(Number(id));
  }

  @Post('confirmar')
  @Roles('admin', 'vendedor', 'caja')
  confirmar(@Body() body: any, @UsuarioActual() usuario: UsuarioToken) {
    return this.service.confirmar(body, usuario);
  }

  @Post('observaciones/:id/aprobar')
  @Roles('admin', 'vendedor', 'caja')
  aprobar(
    @Param('id') id: string,
    @Body() body: { comentario?: string },
    @UsuarioActual() usuario: UsuarioToken,
  ) {
    return this.service.aprobarObservacion(Number(id), usuario, body?.comentario);
  }

  @Post('observaciones/:id/rechazar')
  @Roles('admin', 'vendedor', 'caja')
  rechazar(
    @Param('id') id: string,
    @Body() body: { comentario?: string },
    @UsuarioActual() usuario: UsuarioToken,
  ) {
    return this.service.rechazarObservacion(Number(id), usuario, body?.comentario);
  }

  @Post('observaciones/:id/fotos')
  @Roles('admin', 'vendedor', 'caja')
  @UseInterceptors(FileInterceptor('file', opcionesSubida))
  async foto(
    @Param('id') id: string,
    @UploadedFile() file: any,
  ) {
    if (!file) throw new BadRequestException('No se seleccionó ninguna imagen');
    return this.service.subirFoto(Number(id), {
      originalname: file.originalname,
      mimetype: file.mimetype,
      buffer: file.buffer,
      size: file.size,
    });
  }
}

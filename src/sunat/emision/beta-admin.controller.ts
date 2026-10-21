import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
  Put,
  Req,
  StreamableFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import type { Request } from 'express';
import { JwtGuard } from '../../guards/jwt.guard';
import { Roles } from '../../guards/roles.decorator';
import { RolesGuard } from '../../guards/roles.guard';
import { UsuarioActual } from '../../guards/usuario-actual.decorator';
import type { UsuarioToken } from '../../guards/usuario-actual.decorator';
import { ErroresFiscalesInterceptor } from '../admin/errores-fiscales.interceptor';
import { FiscalEsquemaService } from '../config/fiscal-esquema.service';
import { FiscalConfigError } from '../config/fiscal-errores';
import { EmisorBetaDto } from './emisor-beta.dto';
import { EmisorBetaService } from './emisor-beta.service';
import { TIPOS_ARCHIVO_BETA } from './emision-beta.types';
import type { TipoArchivoBeta } from './emision-beta.types';
import { EnvioBetaRepository } from './envio-beta.repository';
import { SunatEmisionBetaService } from './sunat-emision-beta.service';
import { PosBetaService } from './pos-beta.service';
import { PosBetaDto } from './pos-beta.dto';

@Controller('fiscal/beta')
@UseGuards(JwtGuard, RolesGuard)
@Roles('admin')
@UseInterceptors(ErroresFiscalesInterceptor)
export class BetaAdminController {
  constructor(
    private readonly emisor: EmisorBetaService,
    private readonly envios: EnvioBetaRepository,
    private readonly esquema: FiscalEsquemaService,
    private readonly emision: SunatEmisionBetaService,
    private readonly posBeta: PosBetaService,
  ) {}

  @Get('pos')
  @Header('Cache-Control', 'no-store')
  estadoPosBeta() {
    return this.posBeta.estado();
  }

  @Put('pos')
  cambiarEstadoPosBeta(
    @Body() dto: PosBetaDto,
    @UsuarioActual() usuario: UsuarioToken,
    @Req() req: Request,
  ) {
    return this.posBeta.cambiarEstado(dto.activo, {
      id_usuario: usuario.id_usuario,
      nombre: usuario.nombre ?? null,
      ip: req.ip ?? null,
    });
  }

  @Get('emisor')
  @Header('Cache-Control', 'no-store')
  obtenerEmisor() {
    return this.emisor.vista();
  }

  @Put('emisor')
  guardarEmisor(
    @Body() dto: EmisorBetaDto,
    @UsuarioActual() usuario: UsuarioToken,
    @Req() req: Request,
  ) {
    return this.emisor.guardar(dto, {
      id_usuario: usuario.id_usuario,
      nombre: usuario.nombre ?? null,
      ip: req.ip ?? null,
    });
  }

  @Get('envios')
  @Header('Cache-Control', 'no-store')
  async listar() {
    await this.esquema.exigir('emision');
    return { items: await this.envios.listar() };
  }

  @Post('envios/:id/reintentar')
  @HttpCode(200)
  async reintentar(@Param('id', ParseIntPipe) id: number) {
    await this.esquema.exigir('emision');
    return this.emision.reintentar(id);
  }

  @Get('envios/:id/archivos/:tipo')
  @Header('Cache-Control', 'no-store')
  @Header('Access-Control-Expose-Headers', 'Content-Disposition')
  async archivo(
    @Param('id', ParseIntPipe) id: number,
    @Param('tipo') tipo: string,
  ) {
    if (!(TIPOS_ARCHIVO_BETA as readonly string[]).includes(tipo))
      throw new FiscalConfigError(
        'FISCAL_CONFIG_INVALIDA',
        'Tipo de archivo de prueba no válido.',
      );
    await this.esquema.exigir('emision');
    const archivo = await this.envios.archivo(id, tipo as TipoArchivoBeta);
    if (!archivo)
      throw new FiscalConfigError(
        'FISCAL_XML_NO_DISPONIBLE',
        'El archivo no está disponible en ese envío BETA.',
      );
    return new StreamableFile(archivo.contenido, {
      type: archivo.mime,
      disposition: `attachment; filename="${archivo.nombre.replace(/[^\w.-]/g, '_')}"`,
      length: archivo.contenido.length,
    });
  }
}

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
import { actorDe } from '../admin/actor-fiscal';
import { ErroresFiscalesInterceptor } from '../admin/errores-fiscales.interceptor';
import { FiscalEsquemaService } from '../config/fiscal-esquema.service';
import { descargaDeEnvio } from './descarga-envio';
import { EmisionDirectaService } from './emision-directa.service';
import { EmisorBetaDto } from './emisor-beta.dto';
import { EmisorBetaService } from './emisor-beta.service';
import { PosBetaDto } from './pos-beta.dto';

/** Últimos envíos de prueba que muestra el panel de SUNAT BETA. */
const ENVIOS_BETA_EN_PANEL = 30;

/**
 * Pruebas en SUNAT BETA (alias de /fiscal/envios para el panel actual): interruptor de la emisión de
 * prueba del POS, emisor de pruebas, últimos envíos BETA, reintento y descargas.
 */
@Controller('fiscal/beta')
@UseGuards(JwtGuard, RolesGuard)
@Roles('admin')
@UseInterceptors(ErroresFiscalesInterceptor)
export class BetaAdminController {
  constructor(
    private readonly emisor: EmisorBetaService,
    private readonly esquema: FiscalEsquemaService,
    private readonly emision: EmisionDirectaService,
  ) {}

  @Get('pos')
  @Header('Cache-Control', 'no-store')
  estadoPosBeta() {
    return this.emision.estado();
  }

  @Put('pos')
  cambiarEstadoPosBeta(@Body() dto: PosBetaDto, @UsuarioActual() usuario: UsuarioToken | undefined, @Req() req: Request) {
    return this.emision.cambiarEstado(dto.activo, actorDe(usuario, req));
  }

  @Get('emisor')
  @Header('Cache-Control', 'no-store')
  obtenerEmisor() {
    return this.emisor.vista();
  }

  @Put('emisor')
  guardarEmisor(@Body() dto: EmisorBetaDto, @UsuarioActual() usuario: UsuarioToken | undefined, @Req() req: Request) {
    return this.emisor.guardar(dto, actorDe(usuario, req));
  }

  @Get('envios')
  @Header('Cache-Control', 'no-store')
  async listar() {
    await this.esquema.exigir('emision');
    const { datos } = await this.emision.listarEnvios({ ambiente: 'beta', pagina: 1, por_pagina: ENVIOS_BETA_EN_PANEL });
    return { items: datos };
  }

  @Post('envios/:id/reintentar')
  @HttpCode(200)
  async reintentar(@Param('id', ParseIntPipe) id: number) {
    await this.esquema.exigir('emision');
    return this.emision.reintentar(id);
  }

  @Get('envios/:id/archivos/:tipo')
  @Header('Cache-Control', 'private, no-store')
  @Header('X-Content-Type-Options', 'nosniff')
  @Header('Access-Control-Expose-Headers', 'Content-Disposition')
  async archivo(@Param('id', ParseIntPipe) id: number, @Param('tipo') tipo: string): Promise<StreamableFile> {
    await this.esquema.exigir('emision');
    return descargaDeEnvio(this.emision, id, tipo);
  }
}

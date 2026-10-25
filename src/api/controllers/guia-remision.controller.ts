import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
  Put,
  Query,
  Res,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { GuiaRemisionBussnies } from '../../bussnies/Bussnies/guia-remision.bussnies';
import { JwtGuard } from '../../guards/jwt.guard';
import { Roles } from '../../guards/roles.decorator';
import { RolesGuard } from '../../guards/roles.guard';
import { UsuarioActual } from '../../guards/usuario-actual.decorator';
import type { UsuarioToken } from '../../guards/usuario-actual.decorator';
import {
  AnularGuiaRemisionRequest,
  GuardarGuiaRemisionRequest,
  ListarGuiasRemisionRequest,
} from '../../models/model/guia-remision.request';
import { TIPOS_ARCHIVO_GUIA } from '../../models/model/guia-remision.response';
import type { TipoArchivoGuia } from '../../models/model/guia-remision.response';

/** Nombre de descarga solo con [A-Za-z0-9._-]: nada que rompa la cabecera ni la ruta del cliente. */
function nombreDescarga(nombre: string, respaldo: string): string {
  const limpio = String(nombre ?? '').replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '');
  return limpio || respaldo;
}

/**
 * Guía de Remisión Electrónica remitente (PLAN V3, sección 4). Lectura: admin, vendedor y caja;
 * escritura (borrador, edición, validar, emitir, consultar, anular): admin y vendedor. Las rutas
 * literales van antes de ':id' para que «modo» o «catalogos» no se lean como un id.
 */
@Controller('guia-remision')
@UseGuards(JwtGuard, RolesGuard)
@Roles('admin', 'vendedor', 'caja')
export class GuiaRemisionController {
  constructor(private readonly service: GuiaRemisionBussnies) {}

  /** Listado paginado (por_pagina hasta 100) con filtros de texto, estado y fechas. */
  @Get()
  listar(@Query() filtro: ListarGuiasRemisionRequest) {
    return this.service.listar(filtro);
  }

  /** ¿Se puede emitir ahora? {activo} o {activo:false, codigo, motivo}. */
  @Get('modo')
  modo() {
    return this.service.modo();
  }

  /** Motivos habilitados, modalidades, unidades, tipos de documento y estados, con sus nombres. */
  @Get('catalogos')
  catalogos() {
    return this.service.catalogos();
  }

  /** Precarga de una guía desde una venta (destinatario, pendientes por producto, partida, llegada, comprobante). */
  @Get('ventas/:id/contexto')
  contextoVenta(@Param('id', ParseIntPipe) id: number) {
    return this.service.contextoVenta(id);
  }

  /** Representación impresa (QR solo si SUNAT la aceptó). */
  @Get(':id/pdf')
  async pdf(@Param('id', ParseIntPipe) id: number, @Res({ passthrough: true }) res: Response): Promise<StreamableFile> {
    const pdf = await this.service.pdf(id);
    return this.descarga(res, { nombre: pdf.nombre, mime: 'application/pdf', contenido: pdf.contenido }, `guia-${id}.pdf`);
  }

  /** XML firmado, ZIP o constancia (CDR) del último envío a SUNAT. */
  @Get(':id/archivos/:tipo')
  async archivo(
    @Param('id', ParseIntPipe) id: number,
    @Param('tipo') tipo: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    if (!(TIPOS_ARCHIVO_GUIA as readonly string[]).includes(tipo)) {
      throw new BadRequestException({ message: `Tipo de archivo no válido. Use: ${TIPOS_ARCHIVO_GUIA.join(', ')}.`, codigo: 'VALIDACION' });
    }
    const archivo = await this.service.archivo(id, tipo as TipoArchivoGuia);
    return this.descarga(res, archivo, `guia-${id}-${tipo}`);
  }

  @Get(':id')
  obtener(@Param('id', ParseIntPipe) id: number) {
    return this.service.obtener(id);
  }

  /** Borrador (desde una venta con motivo 01, o sin venta con 04 o 13). */
  @Post()
  @Roles('admin', 'vendedor')
  crear(@Body() body: GuardarGuiaRemisionRequest, @UsuarioActual() usuario?: UsuarioToken) {
    return this.service.crear(body, usuario?.id_usuario ?? null);
  }

  /**
   * «Emitir a SUNAT» desde el formulario: el mismo cuerpo que el borrador; la guía se crea y se envía en el
   * acto. Si no se puede emitir (400 por campo, 503 GRE inactiva, 409), queda como borrador y el error trae
   * su id_guia: corríjala con PUT /guia-remision/:id y reintente con POST /guia-remision/:id/emitir.
   */
  @Post('emitir')
  @Roles('admin', 'vendedor')
  crearYEmitir(@Body() body: GuardarGuiaRemisionRequest, @UsuarioActual() usuario?: UsuarioToken) {
    return this.service.crearYEmitir(body, usuario?.id_usuario ?? null);
  }

  /** Edita un borrador o una guía rechazada (la rechazada conserva su número). */
  @Put(':id')
  @Roles('admin', 'vendedor')
  actualizar(@Param('id', ParseIntPipe) id: number, @Body() body: GuardarGuiaRemisionRequest) {
    return this.service.actualizar(id, body);
  }

  /** Validar sin enviar: {valido, errores, advertencias, por_campo}. */
  @Post(':id/validar')
  @Roles('admin', 'vendedor')
  @HttpCode(200)
  validar(@Param('id', ParseIntPipe) id: number) {
    return this.service.validar(id);
  }

  /** Emite y responde con lo que SUNAT ya dijo; reenvía con el mismo número o el mismo archivo (503 si la GRE no está activa). */
  @Post(':id/emitir')
  @Roles('admin', 'vendedor')
  @HttpCode(200)
  emitir(@Param('id', ParseIntPipe) id: number, @UsuarioActual() usuario?: UsuarioToken) {
    return this.service.emitir(id, usuario?.id_usuario ?? null);
  }

  /** Consulta del ticket en SUNAT. */
  @Post(':id/consultar')
  @Roles('admin', 'vendedor')
  @HttpCode(200)
  consultar(@Param('id', ParseIntPipe) id: number) {
    return this.service.consultar(id);
  }

  /** Solo borrador o rechazada (una aceptada se da de baja en SUNAT Operaciones en Línea). */
  @Post(':id/anular')
  @Roles('admin', 'vendedor')
  @HttpCode(200)
  anular(@Param('id', ParseIntPipe) id: number, @Body() body: AnularGuiaRemisionRequest, @UsuarioActual() usuario?: UsuarioToken) {
    return this.service.anular(id, body, usuario?.id_usuario ?? null);
  }

  /** Descarga privada: adjunto con nombre saneado, sin caché ni adivinar el tipo (PLAN V3, D13). */
  private descarga(res: Response, archivo: { nombre: string; mime: string; contenido: Buffer }, respaldo: string): StreamableFile {
    const nombre = nombreDescarga(archivo.nombre, respaldo);
    res.setHeader('Content-Type', archivo.mime);
    res.setHeader('Content-Disposition', `attachment; filename="${nombre}"`);
    res.setHeader('Content-Length', String(archivo.contenido.length));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
    return new StreamableFile(archivo.contenido, { type: archivo.mime, disposition: `attachment; filename="${nombre}"`, length: archivo.contenido.length });
  }
}

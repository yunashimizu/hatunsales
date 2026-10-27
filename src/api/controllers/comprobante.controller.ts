import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Res,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { ComprobanteBussnies } from '../../bussnies/Bussnies/comprobante.bussnies';
import {
  GenerarComprobanteRequest,
  ConsultarComprobanteRequest,
  ConfirmarAceptadoRequest,
  ReenviarCorreoRequest,
} from '../../models/model/c-electronico/comprobante.request';
import { CorreoComprobanteService } from '../../correo/correo-comprobante.service';
import { AnularDocumentoRequest } from '../../models/model/c-electronico/nota-credito.request';
import { JwtGuard } from '../../guards/jwt.guard';
import { RolesGuard } from '../../guards/roles.guard';
import { Roles } from '../../guards/roles.decorator';
import { UsuarioActual } from '../../guards/usuario-actual.decorator';
import type { UsuarioToken } from '../../guards/usuario-actual.decorator';
import { TIPOS_ARCHIVO_ENVIO } from '../../sunat/emision/emision.contrato';
import type { TipoArchivoEnvio } from '../../sunat/emision/emision.contrato';
import type { FormatoPdfComprobante } from '../../util/documentos/comprobante-pdf';

const FORMATOS_PDF: readonly FormatoPdfComprobante[] = ['a4', 'ticket'];

/** Nombre de descarga solo con [A-Za-z0-9._-] (nada que rompa la cabecera ni la ruta del cliente). */
export function nombreDescarga(nombre: string, respaldo = 'archivo'): string {
  const limpio = String(nombre ?? '').replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '');
  return limpio || respaldo;
}

@Controller('comprobante')
@UseGuards(JwtGuard, RolesGuard)
@Roles('admin', 'vendedor', 'caja')
export class ComprobanteController {

  constructor(
    private readonly service: ComprobanteBussnies,
    private readonly correo: CorreoComprobanteService,
  ) {}

  /** Motivos del catálogo SUNAT (09 y 10) que ofrece el sistema y la forma de armar cada nota. */
  @Get('catalogos/motivos')
  motivos() {
    return this.service.catalogoMotivos();
  }

  /** Badge Documentos: CPE pendiente + error (no anulados). */
  @Get('monitor/atencion')
  monitorAtencion() {
    return this.service.monitorAtencion();
  }

  /** Calcula el comprobante y lo devuelve armado, sin emitirlo. */
  @Post('preview')
  preview(@Body() body: GenerarComprobanteRequest) {
    return this.service.previsualizar(body);
  }

  @Post('generar')
  generar(@Body() body: GenerarComprobanteRequest, @UsuarioActual() usuario?: UsuarioToken) {
    return this.service.generar(body, usuario?.id_usuario ?? null);
  }

  /** Estado guardado y, si el envío quedó incierto y SUNAT lo permite, su constancia. */
  @Post('consultar')
  consultar(@Body() body: ConsultarComprobanteRequest) {
    return this.service.consultar(body);
  }

  @Post(':id/reintentar')
  @HttpCode(200)
  reintentar(@Param('id', ParseIntPipe) id: number) {
    return this.service.reintentar(id);
  }

  @Post(':id/recuperar-cdr')
  @HttpCode(200)
  recuperarCdr(@Param('id', ParseIntPipe) id: number) {
    return this.service.recuperarCdr(id);
  }

  /** El administrador verificó en SUNAT Operaciones en Línea que el comprobante fue aceptado (auditado). */
  @Post(':id/confirmar-aceptado')
  @Roles('admin')
  @HttpCode(200)
  confirmarAceptado(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: ConfirmarAceptadoRequest,
    @UsuarioActual() usuario: UsuarioToken,
  ) {
    return this.service.confirmarAceptado(id, usuario.id_usuario, body.nota);
  }

  /**
   * D9: con venta activa anula la venta; si no, el comprobante (nota de crédito si SUNAT lo aceptó, o en
   * el sistema si nunca valió). Responde estado 'anulada' | 'anulacion_en_curso' | 'anulacion_rechazada'.
   */
  @Post('anular')
  @Roles('admin')
  @HttpCode(200)
  anular(@Body() body: AnularDocumentoRequest, @UsuarioActual() usuario: UsuarioToken) {
    return this.service.anular(body, usuario?.id_usuario ?? null);
  }

  @Post('consultar-anulacion')
  consultarAnulacion(@Body() body: ConsultarComprobanteRequest) {
    return this.service.consultarAnulacion(body);
  }

  /** Listado paginado y filtrable para la pantalla de documentos. */
  @Get()
  listar(
    @Query('texto') texto?: string,
    @Query('id_tipo') idTipo?: string,
    @Query('estado') estado?: string,
    @Query('estado_sunat') estadoSunat?: string,
    @Query('ambiente') ambiente?: string,
    @Query('desde') desde?: string,
    @Query('hasta') hasta?: string,
    @Query('pagina') pagina?: string,
    @Query('por_pagina') porPagina?: string,
  ) {
    return this.service.listar({
      texto,
      id_tipo: idTipo ? Number(idTipo) || undefined : undefined,
      estado,
      estado_sunat: estadoSunat?.trim().toUpperCase() || undefined,
      ambiente: ambiente?.trim().toLowerCase() || undefined,
      desde: desde?.trim() || undefined,
      hasta: hasta?.trim() || undefined,
      pagina: Number(pagina) || 1,
      por_pagina: Math.min(100, Number(porPagina) || 20),
    });
  }

  @Get('venta/:id')
  listarPorVenta(@Param('id', ParseIntPipe) id: number) {
    return this.service.listarPorVenta(id);
  }

  @Get('cliente/:id')
  listarPorCliente(@Param('id', ParseIntPipe) id: number) {
    return this.service.listarPorCliente(id);
  }

  @Get(':id/detalle')
  async detalle(@Param('id', ParseIntPipe) id: number) {
    const detalle = await this.service.obtenerDetalle(id);
    return { ...detalle, correo: await this.correo.estadoResumen(detalle) };
  }

  /** Reenvía el comprobante (PDF y XML) por correo; sin destino usa el del comprobante. Máximo 3 por hora. */
  @Post(':id/correo')
  @HttpCode(200)
  reenviarCorreo(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: ReenviarCorreoRequest,
    @UsuarioActual() usuario?: UsuarioToken,
  ) {
    return this.correo.reenviar(id, body?.destino, usuario?.id_usuario ?? null);
  }

  /** Historial de correos del comprobante (automáticos y reenvíos). */
  @Get(':id/correos')
  historialCorreos(@Param('id', ParseIntPipe) id: number) {
    return this.correo.historial(id);
  }

  /** Representación impresa (A4 o ticket de 80 mm) con QR y hash. */
  @Get(':id/pdf')
  async pdf(
    @Param('id', ParseIntPipe) id: number,
    @Res({ passthrough: true }) res: Response,
    @Query('formato') formato?: string,
  ): Promise<StreamableFile> {
    const elegido = (formato?.trim().toLowerCase() || 'a4') as FormatoPdfComprobante;
    if (!FORMATOS_PDF.includes(elegido)) {
      throw new BadRequestException('El formato del PDF debe ser a4 o ticket.');
    }
    const pdf = await this.service.obtenerPdf(id, elegido);
    return this.descarga(res, { nombre: pdf.nombre, mime: 'application/pdf', contenido: pdf.contenido }, `comprobante-${id}.pdf`);
  }

  /** XML, XML firmado, ZIP o constancia (CDR) del último envío a SUNAT. */
  @Get(':id/archivos/:tipo')
  async archivo(
    @Param('id', ParseIntPipe) id: number,
    @Param('tipo') tipo: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    if (!(TIPOS_ARCHIVO_ENVIO as readonly string[]).includes(tipo)) {
      throw new BadRequestException(`Tipo de archivo no válido. Use: ${TIPOS_ARCHIVO_ENVIO.join(', ')}.`);
    }
    const archivo = await this.service.obtenerArchivo(id, tipo as TipoArchivoEnvio);
    return this.descarga(res, archivo, `comprobante-${id}-${tipo}`);
  }

  @Get(':id')
  obtenerPorId(@Param('id', ParseIntPipe) id: number) {
    return this.service.obtenerPorId(id);
  }

  /** Descarga privada: adjunto con nombre saneado, sin caché ni adivinar el tipo (PLAN V3, D13). */
  private descarga(
    res: Response,
    archivo: { nombre: string; mime: string; contenido: Buffer },
    respaldo: string,
  ): StreamableFile {
    const nombre = nombreDescarga(archivo.nombre, respaldo);
    res.setHeader('Content-Type', archivo.mime);
    res.setHeader('Content-Disposition', `attachment; filename="${nombre}"`);
    res.setHeader('Content-Length', String(archivo.contenido.length));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
    return new StreamableFile(archivo.contenido, {
      type: archivo.mime,
      disposition: `attachment; filename="${nombre}"`,
      length: archivo.contenido.length,
    });
  }
}

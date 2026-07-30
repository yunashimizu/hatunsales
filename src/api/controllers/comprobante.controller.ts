import { Controller, Post, Get, Body, Param, Query, UseGuards, Res } from '@nestjs/common';
import type { Response } from 'express';
import { ComprobanteBussnies } from '../../bussnies/Bussnies/comprobante.bussnies';
import {
  GenerarComprobanteRequest,
  ConsultarComprobanteRequest,
  AnularComprobanteRequest,
} from '../../models/model/c-electronico/comprobante.request';
import { JwtGuard } from '../../guards/jwt.guard';
import { RolesGuard } from '../../guards/roles.guard';
import { Roles } from '../../guards/roles.decorator';
import { MOTIVOS_NOTA_CREDITO, MOTIVOS_NOTA_DEBITO } from '../../util/fiscal/nubefact.catalogo';

@Controller('comprobante')
@UseGuards(JwtGuard, RolesGuard)
@Roles('admin', 'vendedor', 'caja')
export class ComprobanteController {

  constructor(private readonly service: ComprobanteBussnies) {}

  /** Catálogos de motivos para poblar los selectores de notas. */
  @Get('catalogos/motivos')
  motivos() {
    const aLista = (catalogo: Record<string, string>) =>
      Object.entries(catalogo).map(([codigo, nombre]) => ({ codigo, nombre }));

    return {
      nota_credito: aLista(MOTIVOS_NOTA_CREDITO),
      nota_debito: aLista(MOTIVOS_NOTA_DEBITO),
    };
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
  generar(@Body() body: GenerarComprobanteRequest) {
    return this.service.generar(body);
  }

  @Post('consultar')
  consultar(@Body() body: ConsultarComprobanteRequest) {
    return this.service.consultar(body);
  }

  @Post(':id/reintentar')
  reintentar(@Param('id') id: string) {
    return this.service.reintentar(Number(id));
  }

  @Post('anular')
  @Roles('admin')
  anular(@Body() body: AnularComprobanteRequest) {
    return this.service.anular(body);
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
    @Query('desde') desde?: string,
    @Query('hasta') hasta?: string,
    @Query('pagina') pagina?: string,
    @Query('por_pagina') porPagina?: string,
  ) {
    return this.service.listar({
      texto,
      id_tipo: idTipo ? Number(idTipo) : undefined,
      estado,
      desde,
      hasta,
      pagina: Number(pagina) || 1,
      por_pagina: Number(porPagina) || 20,
    });
  }

  @Get('venta/:id')
  listarPorVenta(@Param('id') id: string) {
    return this.service.listarPorVenta(Number(id));
  }

  @Get('cliente/:id')
  listarPorCliente(@Param('id') id: string) {
    return this.service.listarPorCliente(Number(id));
  }

  @Get(':id/detalle')
  detalle(@Param('id') id: string) {
    return this.service.obtenerDetalle(Number(id));
  }

  @Get(':id')
  obtenerPorId(@Param('id') id: string) {
    return this.service.obtenerPorId(Number(id));
  }

  @Get(':id/pdf')
  async pdf(@Res() res: Response, @Param('id') id: string) {
    const buffer = await this.service.obtenerPdfBuffer(Number(id));
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename=comprobante_${id}.pdf`);
    res.send(buffer);
  }
}

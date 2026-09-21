import { Controller, Get, Post, Body, Param, ParseIntPipe, Req, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import type { Request } from 'express';
import { GuiaRemisionBussnies } from '../../bussnies/Bussnies/guia-remision.bussnies';
import { CrearGuiaRemisionRequest } from '../../models/model/guia-remision.request';
import { JwtGuard } from '../../guards/jwt.guard';
import { RolesGuard } from '../../guards/roles.guard';
import { Roles } from '../../guards/roles.decorator';

@Controller('guia-remision')
export class GuiaRemisionController {

  constructor(private readonly service: GuiaRemisionBussnies) {}

  @Get()
  @UseGuards(JwtGuard, RolesGuard)
  @Roles('admin', 'vendedor', 'caja')
  getAll() {
    return this.service.getAll();
  }

  @Get('ventas/:id/contexto')
  @UseGuards(JwtGuard, RolesGuard)
  @Roles('admin', 'vendedor', 'caja')
  contextoVenta(@Param('id', ParseIntPipe) id: number) {
    return this.service.contextoVenta(id);
  }

  @Get(':id/pdf')
  @UseGuards(JwtGuard, RolesGuard)
  @Roles('admin', 'vendedor', 'caja')
  async pdf(@Param('id', ParseIntPipe) id: number, @Res() res: Response) {
    const archivo = await this.service.generarPdf(id);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${archivo.nombreArchivo}"`);
    res.setHeader('Cache-Control', 'no-store');
    return res.send(archivo.buffer);
  }

  @Get(':id')
  @UseGuards(JwtGuard, RolesGuard)
  @Roles('admin', 'vendedor', 'caja')
  getById(@Param('id', ParseIntPipe) id: number) {
    return this.service.getById(id);
  }

  @Post()
  @UseGuards(JwtGuard, RolesGuard)
  @Roles('admin', 'vendedor')
  create(@Body() body: CrearGuiaRemisionRequest, @Req() req: Request) {
    const usuario = req.user as { id_usuario?: number } | undefined;
    return this.service.create(body, Number(usuario?.id_usuario) || undefined);
  }
}

import { Body, Controller, Get, Param, ParseIntPipe, Post, Put, Query, UseGuards } from '@nestjs/common';
import { CreditoBussnies } from '../../bussnies/Bussnies/credito.bussnies';
import { JwtGuard } from '../../guards/jwt.guard';
import { RolesGuard } from '../../guards/roles.guard';
import { Roles } from '../../guards/roles.decorator';
import { UsuarioActual } from '../../guards/usuario-actual.decorator';
import type { UsuarioToken } from '../../guards/usuario-actual.decorator';
import { AbonoCreditoRequest, LineaCreditoRequest } from '../../models/model/credito.request';

@Controller('credito')
@UseGuards(JwtGuard, RolesGuard)
@Roles('admin', 'vendedor', 'caja')
export class CreditoController {
  constructor(private readonly service: CreditoBussnies) {}

  /** Línea de crédito del cliente o empresa (para el POS). */
  @Get('linea')
  linea(@Query('id_cliente') idCliente?: string, @Query('id_empresa') idEmpresa?: string) {
    const cliente = Number(idCliente);
    const empresa = Number(idEmpresa);
    return this.service.lineaDe({
      id_cliente: Number.isInteger(cliente) && cliente > 0 ? cliente : undefined,
      id_empresa: Number.isInteger(empresa) && empresa > 0 ? empresa : undefined,
    });
  }

  @Get('cuentas')
  listar(
    @Query('estado') estado?: string,
    @Query('texto') texto?: string,
    @Query('pagina') pagina?: string,
    @Query('limite') limite?: string,
  ) {
    return this.service.listar({
      estado,
      texto,
      pagina: Number(pagina) || 1,
      limite: Number(limite) || 20,
    });
  }

  @Get('cuentas/:id')
  obtener(@Param('id', ParseIntPipe) id: number) {
    return this.service.obtener(id);
  }

  @Post('cuentas/:id/abonos')
  abonar(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: AbonoCreditoRequest,
    @UsuarioActual() usuario: UsuarioToken,
  ) {
    return this.service.abonar(id, body, usuario);
  }

  @Put('cliente/:id')
  @Roles('admin')
  actualizarCliente(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: LineaCreditoRequest,
    @UsuarioActual() usuario: UsuarioToken,
  ) {
    return this.service.actualizarCliente(id, body, usuario);
  }

  @Put('empresa/:id')
  @Roles('admin')
  actualizarEmpresa(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: LineaCreditoRequest,
    @UsuarioActual() usuario: UsuarioToken,
  ) {
    return this.service.actualizarEmpresa(id, body, usuario);
  }
}

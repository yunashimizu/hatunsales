import { Body, Controller, Get, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { CreditoBussnies } from '../../bussnies/Bussnies/credito.bussnies';
import { JwtGuard } from '../../guards/jwt.guard';
import { RolesGuard } from '../../guards/roles.guard';
import { Roles } from '../../guards/roles.decorator';
import { UsuarioActual } from '../../guards/usuario-actual.decorator';
import type { UsuarioToken } from '../../guards/usuario-actual.decorator';

@Controller('credito')
@UseGuards(JwtGuard, RolesGuard)
@Roles('admin', 'vendedor', 'caja')
export class CreditoController {
  constructor(private readonly service: CreditoBussnies) {}

  /** Línea de crédito del cliente o empresa (para el POS). */
  @Get('linea')
  linea(@Query('id_cliente') idCliente?: string, @Query('id_empresa') idEmpresa?: string) {
    return this.service.lineaDe({
      id_cliente: idCliente ? Number(idCliente) : undefined,
      id_empresa: idEmpresa ? Number(idEmpresa) : undefined,
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
  obtener(@Param('id') id: string) {
    return this.service.obtener(Number(id));
  }

  @Post('cuentas/:id/abonos')
  abonar(
    @Param('id') id: string,
    @Body() body: { monto: number; id_metodo?: number; referencia?: string },
    @UsuarioActual() usuario: UsuarioToken,
  ) {
    return this.service.abonar(Number(id), body, usuario);
  }

  @Put('cliente/:id')
  @Roles('admin')
  actualizarCliente(
    @Param('id') id: string,
    @Body() body: { credito_activo?: boolean; limite_credito?: number; dias_credito?: number },
    @UsuarioActual() usuario: UsuarioToken,
  ) {
    return this.service.actualizarCliente(Number(id), body, usuario);
  }

  @Put('empresa/:id')
  @Roles('admin')
  actualizarEmpresa(
    @Param('id') id: string,
    @Body() body: { credito_activo?: boolean; limite_credito?: number; dias_credito?: number },
    @UsuarioActual() usuario: UsuarioToken,
  ) {
    return this.service.actualizarEmpresa(Number(id), body, usuario);
  }
}

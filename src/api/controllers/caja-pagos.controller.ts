import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { CajaPagosBussnies } from '../../bussnies/Bussnies/caja-pagos.bussnies';
import { JwtGuard } from '../../guards/jwt.guard';
import { RolesGuard } from '../../guards/roles.guard';
import { Roles } from '../../guards/roles.decorator';
import {
  ActualizarCuentaBancariaRequest,
  CuentaBancariaRequest,
  IniciarYapeRequest,
} from '../../models/model/caja.request';

@Controller('caja')
@UseGuards(JwtGuard, RolesGuard)
@Roles('admin', 'vendedor', 'caja')
export class CajaPagosController {
  constructor(private readonly service: CajaPagosBussnies) {}

  /** Qué puede hacer el POS: Culqi Yape, tarjeta física, etc. */
  @Get('pasarela')
  pasarela() {
    return this.service.pasarela();
  }

  @Get('cuentas-bancarias')
  listar(@Query('todas') todas?: string) {
    return this.service.listarCuentas(todas === '1' || todas === 'true');
  }

  @Post('cuentas-bancarias')
  @Roles('admin')
  crear(@Body() body: CuentaBancariaRequest) {
    return this.service.crearCuenta(body);
  }

  @Put('cuentas-bancarias/:id')
  @Roles('admin')
  actualizar(@Param('id', ParseIntPipe) id: number, @Body() body: ActualizarCuentaBancariaRequest) {
    return this.service.actualizarCuenta(id, body);
  }

  @Delete('cuentas-bancarias/:id')
  @Roles('admin')
  eliminar(@Param('id', ParseIntPipe) id: number) {
    return this.service.eliminarCuenta(id);
  }

  /** Genera orden Culqi para Yape (o indica modo manual). */
  @Post('yape/iniciar')
  iniciarYape(@Body() body: IniciarYapeRequest) {
    return this.service.iniciarYape(body);
  }

  @Get('yape/verificar/:orderId')
  verificarYape(@Param('orderId') orderId: string) {
    return this.service.verificarYape(orderId);
  }
}

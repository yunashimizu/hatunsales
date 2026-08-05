import { Body, Controller, Get, Put, UseGuards } from '@nestjs/common';
import { ConfiguracionFiscalBussnies } from '../../bussnies/Bussnies/configuracion-fiscal.bussnies';
import { JwtGuard } from '../../guards/jwt.guard';
import { RolesGuard } from '../../guards/roles.guard';
import { Roles } from '../../guards/roles.decorator';

@Controller('configuracion')
@UseGuards(JwtGuard, RolesGuard)
export class ConfiguracionController {
  constructor(private readonly service: ConfiguracionFiscalBussnies) {}

  /** Series para el POS (cualquier rol de venta). */
  @Get('series')
  @Roles('admin', 'vendedor', 'caja', 'consulta')
  series() {
    return this.service.seriesPos();
  }

  /** Emisor + series + estados (admin). */
  @Get('fiscal')
  @Roles('admin')
  fiscal() {
    return this.service.obtenerAdmin();
  }

  @Put('fiscal')
  @Roles('admin')
  guardarFiscal(
    @Body()
    body: {
      emisor?: Record<string, string>;
      series?: { serie_boleta?: string; serie_factura?: string };
    },
  ) {
    return this.service.guardarAdmin(body ?? {});
  }
}

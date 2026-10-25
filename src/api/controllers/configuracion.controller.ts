import { Body, Controller, Get, Put, UseGuards } from '@nestjs/common';
import { ConfiguracionFiscalBussnies } from '../../bussnies/Bussnies/configuracion-fiscal.bussnies';
import { JwtGuard } from '../../guards/jwt.guard';
import { RolesGuard } from '../../guards/roles.guard';
import { Roles } from '../../guards/roles.decorator';

@Controller('configuracion')
@UseGuards(JwtGuard, RolesGuard)
export class ConfiguracionController {
  constructor(private readonly service: ConfiguracionFiscalBussnies) {}

  /**
   * Series del ambiente de emisión vigente para el POS (cualquier rol de venta) y si la emisión
   * está activa. Nunca falla por emisión inactiva: lo explica en `mensaje`.
   */
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

  /** Emisor y condiciones de la proforma. `series` se ignora: se configuran en Facturación SUNAT. */
  @Put('fiscal')
  @Roles('admin')
  guardarFiscal(
    @Body()
    body: {
      emisor?: Record<string, string>;
      proforma?: { condiciones?: string };
      series?: { serie_boleta?: string; serie_factura?: string };
    },
  ) {
    return this.service.guardarAdmin(body ?? {});
  }
}

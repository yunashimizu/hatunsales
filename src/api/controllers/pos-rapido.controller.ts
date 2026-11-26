import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { JwtGuard } from '../../guards/jwt.guard';
import { RolesGuard } from '../../guards/roles.guard';
import { Roles } from '../../guards/roles.decorator';
import { PosRapidoService } from '../../pos-rapido/pos-rapido.service';

/**
 * Lecturas del cobro rápido (Fases 3.2 y 3.3), para los roles del punto de venta. Sin costos.
 * Rutas con dos o más segmentos: no chocan con `GET cliente/:id` ni con `GET venta/:id`.
 */
@Controller()
@UseGuards(JwtGuard, RolesGuard)
@Roles('admin', 'vendedor', 'caja')
export class PosRapidoController {
  constructor(private readonly servicio: PosRapidoService) {}

  /** 3.2: últimos 5 productos distintos del cliente, con su último precio pagado, cantidad y fecha. */
  @Get('cliente/:id/ultimos-productos')
  ultimosDeCliente(@Param('id') id: string) {
    return this.servicio.ultimosProductos('cliente', Number(id));
  }

  /** 3.2, variante de empresas (las ventas a empresa van por ventas.id_empresa). */
  @Get('cliente/empresa/:id/ultimos-productos')
  ultimosDeEmpresa(@Param('id') id: string) {
    return this.servicio.ultimosProductos('empresa', Number(id));
  }

  /** 3.3: los 12 más vendidos del local del almacén en 30 días (lista vacía si hay pocas ventas). */
  @Get('pos/frecuentes')
  frecuentes(@Query('id_almacen') idAlmacen: string) {
    return this.servicio.frecuentes(Number(idAlmacen));
  }
}

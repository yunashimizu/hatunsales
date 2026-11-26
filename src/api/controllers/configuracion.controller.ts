import { Body, Controller, Get, Optional, Put, ServiceUnavailableException, UseGuards } from '@nestjs/common';
import { ConfiguracionFiscalBussnies } from '../../bussnies/Bussnies/configuracion-fiscal.bussnies';
import { ControlRebajaService } from '../../control-rebaja/control-rebaja.service';
import type { CambioControlRebaja } from '../../control-rebaja/control-rebaja.service';
import { ControlCajaService } from '../../caja/configuracion/control-caja.service';
import type { CambioControlCaja } from '../../caja/configuracion/control-caja';
import { ControlStockService } from '../../stock/control-stock.service';
import type { CambioControlStock } from '../../stock/control-stock';
import { UsuarioActual } from '../../guards/usuario-actual.decorator';
import type { UsuarioToken } from '../../guards/usuario-actual.decorator';
import { JwtGuard } from '../../guards/jwt.guard';
import { RolesGuard } from '../../guards/roles.guard';
import { Roles } from '../../guards/roles.decorator';

@Controller('configuracion')
@UseGuards(JwtGuard, RolesGuard)
export class ConfiguracionController {
  constructor(
    private readonly service: ConfiguracionFiscalBussnies,
    /** Fase 6.4. Nest siempre lo inyecta; opcional para las pruebas que solo arman la parte fiscal. */
    @Optional() private readonly controlRebaja?: ControlRebajaService,
    /** Fase 7. Nest siempre lo inyecta; opcional para las pruebas que solo arman la parte fiscal. */
    @Optional() private readonly controlCaja?: ControlCajaService,
    /** Fase 8. Nest siempre lo inyecta; opcional para las pruebas que solo arman la parte fiscal. */
    @Optional() private readonly controlStock?: ControlStockService,
  ) {}

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

  /** Control de rebajas del POS (Fase 6.4): modo (`registrar` · `autorizar` · `apagado`), tope % y bajo costo. */
  @Get('control-rebaja')
  @Roles('admin')
  controlRebajaActual() {
    return this.control().configuracion();
  }

  /** Cambia solo lo que llega; cada cambio queda en la bitácora (`configuracion.control_rebaja`). */
  @Put('control-rebaja')
  @Roles('admin')
  guardarControlRebaja(@Body() body: CambioControlRebaja, @UsuarioActual() usuario: UsuarioToken) {
    return this.control().guardar(body ?? {}, usuario);
  }

  /**
   * Fase 7: `anulacion_credito_con_abonos` (`bloquear` · `permitir`), `arqueo_ciego` (bool) y
   * `caja_cierre_automatico_horas` (0 = apagado, o 8 a 72).
   */
  @Get('control-caja')
  @Roles('admin')
  controlCajaActual() {
    return this.caja().configuracion();
  }

  /** Cambia solo lo que llega; cada cambio queda en la bitácora (`configuracion.control_caja`). */
  @Put('control-caja')
  @Roles('admin')
  guardarControlCaja(@Body() body: CambioControlCaja, @UsuarioActual() usuario: UsuarioToken) {
    return this.caja().guardar(body ?? {}, usuario);
  }

  /**
   * Fase 8: `pedido_vencimiento_horas_pasarela` y `pedido_vencimiento_horas_transferencia` (0 = apagado, o 2 a 720;
   * sugerido 24 y 48) y `recepcion_guia_repetida` (`avisar` · `bloquear`).
   */
  @Get('control-stock')
  @Roles('admin')
  controlStockActual() {
    return this.stock().configuracion();
  }

  /** Cambia solo lo que llega; cada cambio queda en la bitácora (`configuracion.control_stock`). */
  @Put('control-stock')
  @Roles('admin')
  guardarControlStock(@Body() body: CambioControlStock, @UsuarioActual() usuario: UsuarioToken) {
    return this.stock().guardar(body ?? {}, usuario);
  }

  private stock(): ControlStockService {
    if (!this.controlStock) throw new ServiceUnavailableException('La configuración de stock no está disponible en este momento.');
    return this.controlStock;
  }

  private caja(): ControlCajaService {
    if (!this.controlCaja) throw new ServiceUnavailableException('La configuración de caja no está disponible en este momento.');
    return this.controlCaja;
  }

  private control(): ControlRebajaService {
    if (!this.controlRebaja) throw new ServiceUnavailableException('El control de rebajas no está disponible en este momento.');
    return this.controlRebaja;
  }
}

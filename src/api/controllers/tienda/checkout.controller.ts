import { Body, Controller, Get, Headers, HttpCode, Post } from '@nestjs/common';
import { CheckoutBussnies } from '../../../bussnies/Bussnies/tienda/checkout.bussnies';
import { PagoBussnies } from '../../../bussnies/Bussnies/tienda/pago.bussnies';

/** Catálogos que el checkout necesita mostrar antes de cerrar la compra. */
@Controller('tienda/checkout')
export class CheckoutController {

  constructor(
    private readonly service: CheckoutBussnies,
    private readonly pagos: PagoBussnies,
  ) {}

  @Get('metodos-envio')
  metodosEnvio() {
    return this.service.metodosEnvio();
  }

  @Get('metodos-pago')
  metodosPago() {
    return this.service.metodosPago();
  }

  /**
   * Proveedor y llave pública activos. El frontend usa esto para decidir si
   * muestra el formulario de tarjeta o solo instrucciones de pago.
   */
  @Get('pasarela')
  pasarela() {
    return this.pagos.configuracionPublica();
  }

  @Post('validar-cupon')
  async validarCupon(@Body() body: { codigo: string; monto: number }) {
    const { cupon, descuento } = await this.service.validarCupon(body.codigo, Number(body.monto ?? 0));

    return {
      valido: true,
      codigo: cupon.codigo,
      descripcion: cupon.descripcion ?? '',
      tipo: cupon.tipo,
      valor: Number(cupon.valor ?? 0),
      descuento,
    };
  }
}

/**
 * Notificaciones de la pasarela. Va sin guard porque quien llama es el
 * proveedor, no un usuario; la autenticidad se valida con la firma del webhook.
 *
 * Siempre responde 200 para que la pasarela no reintente en bucle: los casos
 * con problema quedan guardados en `pasarela_eventos` para revisarlos.
 */
@Controller('tienda/pagos')
export class PagoWebhookController {

  constructor(private readonly pagos: PagoBussnies) {}

  @Post('webhook')
  @HttpCode(200)
  webhook(@Body() cuerpo: any, @Headers() cabeceras: Record<string, any>) {
    return this.pagos.procesarWebhook(cuerpo, cabeceras);
  }
}

import { IsIn, IsInt, IsOptional, IsString, MaxLength } from 'class-validator';

export class CrearPedidoRequest {
  @IsInt()
  @IsOptional()
  id_direccion?: number;

  @IsInt()
  @IsOptional()
  id_metodo_envio?: number;

  @IsInt()
  @IsOptional()
  id_metodo_pago?: number;

  @IsString()
  @IsOptional()
  cupon?: string;

  @IsIn(['boleta', 'factura'])
  @IsOptional()
  tipo_comprobante?: string;

  /** DNI para boleta, RUC para factura */
  @IsString()
  @IsOptional()
  @MaxLength(20)
  documento_receptor?: string;

  @IsString()
  @IsOptional()
  nombre_receptor?: string;

  @IsString()
  @IsOptional()
  notas?: string;

  /** Carrito de invitado a convertir en pedido */
  @IsString()
  @IsOptional()
  token_invitado?: string;

  /**
   * Identificador único del intento de compra, generado por el navegador.
   * Si la petición se reintenta por mala conexión, devolvemos el pedido que ya
   * se creó en lugar de generar uno nuevo. También llega por la cabecera
   * `Idempotency-Key`.
   */
  @IsString()
  @IsOptional()
  @MaxLength(80)
  clave_idempotencia?: string;
}

export class CambiarEstadoPedidoRequest {
  @IsIn(['pendiente', 'pagado', 'preparando', 'enviado', 'entregado', 'cancelado'])
  estado!: string;

  @IsString()
  @IsOptional()
  comentario?: string;
}

export class RegistrarPagoRequest {
  @IsInt()
  @IsOptional()
  id_metodo?: number;

  @IsString()
  @IsOptional()
  referencia?: string;

  /** Token de tarjeta generado por el SDK de la pasarela en el navegador. */
  @IsString()
  @IsOptional()
  token_pasarela?: string;

  @IsString()
  @IsOptional()
  email?: string;

  @IsString()
  @IsOptional()
  @MaxLength(80)
  clave_idempotencia?: string;
}

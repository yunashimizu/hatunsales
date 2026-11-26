import { IsArray, IsString, MaxLength, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { ItemVentaRequest } from './venta.request';

/**
 * `POST venta/autorizacion` (Fase 6.4): un administrador activo autoriza las líneas de una venta.
 * `items` son los mismos que se mandarán en `POST venta` (producto, cantidad, precio y descuento):
 * el servidor calcula el precio final de cada una igual que al cobrar y firma esa huella.
 * La contraseña no se guarda ni se escribe en ningún log.
 */
export class AutorizarVentaRequest {
  @IsString()
  @MaxLength(254)
  email!: string;

  @IsString()
  @MaxLength(200)
  password!: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ItemVentaRequest)
  items!: ItemVentaRequest[];
}

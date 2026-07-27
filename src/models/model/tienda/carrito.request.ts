import { IsInt, IsOptional, IsString, Min } from 'class-validator';

export class AgregarItemCarritoRequest {
  @IsInt()
  id_producto!: number;

  @IsInt()
  @Min(1)
  cantidad!: number;

  /** Identificador del carrito de invitado cuando no hay sesión iniciada */
  @IsString()
  @IsOptional()
  token_invitado?: string;
}

export class ActualizarItemCarritoRequest {
  @IsInt()
  @Min(1)
  cantidad!: number;

  @IsString()
  @IsOptional()
  token_invitado?: string;
}

export class FusionarCarritoRequest {
  @IsString()
  token_invitado!: string;
}

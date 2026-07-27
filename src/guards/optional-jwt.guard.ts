import { ExecutionContext, Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

/**
 * Deja pasar la petición tenga o no token.
 * Si el token es válido llena `request.user`; si no, lo deja en `undefined`.
 *
 * Se usa en la tienda pública, donde un visitante sin cuenta debe poder navegar
 * y armar su carrito, pero un cliente autenticado recibe además sus datos.
 */
@Injectable()
export class OptionalJwtGuard extends AuthGuard('jwt') {

  async canActivate(context: ExecutionContext): Promise<boolean> {
    try {
      await super.canActivate(context);
    } catch {
      // Token ausente, inválido o vencido: seguimos como visitante anónimo.
    }
    return true;
  }

  handleRequest(_err: any, user: any) {
    return user ?? undefined;
  }
}

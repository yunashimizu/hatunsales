import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import type { AlmacenLimites } from '../util/http/limite-peticiones/almacen-limites';
import { DemasiadasPeticionesException } from '../util/http/limite-peticiones/demasiadas-peticiones.exception';
import { ALMACEN_LIMITES } from '../util/http/limite-peticiones/limite-peticiones.providers';
import { PoliticaLimites } from '../util/http/limite-peticiones/politica-limites';

/**
 * Límite de peticiones por IP (guard global, APP_GUARD). Corre antes que
 * JwtGuard, así que frena la fuerza bruta antes de gastar CPU en bcrypt o en
 * validar tokens. La IP sale de req.ip, que con `trust proxy` (main.ts) es la
 * del cliente según X-Forwarded-For del edge de Railway. Responde 429 con
 * Retry-After y `codigo: 'DEMASIADAS_SOLICITUDES'`. Se apaga con
 * LIMITE_PETICIONES_ACTIVO=false.
 */
@Injectable()
export class LimitePeticionesGuard implements CanActivate {
  constructor(
    private readonly politica: PoliticaLimites,
    @Inject(ALMACEN_LIMITES) private readonly almacen: AlmacenLimites,
  ) {}

  canActivate(contexto: ExecutionContext): boolean {
    if (contexto.getType() !== 'http' || !this.politica.activa) return true;
    const req = contexto.switchToHttp().getRequest<Request>();

    const consumos = this.politica.consumosPara({
      metodo: req.method,
      ruta: req.path ?? req.url,
      ip: req.ip ?? req.socket?.remoteAddress,
      cuerpo: req.body,
    });
    if (!consumos.length) return true;

    const resultado = this.almacen.consumir(consumos, Date.now());
    if (resultado.permitido) return true;

    const segundos = Math.max(1, Math.ceil(resultado.reintentarEnMs / 1000));
    const cubeta = consumos[resultado.indiceBloqueo ?? 0].cubeta;
    throw new DemasiadasPeticionesException(segundos, this.politica.mensaje(cubeta, segundos));
  }
}

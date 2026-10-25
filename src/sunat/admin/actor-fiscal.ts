import type { Request } from 'express';
import type { UsuarioToken } from '../../guards/usuario-actual.decorator';
import type { ActorFiscal } from '../config/fiscal-config.tipos';

/** Quién hace el cambio (usuario del token e IP) para la auditoría fiscal. */
export function actorDe(usuario: UsuarioToken | undefined, req: Request): ActorFiscal {
  return {
    id_usuario: usuario?.id_usuario ?? null,
    nombre: usuario?.nombre ?? null,
    ip: (req.ip ?? req.socket?.remoteAddress ?? null) || null,
  };
}

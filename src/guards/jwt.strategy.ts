import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Request } from 'express';
import { jwtConfig } from '../config/jwt.config';
import { Usuarios } from '../models/DBModel/usuarios.entity';
import { VwUsuarioPermisos } from '../models/DBModel/vw-usuario-permisos.entity';
import { normalizarRol } from '../config/roles.config';

interface JwtPayload {
  sub: number;
  nombre: string;
  email: string;
  rol: string;
  permisos: string[];
}

/** Lo que queda en `req.user` para guards y controladores. */
export interface UsuarioValidado {
  id_usuario: number;
  nombre: string;
  email: string;
  rol: string;
  permisos: string[];
}

/**
 * Validar el token costaba dos consultas a la BD en CADA petición (usuario+rol
 * y vista de permisos), antes del trabajo propio del endpoint. Se cachea por
 * usuario unos segundos: un cambio de rol/permisos o una desactivación tarda
 * como máximo este tiempo en aplicarse a las sesiones ya abiertas.
 */
const CACHE_TTL_MS = 30_000;
const CACHE_MAX_ENTRADAS = 500;

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {

  private readonly cache = new Map<number, { valor: UsuarioValidado; expira: number }>();

  constructor(
    @InjectRepository(Usuarios, 'pgConnection')
    private readonly usuarioRepo: Repository<Usuarios>,

    @InjectRepository(VwUsuarioPermisos, 'pgConnection')
    private readonly vwRepo: Repository<VwUsuarioPermisos>,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromExtractors([
        (req: Request) => req?.cookies?.access_token ?? null,
        ExtractJwt.fromAuthHeaderAsBearerToken(),
      ]),
      ignoreExpiration: false,
      secretOrKey: jwtConfig.secret,
    });
  }

  async validate(payload: JwtPayload): Promise<UsuarioValidado> {
    if (!payload?.sub) {
      throw new UnauthorizedException('Token inválido');
    }

    const ahora = Date.now();
    const enCache = this.cache.get(payload.sub);
    if (enCache && enCache.expira > ahora) {
      return this.copiar(enCache.valor);
    }

    // Ambas consultas dependen solo del id del token: van en paralelo.
    const [usuario, filas] = await Promise.all([
      this.usuarioRepo.findOne({
        where: { id_usuario: payload.sub, estado: true },
        relations: ['rol'],
      }),
      this.vwRepo.find({ where: { id_usuario: payload.sub } }),
    ]);

    if (!usuario) {
      this.cache.delete(payload.sub);
      throw new UnauthorizedException('Sesión inválida o cuenta desactivada');
    }

    const valor: UsuarioValidado = {
      id_usuario: usuario.id_usuario,
      nombre: usuario.nombre,
      email: usuario.email,
      rol: normalizarRol(usuario.rol?.nombre ?? payload.rol),
      permisos: filas.map((f) => f.permiso),
    };

    if (this.cache.size >= CACHE_MAX_ENTRADAS) this.cache.clear();
    this.cache.set(payload.sub, { valor, expira: ahora + CACHE_TTL_MS });

    return this.copiar(valor);
  }

  /** Cada petición recibe su propio objeto: nadie puede alterar la entrada cacheada. */
  private copiar(valor: UsuarioValidado): UsuarioValidado {
    return { ...valor, permisos: [...valor.permisos] };
  }
}

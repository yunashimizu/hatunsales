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

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {

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

  async validate(payload: JwtPayload) {
    if (!payload?.sub) {
      throw new UnauthorizedException('Token inválido');
    }

    const usuario = await this.usuarioRepo.findOne({
      where: { id_usuario: payload.sub, estado: true },
      relations: ['rol'],
    });

    if (!usuario) {
      throw new UnauthorizedException('Sesión inválida o cuenta desactivada');
    }

    const filas = await this.vwRepo.find({ where: { id_usuario: usuario.id_usuario } });
    const permisos = filas.map((f) => f.permiso);
    const rol = normalizarRol(usuario.rol?.nombre ?? payload.rol);

    return {
      id_usuario: usuario.id_usuario,
      nombre: usuario.nombre,
      email: usuario.email,
      rol,
      permisos,
    };
  }
}

import { Injectable, UnauthorizedException, ConflictException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Usuarios } from '../../models/DBModel/usuarios.entity';
import { HashUtil } from '../../util/jwt/hash.util';
import { TokenUtil } from '../../util/jwt/token.util';
import { jwtConfig } from '../../config/jwt.config';
import { VwUsuarioPermisos } from 'src/models/DBModel/vw-usuario-permisos.entity';
import { LoginRequest, RegisterRequest } from 'src/models/model/login-request';
import { authRequest } from 'src/models/model/auth.request';

@Injectable()
export class AuthBussnies {

  constructor(
    @InjectRepository(Usuarios, 'pgConnection')
    private readonly usuarioRepo: Repository<Usuarios>,

    @InjectRepository(VwUsuarioPermisos, 'pgConnection')
    private readonly vwRepo: Repository<VwUsuarioPermisos>,

    private readonly jwtService: JwtService,
  ) {}

  async login(dto: authRequest, res: any): Promise<any> {
    const usuario = await this.usuarioRepo.findOne({
      where: { email: dto.email, estado: true },
      relations: ['rol'],
    });

    if (!usuario) throw new UnauthorizedException('Credenciales incorrectas');

    const passwordValido = await HashUtil.comparePassword(dto.password, usuario.password);
    if (!passwordValido) throw new UnauthorizedException('Credenciales incorrectas');

    const filas = await this.vwRepo.find({
      where: { id_usuario: usuario.id_usuario },
    });

    const permisos = filas.map((f) => f.permiso);
    const rol = usuario.rol.nombre;
    const expiresIn = TokenUtil.getExpiresIn(rol);

    const payload = {
      sub: usuario.id_usuario,
      nombre: usuario.nombre,
      email: usuario.email,
      rol,
      permisos,
    };

    const token = this.jwtService.sign(payload as any, {
      secret: jwtConfig.secret,
      expiresIn: expiresIn as any,  // ← agregar "as any" aquí
    });

    res.cookie('access_token', token, {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: TokenUtil.getCookieMaxAge(rol),
    });

    return {
      id_usuario: usuario.id_usuario,
      nombre: usuario.nombre,
      email: usuario.email,
      rol: { idRol: usuario.rol?.id_rol ?? null, nombre: usuario.rol?.nombre ?? rol },
      permisos,
      access_token: token,
      expires_in: expiresIn,
    };
  }

  async register(dto: RegisterRequest): Promise<any> {
    const existe = await this.usuarioRepo.findOne({
      where: { email: dto.email },
    });

    if (existe) throw new ConflictException('El email ya está registrado');

    const hashedPassword = await HashUtil.hashPassword(dto.password);

    const nuevoUsuario = this.usuarioRepo.create({
      nombre: dto.nombre,
      email: dto.email,
      password: hashedPassword,
      estado: true,
      rol: { id_rol: 4 },
    });

    const guardado = await this.usuarioRepo.save(nuevoUsuario);

    return {
      id_usuario: guardado.id_usuario,
      nombre: guardado.nombre,
      email: guardado.email,
      mensaje: 'Cuenta creada correctamente',
    };
  }

  async logout(res: any): Promise<any> {
    res.clearCookie('access_token');
    return { message: 'Sesión cerrada correctamente' };
  }
}
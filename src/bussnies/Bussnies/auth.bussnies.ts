import { Injectable, UnauthorizedException, ConflictException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Usuarios } from '../../models/DBModel/usuarios.entity';
import { Cliente } from '../../models/DBModel/cliente.entity';
import { Rol } from '../../models/DBModel/role.entity';
import { HashUtil } from '../../util/jwt/hash.util';
import { TokenUtil } from '../../util/jwt/token.util';
import { jwtConfig } from '../../config/jwt.config';
import { VwUsuarioPermisos } from 'src/models/DBModel/vw-usuario-permisos.entity';
import { LoginRequest, RegisterRequest } from 'src/models/model/login-request';

interface JwtPayload {
  sub: number;
  nombre: string;
  email: string;
  rol: string;
  permisos: string[];
}

@Injectable()
export class AuthBussnies {

  constructor(
    @InjectRepository(Usuarios, 'pgConnection')
    private readonly usuarioRepo: Repository<Usuarios>,

    @InjectRepository(VwUsuarioPermisos, 'pgConnection')
    private readonly vwRepo: Repository<VwUsuarioPermisos>,

    @InjectRepository(Cliente, 'pgConnection')
    private readonly clienteRepo: Repository<Cliente>,

    private readonly jwtService: JwtService,
  ) {}

  private normalizeRoleName(role?: string): string {
    const normalized = (role ?? 'cliente').trim().toLowerCase();
    const aliases: Record<string, string> = {
      administrador: 'admin',
      administradora: 'admin',
      admin: 'admin',
      vendedor: 'vendedor',
      cajero: 'caja',
      caja: 'caja',
      trabajador: 'vendedor',
      trabajadores: 'vendedor',
      empleado: 'vendedor',
      empleados: 'vendedor',
      cliente: 'cliente',
    };

    return aliases[normalized] ?? normalized;
  }

  async login(dto: LoginRequest, res: any): Promise<any> {
    const normalizedEmail = dto.email.trim().toLowerCase();
    const usuarios = await this.usuarioRepo.find({
      where: { estado: true },
      relations: ['rol'],
    });

    const usuario = usuarios.find((item) => item.email?.toLowerCase() === normalizedEmail);

    if (!usuario) throw new UnauthorizedException('Credenciales incorrectas');

    const passwordValido = await HashUtil.comparePassword(dto.password, usuario.password);
    if (!passwordValido) throw new UnauthorizedException('Credenciales incorrectas');

    const filas = await this.vwRepo.find({
      where: { id_usuario: usuario.id_usuario },
    });

    const permisos = filas.map((f) => f.permiso);
    const rol = this.normalizeRoleName(usuario.rol?.nombre ?? 'cliente');
    const expiresIn = TokenUtil.getExpiresIn(rol);

    const payload: JwtPayload = {
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
      success: true,
      mensaje: 'Inicio de sesión correcto',
      id_usuario: usuario.id_usuario,
      nombre: usuario.nombre,
      email: usuario.email,
      rol: { idRol: usuario.rol?.id_rol ?? null, nombre: rol },
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
    const normalizedEmail = dto.email.trim().toLowerCase();

    const rolCliente = await this.usuarioRepo.manager.findOne(Rol, {
      where: { nombre: 'cliente' },
    });

    const nuevoUsuario = this.usuarioRepo.create({
      nombre: dto.nombre,
      email: normalizedEmail,
      password: hashedPassword,
      estado: true,
      rol: rolCliente ? ({ id_rol: rolCliente.id_rol } as Rol) : ({ id_rol: 4 } as Rol),
    });

    const guardado = await this.usuarioRepo.save(nuevoUsuario);

    await this.clienteRepo.save(
      this.clienteRepo.create({
        nombre: dto.nombre,
        email: normalizedEmail,
        usuario: { id_usuario: guardado.id_usuario } as Usuarios,
      }),
    );

    return {
      success: true,
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
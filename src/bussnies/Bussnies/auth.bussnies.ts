import { Injectable, UnauthorizedException, ConflictException, NotFoundException, BadRequestException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { OAuth2Client } from 'google-auth-library';
import { randomBytes } from 'crypto';
import { Usuarios } from '../../models/DBModel/usuarios.entity';
import { Cliente } from '../../models/DBModel/cliente.entity';
import { Rol } from '../../models/DBModel/role.entity';
import { HashUtil } from '../../util/jwt/hash.util';
import { TokenUtil } from '../../util/jwt/token.util';
import { jwtConfig } from '../../config/jwt.config';
import { googleAuthConfig } from '../../config/google-auth.config';
import { VwUsuarioPermisos } from 'src/models/DBModel/vw-usuario-permisos.entity';
import { LoginRequest, RegisterRequest } from 'src/models/model/login-request';
import { ActualizarPerfilRequest } from 'src/models/model/actualizar-perfil.request';
import { RolBussnies } from './rol.bussnies';
import { ROL_IDS } from '../../config/roles.config';

interface JwtPayload {
  sub: number;
  nombre: string;
  email: string;
  rol: string;
  permisos: string[];
}

@Injectable()
export class AuthBussnies {
  private readonly googleClient = new OAuth2Client(googleAuthConfig.clientId || undefined);

  constructor(
    @InjectRepository(Usuarios, 'pgConnection')
    private readonly usuarioRepo: Repository<Usuarios>,

    @InjectRepository(VwUsuarioPermisos, 'pgConnection')
    private readonly vwRepo: Repository<VwUsuarioPermisos>,

    @InjectRepository(Cliente, 'pgConnection')
    private readonly clienteRepo: Repository<Cliente>,

    private readonly jwtService: JwtService,
    private readonly rolService: RolBussnies,
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
      usuario: 'usuario',
    };

    return aliases[normalized] ?? normalized;
  }

  private armarNombreCompleto(dto: RegisterRequest): string {
    const nombres = (dto.nombres ?? '').trim();
    const apellidos = (dto.apellidos ?? '').trim();
    const combinado = `${nombres} ${apellidos}`.trim();
    const nombre = (dto.nombre ?? '').trim() || combinado;
    if (!nombre) throw new BadRequestException('El nombre es obligatorio');
    return nombre;
  }

  private async emitirSesion(usuario: Usuarios, res: any, mensaje = 'Inicio de sesión correcto') {
    const filas = await this.vwRepo.find({ where: { id_usuario: usuario.id_usuario } });
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
      expiresIn: expiresIn as any,
    });

    res.cookie('access_token', token, {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: TokenUtil.getCookieMaxAge(rol),
    });

    return {
      success: true,
      mensaje,
      id_usuario: usuario.id_usuario,
      nombre: usuario.nombre,
      email: usuario.email,
      rol: { idRol: usuario.rol?.id_rol ?? null, nombre: rol },
      permisos,
      access_token: token,
      expires_in: expiresIn,
    };
  }

  async login(dto: LoginRequest, res: any): Promise<any> {
    const normalizedEmail = dto.email.trim().toLowerCase();
    const usuarios = await this.usuarioRepo.find({
      where: { estado: true },
      relations: ['rol'],
    });

    const usuario = usuarios.find((item) => item.email?.toLowerCase() === normalizedEmail);

    if (!usuario) throw new UnauthorizedException('Credenciales incorrectas');

    if (!usuario.password) {
      throw new UnauthorizedException('Esta cuenta usa Google. Continúa con Google.');
    }

    const passwordValido = await HashUtil.comparePassword(dto.password, usuario.password);
    if (!passwordValido) throw new UnauthorizedException('Credenciales incorrectas');

    return this.emitirSesion(usuario, res);
  }

  /**
   * Registro público solo para clientes de tienda.
   * Empleados / admin se crean manualmente desde el panel.
   */
  async register(dto: RegisterRequest): Promise<any> {
    const normalizedEmail = dto.email.trim().toLowerCase();
    const existe = await this.usuarioRepo.findOne({ where: { email: normalizedEmail } });
    if (existe) throw new ConflictException('El email ya está registrado');

    const nombre = this.armarNombreCompleto(dto);
    const apellidos = (dto.apellidos ?? '').trim();
    const telefono = (dto.telefono ?? '').trim() || null;
    const hashedPassword = await HashUtil.hashPassword(dto.password);
    const rolCliente = await this.rolService.asegurarRolCliente();

    const nuevoUsuario = this.usuarioRepo.create({
      nombre,
      apellido_paterno: apellidos || null as any,
      email: normalizedEmail,
      password: hashedPassword,
      estado: true,
      rol: { id_rol: rolCliente.id_rol || ROL_IDS.CLIENTE } as Rol,
    });

    const guardado = await this.usuarioRepo.save(nuevoUsuario);

    await this.clienteRepo.save(
      this.clienteRepo.create({
        nombre,
        apellido_paterno: apellidos || null as any,
        email: normalizedEmail,
        telefono: telefono as any,
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

  /** Client ID público para GIS en el frontend (sin secret). */
  googleClientId() {
    return {
      clientId: googleAuthConfig.clientId || null,
      habilitado: Boolean(googleAuthConfig.clientId),
    };
  }

  /**
   * Login / registro con Google Identity Services.
   * Si el correo no existe, crea usuario + cliente (rol cliente).
   */
  async loginConGoogle(credential: string, res: any): Promise<any> {
    if (!googleAuthConfig.clientId) {
      throw new BadRequestException(
        'Google no está configurado. Defina GOOGLE_CLIENT_ID en el servidor.',
      );
    }
    if (!credential?.trim()) {
      throw new BadRequestException('Token de Google requerido');
    }

    let payload: {
      email?: string;
      email_verified?: boolean;
      name?: string;
      given_name?: string;
      family_name?: string;
    };
    try {
      const ticket = await this.googleClient.verifyIdToken({
        idToken: credential,
        audience: googleAuthConfig.clientId,
      });
      payload = ticket.getPayload() ?? {};
    } catch {
      throw new UnauthorizedException('Token de Google inválido o expirado');
    }

    const email = (payload.email ?? '').trim().toLowerCase();
    if (!email || payload.email_verified === false) {
      throw new UnauthorizedException('El correo de Google no está verificado');
    }

    const nombre =
      (payload.name ?? '').trim()
      || `${payload.given_name ?? ''} ${payload.family_name ?? ''}`.trim()
      || email.split('@')[0];

    let usuario = await this.usuarioRepo.findOne({
      where: { email },
      relations: ['rol'],
    });

    if (!usuario) {
      const rolCliente = await this.rolService.asegurarRolCliente();
      const passwordAleatorio = await HashUtil.hashPassword(randomBytes(32).toString('hex'));

      usuario = await this.usuarioRepo.save(
        this.usuarioRepo.create({
          nombre,
          apellido_paterno: (payload.family_name ?? '').trim() || null as any,
          email,
          password: passwordAleatorio,
          estado: true,
          rol: { id_rol: rolCliente.id_rol || ROL_IDS.CLIENTE } as Rol,
        }),
      );

      await this.clienteRepo.save(
        this.clienteRepo.create({
          nombre,
          apellido_paterno: (payload.family_name ?? '').trim() || null as any,
          email,
          usuario: { id_usuario: usuario.id_usuario } as Usuarios,
        }),
      );

      usuario = await this.usuarioRepo.findOne({
        where: { id_usuario: usuario.id_usuario },
        relations: ['rol'],
      }) as Usuarios;

      return this.emitirSesion(usuario, res, 'Cuenta creada con Google');
    }

    if (!usuario.estado) {
      throw new UnauthorizedException('Esta cuenta está desactivada');
    }

    return this.emitirSesion(usuario, res, 'Inicio de sesión con Google');
  }

  async logout(res: any): Promise<any> {
    res.clearCookie('access_token');
    return { message: 'Sesión cerrada correctamente' };
  }

  async obtenerPerfil(idUsuario: number) {
    const usuario = await this.usuarioRepo.findOne({
      where: { id_usuario: idUsuario, estado: true },
      relations: ['rol'],
    });
    if (!usuario) throw new NotFoundException('Usuario no encontrado');

    const filas = await this.vwRepo.find({ where: { id_usuario: idUsuario } });
    const permisos = filas.map((f) => f.permiso);
    const rol = this.normalizeRoleName(usuario.rol?.nombre ?? 'cliente');

    return {
      id_usuario: usuario.id_usuario,
      nombre: usuario.nombre,
      email: usuario.email,
      rol: { idRol: usuario.rol?.id_rol ?? null, nombre: rol },
      permisos,
    };
  }

  async actualizarPerfil(idUsuario: number, dto: ActualizarPerfilRequest, res: any) {
    const usuario = await this.usuarioRepo.findOne({
      where: { id_usuario: idUsuario, estado: true },
      relations: ['rol'],
    });
    if (!usuario) throw new NotFoundException('Usuario no encontrado');

    if (dto.nombre?.trim()) {
      usuario.nombre = dto.nombre.trim();
    }

    if (dto.email?.trim()) {
      const email = dto.email.trim().toLowerCase();
      if (email !== usuario.email?.toLowerCase()) {
        const existe = await this.usuarioRepo.findOne({ where: { email } });
        if (existe && existe.id_usuario !== idUsuario) {
          throw new ConflictException('Ese correo ya está en uso');
        }
        usuario.email = email;
      }
    }

    if (dto.password_nueva) {
      if (!dto.password_actual) {
        throw new BadRequestException('Indique la contraseña actual para cambiarla');
      }
      if (!usuario.password) {
        throw new BadRequestException('Esta cuenta usa Google; no tiene contraseña local');
      }
      const ok = await HashUtil.comparePassword(dto.password_actual, usuario.password);
      if (!ok) throw new UnauthorizedException('La contraseña actual no es correcta');
      usuario.password = await HashUtil.hashPassword(dto.password_nueva);
    }

    await this.usuarioRepo.save(usuario);

    const cliente = await this.clienteRepo.findOne({
      where: { usuario: { id_usuario: idUsuario } as any },
    });
    if (cliente) {
      if (dto.nombre?.trim()) cliente.nombre = dto.nombre.trim();
      if (dto.email?.trim()) cliente.email = dto.email.trim().toLowerCase();
      await this.clienteRepo.save(cliente);
    }

    return this.emitirSesion(usuario, res, 'Perfil actualizado');
  }
}

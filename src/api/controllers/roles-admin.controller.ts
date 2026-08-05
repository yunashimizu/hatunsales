import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  InternalServerErrorException,
  Param,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { JwtGuard } from 'src/guards/jwt.guard';
import { RolesGuard } from 'src/guards/roles.guard';
import { Roles } from 'src/guards/roles.decorator';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Rol } from 'src/models/DBModel/role.entity';
import { Usuarios } from 'src/models/DBModel/usuarios.entity';
import { HashUtil } from 'src/util/jwt/hash.util';
import { esRolCliente } from 'src/config/roles.config';

@Controller('admin/roles')
@UseGuards(JwtGuard, RolesGuard)
@Roles('admin')
export class RolesAdminController {
  constructor(
    @InjectRepository(Rol, 'pgConnection')
    private readonly rolRepo: Repository<Rol>,

    @InjectRepository(Usuarios, 'pgConnection')
    private readonly usuarioRepo: Repository<Usuarios>,
  ) {}

  @Get()
  async listarRoles() {
    const roles = await this.rolRepo.find({ order: { id_rol: 'ASC' } });
    return roles.map((rol) => ({ id_rol: rol.id_rol, nombre: rol.nombre }));
  }

  @Get('usuarios')
  async listarUsuarios() {
    const usuarios = await this.usuarioRepo.find({
      relations: ['rol'],
      order: { id_usuario: 'DESC' },
    });

    return usuarios
      .filter((usuario) => !esRolCliente(usuario.rol?.id_rol, usuario.rol?.nombre))
      .map((usuario) => ({
        id_usuario: usuario.id_usuario,
        nombre: usuario.nombre,
        email: usuario.email,
        id_rol: usuario.rol?.id_rol ?? null,
        rol: usuario.rol?.nombre ?? 'sin rol',
        estado: usuario.estado,
      }));
  }

  @Post('usuarios')
  async crearUsuario(
    @Body() body: { nombre?: string; email?: string; password?: string; id_rol?: number },
  ) {
    const nombre = (body?.nombre ?? '').trim();
    const email = (body?.email ?? '').trim().toLowerCase();
    const password = body?.password ?? '';
    const idRol = Number(body?.id_rol);

    if (!nombre || !email || !password) {
      throw new BadRequestException('Nombre, correo y contraseña son obligatorios');
    }
    if (!Number.isFinite(idRol) || idRol <= 0) {
      throw new BadRequestException('Seleccione un rol válido');
    }
    if (idRol === 5) {
      throw new BadRequestException('Para clientes use el registro de la tienda');
    }

    const existe = await this.usuarioRepo.findOne({ where: { email } });
    if (existe) throw new ConflictException('El email ya está registrado');

    const rol = await this.rolRepo.findOne({ where: { id_rol: idRol } });
    if (!rol) throw new BadRequestException(`El rol #${idRol} no existe`);

    try {
      const hashedPassword = await HashUtil.hashPassword(password);

      // Insert por SQL parametrizado: evita fallos de TypeORM con la relación parcial.
      const filas: Array<{ id_usuario: number }> = await this.usuarioRepo.query(
        `INSERT INTO usuarios (nombre, email, password, estado, id_rol)
         VALUES ($1, $2, $3, true, $4)
         RETURNING id_usuario`,
        [nombre, email, hashedPassword, rol.id_rol],
      );

      const idUsuario = Number(filas?.[0]?.id_usuario);
      if (!idUsuario) {
        throw new InternalServerErrorException('No se obtuvo el id del usuario creado');
      }

      return {
        success: true,
        id_usuario: idUsuario,
        rol: rol.nombre,
      };
    } catch (error: any) {
      if (error instanceof BadRequestException || error instanceof ConflictException) {
        throw error;
      }
      const code = error?.code ?? error?.driverError?.code;
      if (code === '23505') {
        throw new ConflictException('El email ya está registrado');
      }
      if (code === '23503') {
        throw new BadRequestException('Rol inválido para este usuario');
      }

      // Fallback al save de TypeORM (mismo patrón que auth/register).
      try {
        const hashedPassword = await HashUtil.hashPassword(password);
        const creado = await this.usuarioRepo.save(
          this.usuarioRepo.create({
            nombre,
            email,
            password: hashedPassword,
            estado: true,
            rol: { id_rol: rol.id_rol } as Rol,
          }),
        );
        return { success: true, id_usuario: creado.id_usuario, rol: rol.nombre };
      } catch (fallbackError: any) {
        const msg =
          fallbackError?.driverError?.detail ||
          fallbackError?.message ||
          error?.message ||
          'Error al crear usuario';
        throw new InternalServerErrorException(msg);
      }
    }
  }

  @Put('usuarios/:id/rol')
  async cambiarRol(@Param('id') id: string, @Body() body: { id_rol: number }) {
    const idUsuario = Number(id);
    const idRol = Number(body?.id_rol);

    const usuario = await this.usuarioRepo.findOne({
      where: { id_usuario: idUsuario },
      relations: ['rol'],
    });
    if (!usuario) throw new BadRequestException('Usuario no encontrado');

    const rol = await this.rolRepo.findOne({ where: { id_rol: idRol } });
    if (!rol) throw new BadRequestException('Rol no encontrado');
    if (idRol === 5) {
      throw new BadRequestException('No asigne rol cliente desde el panel de usuarios');
    }

    await this.usuarioRepo
      .createQueryBuilder()
      .update(Usuarios)
      .set({ rol: { id_rol: rol.id_rol } as Rol })
      .where('id_usuario = :id', { id: idUsuario })
      .execute();

    return { success: true, id_usuario: idUsuario, rol: rol.nombre };
  }
}

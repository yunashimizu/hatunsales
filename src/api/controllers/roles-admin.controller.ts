import { Body, Controller, Get, Param, Post, Put, UseGuards } from '@nestjs/common';
import { JwtGuard } from 'src/guards/jwt.guard';
import { RolesGuard } from 'src/guards/roles.guard';
import { Roles } from 'src/guards/roles.decorator';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Rol } from 'src/models/DBModel/role.entity';
import { Usuarios } from 'src/models/DBModel/usuarios.entity';
import { HashUtil } from 'src/util/jwt/hash.util';

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
      order: { id_usuario: 'ASC' },
    });

    return usuarios.map((usuario) => ({
      id_usuario: usuario.id_usuario,
      nombre: usuario.nombre,
      email: usuario.email,
      rol: usuario.rol?.nombre ?? 'sin rol',
      estado: usuario.estado,
    }));
  }

  @Post('usuarios')
  async crearUsuario(@Body() body: { nombre: string; email: string; password: string; id_rol: number }) {
    const existe = await this.usuarioRepo.findOne({ where: { email: body.email } });
    if (existe) return { success: false, message: 'El email ya está registrado' };

    const hashedPassword = await HashUtil.hashPassword(body.password);
    const rol = await this.rolRepo.findOne({ where: { id_rol: body.id_rol } });

    const creado = await this.usuarioRepo.save(this.usuarioRepo.create({
      nombre: body.nombre,
      email: body.email,
      password: hashedPassword,
      estado: true,
      rol: rol ? ({ id_rol: rol.id_rol } as Rol) : ({ id_rol: body.id_rol } as Rol),
    }));

    return { success: true, id_usuario: creado.id_usuario, rol: rol?.nombre ?? body.id_rol };
  }

  @Put('usuarios/:id/rol')
  async cambiarRol(@Param('id') id: string, @Body() body: { id_rol: number }) {
    const usuario = await this.usuarioRepo.findOne({ where: { id_usuario: Number(id) }, relations: ['rol'] });
    if (!usuario) return { success: false, message: 'Usuario no encontrado' };

    const rol = await this.rolRepo.findOne({ where: { id_rol: body.id_rol } });
    if (!rol) return { success: false, message: 'Rol no encontrado' };

    await this.usuarioRepo.update(Number(id), { rol: { id_rol: rol.id_rol } as Rol });
    return { success: true, id_usuario: Number(id), rol: rol.nombre };
  }
}

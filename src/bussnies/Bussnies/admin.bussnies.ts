import { Injectable, ConflictException, NotFoundException, ForbiddenException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Usuarios } from 'src/models/DBModel/usuarios.entity';
import { VwUsuarioPermisos } from 'src/models/DBModel/vw-usuario-permisos.entity';
import { HashUtil } from 'src/util/jwt/hash.util';
import { CrearEmpleadoRequest } from 'src/models/model/new/crear-empleado.request';
import { CambiarRolRequest } from 'src/models/model/new/cambiar-rol.request';
import { EliminarUsuarioRequest } from 'src/models/model/new/eliminar-usuario.request';

@Injectable()
export class AdminBussnies {

  constructor(
    @InjectRepository(Usuarios, 'pgConnection')
    private readonly usuarioRepo: Repository<Usuarios>,

    @InjectRepository(VwUsuarioPermisos, 'pgConnection')
    private readonly vwRepo: Repository<VwUsuarioPermisos>,
  ) {}

  async listarTodos(): Promise<any[]> {
    const usuarios = await this.usuarioRepo.find({
      relations: ['rol'],
      order: { id_usuario: 'ASC' },
    });

    return usuarios.map((u) => ({
      id_usuario: u.id_usuario,
      nombre: u.nombre,
      email: u.email,
      rol: u.rol?.nombre ?? 'sin rol',
      estado: u.estado,
    }));
  }

  async crearEmpleado(dto: CrearEmpleadoRequest): Promise<any> {
    if (dto.id_rol === 2) {
      throw new ForbiddenException('Para clientes usa /auth/register');
    }

    const existe = await this.usuarioRepo.findOne({
      where: { email: dto.email },
    });

    if (existe) throw new ConflictException('El email ya está registrado');

    const hashedPassword = await HashUtil.hashPassword(dto.password);

    const nuevoEmpleado = this.usuarioRepo.create({
      nombre: dto.nombre,
      email: dto.email,
      password: hashedPassword,
      estado: dto.estado ?? true,
      rol: { id_rol: dto.id_rol },
    });

    const guardado = await this.usuarioRepo.save(nuevoEmpleado);

    const filaVw = await this.vwRepo.findOne({
      where: { id_usuario: guardado.id_usuario },
    });

    return {
      id_usuario: guardado.id_usuario,
      nombre: guardado.nombre,
      email: guardado.email,
      rol: filaVw?.rol ?? 'desconocido',
      estado: guardado.estado,
      mensaje: 'Empleado creado correctamente',
    };
  }

  async cambiarRol(dto: CambiarRolRequest): Promise<any> {
    if (!dto.id_usuario && !dto.email) {
      throw new ConflictException('Debes enviar id_usuario o email');
    }

    const usuario = await this.usuarioRepo.findOne({
      where: dto.id_usuario
        ? { id_usuario: dto.id_usuario }
        : { email: dto.email },
      relations: ['rol'],
    });

    if (!usuario) throw new NotFoundException('Usuario no encontrado');

    const rolAnterior = usuario.rol?.nombre ?? 'sin rol';

    await this.usuarioRepo.update(usuario.id_usuario, {
      rol: { id_rol: dto.id_rol },
    });

    return {
      id_usuario: usuario.id_usuario,
      nombre: usuario.nombre,
      email: usuario.email,
      rol_anterior: rolAnterior,
      id_rol_nuevo: dto.id_rol,
      mensaje: 'Rol actualizado correctamente',
    };
  }

  async eliminarUsuario(dto: EliminarUsuarioRequest): Promise<any> {
    if (!dto.id_usuario && !dto.email) {
      throw new ConflictException('Debes enviar id_usuario o email');
    }

    const usuario = await this.usuarioRepo.findOne({
      where: dto.id_usuario
        ? { id_usuario: dto.id_usuario }
        : { email: dto.email },
      relations: ['rol'],
    });

    if (!usuario) throw new NotFoundException('Usuario no encontrado');

    if (usuario.id_usuario === 1) {
      throw new ForbiddenException('No puedes eliminar al admin principal');
    }

    await this.usuarioRepo.delete(usuario.id_usuario);

    return {
      id_usuario: usuario.id_usuario,
      nombre: usuario.nombre,
      email: usuario.email,
      mensaje: 'Usuario eliminado correctamente',
    };
  }

  async desactivarUsuario(dto: EliminarUsuarioRequest): Promise<any> {
    if (!dto.id_usuario && !dto.email) {
      throw new ConflictException('Debes enviar id_usuario o email');
    }

    const usuario = await this.usuarioRepo.findOne({
      where: dto.id_usuario
        ? { id_usuario: dto.id_usuario }
        : { email: dto.email },
    });

    if (!usuario) throw new NotFoundException('Usuario no encontrado');

    await this.usuarioRepo.update(usuario.id_usuario, { estado: false });

    return {
      id_usuario: usuario.id_usuario,
      nombre: usuario.nombre,
      mensaje: 'Usuario desactivado correctamente',
    };
  }
}
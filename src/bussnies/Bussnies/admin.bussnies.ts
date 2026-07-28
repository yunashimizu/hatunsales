import { Injectable, ConflictException, NotFoundException, ForbiddenException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Usuarios } from 'src/models/DBModel/usuarios.entity';
import { VwUsuarioPermisos } from 'src/models/DBModel/vw-usuario-permisos.entity';
import { HashUtil } from 'src/util/jwt/hash.util';
import { CrearEmpleadoRequest } from 'src/models/model/new/crear-empleado.request';
import { ActualizarEmpleadoRequest } from 'src/models/model/new/actualizar-empleado.request';
import { CambiarRolRequest } from 'src/models/model/new/cambiar-rol.request';
import { EliminarUsuarioRequest } from 'src/models/model/new/eliminar-usuario.request';
import { Rol } from 'src/models/DBModel/role.entity';

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
      id_rol: u.rol?.id_rol ?? null,
      rol: u.rol?.nombre ?? 'sin rol',
      estado: u.estado,
    }));
  }

  async crearEmpleado(dto: CrearEmpleadoRequest): Promise<any> {
    const email = (dto.email ?? '').trim().toLowerCase();
    const nombre = (dto.nombre ?? '').trim();
    const idRol = Number(dto.id_rol);

    if (!nombre || !email || !dto.password) {
      throw new BadRequestException('Nombre, correo y contraseña son obligatorios');
    }

    // Clientes se registran en la tienda; aquí solo personal / roles internos.
    if (idRol === 5) {
      throw new ForbiddenException('Para clientes usa el registro de la tienda');
    }

    const existe = await this.usuarioRepo.findOne({
      where: { email },
    });

    if (existe) {
      throw new ConflictException('El email ya está registrado. Usa otro correo.');
    }

    const hashedPassword = await HashUtil.hashPassword(dto.password);

    const nuevoEmpleado = this.usuarioRepo.create({
      nombre,
      email,
      password: hashedPassword,
      estado: dto.estado ?? true,
      rol: { id_rol: idRol },
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

  async actualizarEmpleado(dto: ActualizarEmpleadoRequest): Promise<any> {
    const idUsuario = Number(dto.id_usuario);
    if (!idUsuario) throw new BadRequestException('id_usuario es obligatorio');

    const usuario = await this.usuarioRepo.findOne({
      where: { id_usuario: idUsuario },
      relations: ['rol'],
    });
    if (!usuario) throw new NotFoundException('Usuario no encontrado');

    const nombre = dto.nombre !== undefined ? dto.nombre.trim() : usuario.nombre;
    const email = dto.email !== undefined ? dto.email.trim().toLowerCase() : usuario.email;
    const idRol = dto.id_rol !== undefined ? Number(dto.id_rol) : usuario.rol?.id_rol;
    const estado = dto.estado !== undefined ? dto.estado : usuario.estado;

    if (!nombre) throw new BadRequestException('El nombre es obligatorio');
    if (!email) throw new BadRequestException('El correo es obligatorio');
    if (idRol === 5) {
      throw new ForbiddenException('Para clientes usa el registro de la tienda');
    }

    if (email !== usuario.email) {
      const existe = await this.usuarioRepo.findOne({ where: { email } });
      if (existe && existe.id_usuario !== idUsuario) {
        throw new ConflictException('El email ya está registrado. Usa otro correo.');
      }
    }

    const passwordNueva = (dto.password ?? '').trim();
    if (passwordNueva && passwordNueva.length < 6) {
      throw new BadRequestException('La contraseña debe tener al menos 6 caracteres');
    }

    const cambios: Partial<Usuarios> = {
      nombre,
      email,
      estado,
    };

    if (passwordNueva) {
      cambios.password = await HashUtil.hashPassword(passwordNueva);
    }

    if (idRol) {
      cambios.rol = { id_rol: idRol } as Rol;
    }

    await this.usuarioRepo.save({
      ...usuario,
      ...cambios,
    });

    const actualizado = await this.usuarioRepo.findOne({
      where: { id_usuario: idUsuario },
      relations: ['rol'],
    });

    return {
      id_usuario: idUsuario,
      nombre: actualizado?.nombre ?? nombre,
      email: actualizado?.email ?? email,
      id_rol: actualizado?.rol?.id_rol ?? idRol,
      rol: actualizado?.rol?.nombre ?? 'sin rol',
      estado: actualizado?.estado ?? estado,
      mensaje: 'Usuario actualizado correctamente',
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
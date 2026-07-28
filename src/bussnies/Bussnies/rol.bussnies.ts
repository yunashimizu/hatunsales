import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Rol } from '../../models/DBModel/role.entity';
import { Usuarios } from '../../models/DBModel/usuarios.entity';
import { ActualizarRolRequest, CrearRolRequest } from '../../models/model/rol.request';
import { ROL_IDS } from '../../config/roles.config';

/** Roles que no se pueden borrar (sostienen auth admin/tienda). */
const ROLES_PROTEGIDOS = new Set<number>([
  ROL_IDS.ADMIN,
  ROL_IDS.VENDEDOR,
  ROL_IDS.CAJA,
  ROL_IDS.CLIENTE,
]);

@Injectable()
export class RolBussnies {

  constructor(
    @InjectRepository(Rol, 'pgConnection')
    private readonly rolRepo: Repository<Rol>,

    @InjectRepository(Usuarios, 'pgConnection')
    private readonly usuarioRepo: Repository<Usuarios>,
  ) {}

  async listar() {
    await this.asegurarRolCliente();
    const roles = await this.rolRepo.find({ order: { id_rol: 'ASC' } });
    return Promise.all(roles.map(async (rol) => {
      const usuarios = await this.usuarioRepo.count({
        where: { rol: { id_rol: rol.id_rol } as any },
      });
      return {
        id_rol: rol.id_rol,
        nombre: rol.nombre,
        usuarios,
        protegido: ROLES_PROTEGIDOS.has(rol.id_rol),
      };
    }));
  }

  async obtener(id: number) {
    const rol = await this.rolRepo.findOne({ where: { id_rol: id } });
    if (!rol) throw new NotFoundException(`Rol ${id} no encontrado`);
    const usuarios = await this.usuarioRepo.count({
      where: { rol: { id_rol: id } as any },
    });
    return {
      id_rol: rol.id_rol,
      nombre: rol.nombre,
      usuarios,
      protegido: ROLES_PROTEGIDOS.has(rol.id_rol),
    };
  }

  async crear(dto: CrearRolRequest) {
    const nombre = this.normalizarNombre(dto.nombre);
    await this.asegurarNombreLibre(nombre);

    const guardado = await this.rolRepo.save(this.rolRepo.create({ nombre }));
    return {
      id_rol: guardado.id_rol,
      nombre: guardado.nombre,
      usuarios: 0,
      protegido: ROLES_PROTEGIDOS.has(guardado.id_rol),
    };
  }

  async actualizar(id: number, dto: ActualizarRolRequest) {
    const rol = await this.rolRepo.findOne({ where: { id_rol: id } });
    if (!rol) throw new NotFoundException(`Rol ${id} no encontrado`);

    if (dto.nombre?.trim()) {
      const nombre = this.normalizarNombre(dto.nombre);
      if (nombre !== rol.nombre.toLowerCase()) {
        await this.asegurarNombreLibre(nombre, id);
      }
      rol.nombre = nombre;
    }

    const guardado = await this.rolRepo.save(rol);
    const usuarios = await this.usuarioRepo.count({
      where: { rol: { id_rol: id } as any },
    });

    return {
      id_rol: guardado.id_rol,
      nombre: guardado.nombre,
      usuarios,
      protegido: ROLES_PROTEGIDOS.has(guardado.id_rol),
    };
  }

  async eliminar(id: number) {
    const rol = await this.rolRepo.findOne({ where: { id_rol: id } });
    if (!rol) throw new NotFoundException(`Rol ${id} no encontrado`);

    if (ROLES_PROTEGIDOS.has(id)) {
      throw new BadRequestException(
        `El rol "${rol.nombre}" (id ${id}) es del sistema y no se puede eliminar`,
      );
    }

    const usuarios = await this.usuarioRepo.count({
      where: { rol: { id_rol: id } as any },
    });
    if (usuarios > 0) {
      throw new BadRequestException(
        `No se puede eliminar: hay ${usuarios} usuario(s) con este rol`,
      );
    }

    await this.rolRepo.delete(id);
    return { deleted: true, id_rol: id };
  }

  /**
   * Garantiza que exista el rol cliente (id 5) para registro de tienda.
   * No pisa otros roles; solo inserta si falta.
   */
  async asegurarRolCliente(): Promise<Rol> {
    const porId = await this.rolRepo.findOne({ where: { id_rol: ROL_IDS.CLIENTE } });
    if (porId) return porId;

    const porNombre = await this.rolRepo.findOne({ where: { nombre: 'cliente' } });
    if (porNombre) return porNombre;

    await this.rolRepo.query(
      `INSERT INTO roles (id_rol, nombre) VALUES ($1, $2)
       ON CONFLICT (id_rol) DO NOTHING`,
      [ROL_IDS.CLIENTE, 'cliente'],
    );

    // Si la PK es serial, sincronizar secuencia por si se insertó id fijo.
    await this.rolRepo.query(
      `SELECT setval(pg_get_serial_sequence('roles', 'id_rol'),
              (SELECT COALESCE(MAX(id_rol), 1) FROM roles))`,
    ).catch(() => undefined);

    const creado = await this.rolRepo.findOne({ where: { id_rol: ROL_IDS.CLIENTE } });
    if (creado) return creado;

    return this.rolRepo.save(this.rolRepo.create({ nombre: 'cliente' }));
  }

  private normalizarNombre(nombre: string): string {
    const limpio = nombre.trim().toLowerCase();
    if (!limpio) throw new BadRequestException('El nombre del rol es obligatorio');
    return limpio;
  }

  private async asegurarNombreLibre(nombre: string, exceptoId?: number) {
    const existente = await this.rolRepo.findOne({ where: { nombre } });
    if (existente && existente.id_rol !== exceptoId) {
      throw new ConflictException(`Ya existe el rol "${nombre}"`);
    }
  }
}

import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Cliente } from '../../../models/DBModel/cliente.entity';
import { DireccionEnvio } from '../../../models/DBModel/tienda/direccion-envio.entity';
import { Favorito } from '../../../models/DBModel/tienda/favorito.entity';
import { Resena } from '../../../models/DBModel/tienda/resena.entity';
import { Producto } from '../../../models/DBModel/producto.entity';

/**
 * Datos que pertenecen a la cuenta del cliente en la tienda:
 * direcciones, favoritos y reseñas.
 */
@Injectable()
export class CuentaTiendaRepository {

  constructor(
    @InjectRepository(Cliente, 'pgConnection')
    private readonly clienteRepo: Repository<Cliente>,

    @InjectRepository(DireccionEnvio, 'pgConnection')
    private readonly direccionRepo: Repository<DireccionEnvio>,

    @InjectRepository(Favorito, 'pgConnection')
    private readonly favoritoRepo: Repository<Favorito>,

    @InjectRepository(Resena, 'pgConnection')
    private readonly resenaRepo: Repository<Resena>,
  ) {}

  // ---------------------------------------------------------------- cliente

  async buscarClientePorUsuario(idUsuario: number): Promise<Cliente | null> {
    return this.clienteRepo.findOne({
      where: { usuario: { id_usuario: idUsuario } },
      relations: ['usuario'],
    });
  }

  async crearClienteParaUsuario(idUsuario: number, nombre: string, email: string): Promise<Cliente> {
    return this.clienteRepo.save(
      this.clienteRepo.create({
        nombre,
        email,
        usuario: { id_usuario: idUsuario } as any,
      }),
    );
  }

  async actualizarCliente(idCliente: number, data: Partial<Cliente>): Promise<void> {
    await this.clienteRepo.update(idCliente, data as any);
  }

  // ------------------------------------------------------------ direcciones

  async listarDirecciones(idCliente: number): Promise<DireccionEnvio[]> {
    return this.direccionRepo.find({
      where: { cliente: { id_cliente: idCliente } },
      order: { es_predeterminada: 'DESC', id_direccion: 'DESC' },
    });
  }

  async obtenerDireccion(idDireccion: number, idCliente: number): Promise<DireccionEnvio | null> {
    return this.direccionRepo.findOne({
      where: { id_direccion: idDireccion, cliente: { id_cliente: idCliente } },
    });
  }

  async guardarDireccion(idCliente: number, data: Partial<DireccionEnvio>): Promise<DireccionEnvio> {
    return this.direccionRepo.save(
      this.direccionRepo.create({ ...data, cliente: { id_cliente: idCliente } as Cliente }),
    );
  }

  async actualizarDireccion(idDireccion: number, data: Partial<DireccionEnvio>): Promise<void> {
    await this.direccionRepo.update(idDireccion, data as any);
  }

  async eliminarDireccion(idDireccion: number): Promise<void> {
    await this.direccionRepo.delete(idDireccion);
  }

  async quitarPredeterminadas(idCliente: number): Promise<void> {
    await this.direccionRepo
      .createQueryBuilder()
      .update()
      .set({ es_predeterminada: false })
      .where('id_cliente = :idCliente', { idCliente })
      .execute();
  }

  // -------------------------------------------------------------- favoritos

  async listarFavoritos(idCliente: number): Promise<any[]> {
    return this.favoritoRepo.manager.query(
      `SELECT c.* FROM favoritos f
       JOIN vw_catalogo c ON c.id_producto = f.id_producto
       WHERE f.id_cliente = $1
       ORDER BY f.id_favorito DESC`,
      [idCliente],
    );
  }

  async listarIdsFavoritos(idCliente: number): Promise<number[]> {
    const rows = await this.favoritoRepo.manager.query(
      'SELECT id_producto FROM favoritos WHERE id_cliente = $1',
      [idCliente],
    );
    return rows.map((r: any) => Number(r.id_producto));
  }

  async buscarFavorito(idCliente: number, idProducto: number): Promise<Favorito | null> {
    return this.favoritoRepo.findOne({
      where: {
        cliente: { id_cliente: idCliente },
        producto: { id_producto: idProducto },
      },
    });
  }

  async agregarFavorito(idCliente: number, idProducto: number): Promise<Favorito> {
    return this.favoritoRepo.save(
      this.favoritoRepo.create({
        cliente: { id_cliente: idCliente } as Cliente,
        producto: { id_producto: idProducto } as Producto,
      }),
    );
  }

  async eliminarFavorito(idFavorito: number): Promise<void> {
    await this.favoritoRepo.delete(idFavorito);
  }

  // ---------------------------------------------------------------- reseñas

  async listarResenas(idProducto: number): Promise<any[]> {
    return this.resenaRepo.manager.query(
      `SELECT r.id_resena, r.calificacion, r.titulo, r.comentario, r.creado_en,
              COALESCE(cl.nombre, 'Cliente') AS autor
       FROM resenas r
       LEFT JOIN clientes cl ON cl.id_cliente = r.id_cliente
       WHERE r.id_producto = $1 AND COALESCE(r.aprobado, TRUE) = TRUE
       ORDER BY r.creado_en DESC`,
      [idProducto],
    );
  }

  async buscarResena(idProducto: number, idCliente: number): Promise<Resena | null> {
    return this.resenaRepo.findOne({
      where: {
        producto: { id_producto: idProducto },
        cliente: { id_cliente: idCliente },
      },
    });
  }

  async guardarResena(idProducto: number, idCliente: number, data: Partial<Resena>): Promise<Resena> {
    return this.resenaRepo.save(
      this.resenaRepo.create({
        ...data,
        producto: { id_producto: idProducto } as Producto,
        cliente: { id_cliente: idCliente } as Cliente,
      }),
    );
  }

  async actualizarResena(idResena: number, data: Partial<Resena>): Promise<void> {
    await this.resenaRepo.update(idResena, data as any);
  }
}

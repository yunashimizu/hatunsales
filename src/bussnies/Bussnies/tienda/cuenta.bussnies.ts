import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { CuentaTiendaRepository } from '../../../repository/Repository/tienda/cuenta.repository';
import { CatalogoRepository } from '../../../repository/Repository/tienda/catalogo.repository';
import { GuardarDireccionRequest, CrearResenaRequest } from '../../../models/model/tienda/cuenta.request';

export interface UsuarioAutenticado {
  id_usuario: number;
  nombre: string;
  email: string;
}

@Injectable()
export class CuentaTiendaBussnies {

  constructor(
    private readonly repo: CuentaTiendaRepository,
    private readonly catalogoRepo: CatalogoRepository,
  ) {}

  /**
   * Todo el módulo de tienda trabaja sobre `clientes`, no sobre `usuarios`.
   * Si alguien se registró antes de que existiera esa relación, se crea aquí.
   */
  async resolverCliente(usuario: UsuarioAutenticado): Promise<number> {
    const existente = await this.repo.buscarClientePorUsuario(usuario.id_usuario);
    if (existente) return existente.id_cliente;

    const creado = await this.repo.crearClienteParaUsuario(
      usuario.id_usuario,
      usuario.nombre,
      usuario.email,
    );
    return creado.id_cliente;
  }

  async perfil(idCliente: number) {
    const direcciones = await this.repo.listarDirecciones(idCliente);
    return { id_cliente: idCliente, direcciones: direcciones.map((d) => this.mapDireccion(d)) };
  }

  // ------------------------------------------------------------ direcciones

  async listarDirecciones(idCliente: number) {
    const lista = await this.repo.listarDirecciones(idCliente);
    return lista.map((d) => this.mapDireccion(d));
  }

  async crearDireccion(idCliente: number, dto: GuardarDireccionRequest) {
    if (dto.es_predeterminada) await this.repo.quitarPredeterminadas(idCliente);

    const existentes = await this.repo.listarDirecciones(idCliente);
    const esPrimera = existentes.length === 0;

    const creada = await this.repo.guardarDireccion(idCliente, {
      ...dto,
      es_predeterminada: dto.es_predeterminada || esPrimera,
    });

    return this.mapDireccion(creada);
  }

  async actualizarDireccion(idCliente: number, idDireccion: number, dto: GuardarDireccionRequest) {
    const direccion = await this.repo.obtenerDireccion(idDireccion, idCliente);
    if (!direccion) throw new NotFoundException('Dirección no encontrada');

    if (dto.es_predeterminada) await this.repo.quitarPredeterminadas(idCliente);

    await this.repo.actualizarDireccion(idDireccion, dto as any);
    const actualizada = await this.repo.obtenerDireccion(idDireccion, idCliente);
    return this.mapDireccion(actualizada!);
  }

  async eliminarDireccion(idCliente: number, idDireccion: number) {
    const direccion = await this.repo.obtenerDireccion(idDireccion, idCliente);
    if (!direccion) throw new NotFoundException('Dirección no encontrada');

    await this.repo.eliminarDireccion(idDireccion);
    return { eliminado: true, id_direccion: idDireccion };
  }

  // -------------------------------------------------------------- favoritos

  async listarFavoritos(idCliente: number) {
    const filas = await this.repo.listarFavoritos(idCliente);
    return filas.map((row) => this.mapProductoFavorito(row));
  }

  async listarIdsFavoritos(idCliente: number) {
    return this.repo.listarIdsFavoritos(idCliente);
  }

  /** Agrega o quita el producto de favoritos y devuelve el estado resultante. */
  async alternarFavorito(idCliente: number, idProducto: number) {
    const producto = await this.catalogoRepo.obtenerPorId(idProducto);
    if (!producto) throw new NotFoundException(`Producto ${idProducto} no encontrado`);

    const existente = await this.repo.buscarFavorito(idCliente, idProducto);

    if (existente) {
      await this.repo.eliminarFavorito(existente.id_favorito);
      return { id_producto: idProducto, favorito: false };
    }

    await this.repo.agregarFavorito(idCliente, idProducto);
    return { id_producto: idProducto, favorito: true };
  }

  // ---------------------------------------------------------------- reseñas

  async listarResenas(idProducto: number) {
    const filas = await this.repo.listarResenas(idProducto);
    return filas.map((r) => ({
      id_resena: Number(r.id_resena),
      calificacion: Number(r.calificacion),
      titulo: r.titulo ?? undefined,
      comentario: r.comentario ?? undefined,
      autor: r.autor ?? 'Cliente',
      fecha: r.creado_en,
    }));
  }

  async guardarResena(idCliente: number, idProducto: number, dto: CrearResenaRequest) {
    const producto = await this.catalogoRepo.obtenerPorId(idProducto);
    if (!producto) throw new NotFoundException(`Producto ${idProducto} no encontrado`);

    if (dto.calificacion < 1 || dto.calificacion > 5) {
      throw new BadRequestException('La calificación debe estar entre 1 y 5');
    }

    const existente = await this.repo.buscarResena(idProducto, idCliente);

    if (existente) {
      await this.repo.actualizarResena(existente.id_resena, dto as any);
      return { actualizado: true, id_resena: existente.id_resena };
    }

    const creada = await this.repo.guardarResena(idProducto, idCliente, dto as any);
    return { actualizado: false, id_resena: creada.id_resena };
  }

  // -------------------------------------------------------------- privados

  private mapDireccion(d: any) {
    return {
      id_direccion: d.id_direccion,
      alias: d.alias ?? undefined,
      destinatario: d.destinatario ?? undefined,
      telefono: d.telefono ?? undefined,
      departamento: d.departamento ?? undefined,
      provincia: d.provincia ?? undefined,
      distrito: d.distrito ?? undefined,
      direccion: d.direccion,
      referencia: d.referencia ?? undefined,
      codigo_postal: d.codigo_postal ?? undefined,
      es_predeterminada: Boolean(d.es_predeterminada),
    };
  }

  private mapProductoFavorito(row: any) {
    const stock = Number(row.stock ?? 0);
    return {
      id_producto: Number(row.id_producto),
      nombre: row.nombre ?? '',
      slug: row.slug ?? undefined,
      precio: Number(row.precio_venta ?? 0),
      precio_final: Number(row.precio_final ?? 0),
      descuento: Number(row.descuento ?? 0),
      marca: row.marca ?? undefined,
      categoria: row.categoria ?? undefined,
      stock,
      disponible: stock > 0,
      rating: Number(row.rating ?? 0),
      total_resenas: Number(row.total_resenas ?? 0),
      imagen: row.imagen_principal ?? null,
    };
  }
}

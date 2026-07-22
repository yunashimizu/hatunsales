import { Injectable, NotFoundException, BadRequestException, ConflictException } from '@nestjs/common';
import { ProductoRepository } from '../../repository/Repository/producto.repository';
import { CrearProductoRequest, ActualizarProductoRequest } from '../../models/model/producto.request';
import { ProductoResponse } from '../../models/model/producto.response';
import { IProductoBussniees } from '../Ibussnies/IProductoBussniees';

@Injectable()
export class ProductoBussnies implements IProductoBussniees {

  constructor(private readonly repo: ProductoRepository) {}

  async getAll(): Promise<ProductoResponse[]> {
    const lista = await this.repo.getAll();
    return lista.map((p) => this.mapProducto(p));
  }

  async getById(id: number): Promise<ProductoResponse> {
    const producto = await this.repo.getById(id);
    if (!producto) throw new NotFoundException(`Producto ${id} no encontrado`);
    return this.mapProducto(producto);
  }

  async create(dto: CrearProductoRequest): Promise<ProductoResponse> {
    if (dto.codigo_barras) {
      const existe = await this.repo.buscarPorCodigoBarras(dto.codigo_barras);
      if (existe) throw new ConflictException('Ya existe un producto con ese código de barras');
    }

    const producto = await this.repo.create({
      nombre: dto.nombre,
      descripcion: dto.descripcion ?? '',
      codigo_barras: dto.codigo_barras ?? '',
      precio_compra: dto.precio_compra ?? 0,
      precio_venta: dto.precio_venta ?? 0,
      unidad_medida: dto.unidad_medida ?? '',
    });

    return this.mapProducto(producto);
  }

  async update(dto: ActualizarProductoRequest, id: number): Promise<ProductoResponse> {
    const existente = await this.repo.getById(id);
    if (!existente) throw new NotFoundException(`Producto ${id} no encontrado`);

    if (dto.codigo_barras) {
      const existe = await this.repo.buscarPorCodigoBarras(dto.codigo_barras);
      if (existe && existe.id_producto !== id) {
        throw new ConflictException('Ese código de barras ya está asociado a otro producto');
      }
    }

    const actualizado = await this.repo.actualizar(id, {
      nombre: dto.nombre,
      descripcion: dto.descripcion,
      codigo_barras: dto.codigo_barras,
      precio_compra: dto.precio_compra,
      precio_venta: dto.precio_venta,
      unidad_medida: dto.unidad_medida,
    });

    return this.mapProducto(actualizado);
  }

  async delete(id: number): Promise<number> {
    await this.getById(id);
    return this.repo.delete(id);
  }

  async buscarPorCodigoBarras(codigo_barras: string): Promise<ProductoResponse> {
    const producto = await this.repo.buscarPorCodigoBarras(codigo_barras);
    if (!producto) throw new NotFoundException(`Código de barras ${codigo_barras} no encontrado`);
    return this.mapProducto(producto);
  }

  private mapProducto(p: any): ProductoResponse {
    return {
      id_producto: p.id_producto,
      nombre: p.nombre ?? '',
      descripcion: p.descripcion ?? '',
      codigo_barras: p.codigo_barras ?? '',
      precio_compra: Number(p.precio_compra ?? 0),
      precio_venta: Number(p.precio_venta ?? 0),
      unidad_medida: p.unidad_medida ?? '',
      id_proveedor: undefined,
      creado_en: p.creado_en,
    };
  }
}

import { Injectable, NotFoundException } from '@nestjs/common';
import { InventarioRepository } from '../../repository/Repository/inventario.repository';
import { ProductoRepository } from '../../repository/Repository/producto.repository';
import { ActualizarInventarioRequest } from '../../models/model/inventario.request';
import { InventarioResponse } from '../../models/model/inventario.response';
import { IInventarioBussniees } from '../Ibussnies/IInventarioBussniees';

@Injectable()
export class InventarioBussnies implements IInventarioBussniees {

  constructor(
    private readonly repo: InventarioRepository,
    private readonly productoRepo: ProductoRepository,
  ) {}

  async getAll(): Promise<InventarioResponse[]> {
    const lista = await this.repo.listarTodos();
    return lista.map((i) => this.mapInventario(i));
  }

  async getByProducto(id_producto: number): Promise<InventarioResponse> {
    const inventario = await this.repo.buscarPorProducto(id_producto);
    if (!inventario) throw new NotFoundException(`Inventario para producto ${id_producto} no encontrado`);
    return this.mapInventario(inventario);
  }

  async update(dto: ActualizarInventarioRequest): Promise<InventarioResponse> {
    const producto = await this.productoRepo.getById(dto.id_producto);
    if (!producto) throw new NotFoundException(`Producto ${dto.id_producto} no encontrado`);

    const inventario = await this.repo.guardarOActualizar({
      producto: { id_producto: dto.id_producto } as any,
      stock: dto.stock ?? 0,
      stock_minimo: dto.stock_minimo ?? 0,
    });

    return this.mapInventario(inventario);
  }

  private mapInventario(i: any): InventarioResponse {
    return {
      id_inventario: i.id_inventario,
      id_producto: i.producto?.id_producto,
      stock: i.stock,
      stock_minimo: i.stock_minimo,
      creado_en: i.creado_en,
    };
  }
}

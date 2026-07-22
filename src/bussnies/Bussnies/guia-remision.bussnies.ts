import { Injectable, NotFoundException } from '@nestjs/common';
import { GuiaRemisionRepository } from '../../repository/Repository/guia-remision.repository';
import { CrearGuiaRemisionRequest } from '../../models/model/guia-remision.request';
import { GuiaRemisionResponse } from '../../models/model/guia-remision.response';
import { IGuiaRemisionBussniees } from '../Ibussnies/IGuiaRemisionBussniees';
import { ProductoRepository } from '../../repository/Repository/producto.repository';

@Injectable()
export class GuiaRemisionBussnies implements IGuiaRemisionBussniees {

  constructor(
    private readonly repo: GuiaRemisionRepository,
    private readonly productoRepo: ProductoRepository,
  ) {}

  async getAll(): Promise<GuiaRemisionResponse[]> {
    const lista = await this.repo.getAll();
    return lista.map((g) => this.mapGuia(g));
  }

  async create(dto: CrearGuiaRemisionRequest): Promise<GuiaRemisionResponse> {
    for (const item of dto.items) {
      const producto = await this.productoRepo.getById(item.id_producto);
      if (!producto) throw new NotFoundException(`Producto ${item.id_producto} no encontrado`);
    }

    const guia = await this.repo.guardarConItems({
      empresa: { id_empresa: dto.id_empresa } as any,
      cliente: { id_cliente: dto.id_cliente } as any,
      direccion_origen: dto.direccion_origen,
      direccion_destino: dto.direccion_destino,
      motivo_traslado: dto.motivo_traslado,
      peso_total: dto.peso_total,
      items: dto.items.map((item) => {
        const newItem: any = {
          producto: { id_producto: item.id_producto } as any,
          cantidad: item.cantidad,
          unidad_medida: item.unidad_medida,
        };
        return newItem;
      }),
    });

    return this.mapGuia(guia);
  }

  private mapGuia(g: any): GuiaRemisionResponse {
    return {
      id_guia: g.id_guia,
      id_empresa: g.empresa?.id_empresa,
      id_cliente: g.cliente?.id_cliente,
      direccion_origen: g.direccion_origen,
      direccion_destino: g.direccion_destino,
      motivo_traslado: g.motivo_traslado,
      peso_total: g.peso_total,
      items: g.items?.map((item: any) => ({
        id_producto: item.producto?.id_producto,
        cantidad: item.cantidad,
        unidad_medida: item.unidad_medida,
      })) ?? [],
      creado_en: g.creado_en,
    };
  }
}

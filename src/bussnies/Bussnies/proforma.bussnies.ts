import { Injectable, NotFoundException } from '@nestjs/common';
import { ProformaRepository } from '../../repository/Repository/proforma.repository';
import { CrearProformaRequest } from '../../models/model/proforma.request';
import { ProformaResponse } from '../../models/model/proforma.response';
import { IProformaBussniees } from '../Ibussnies/IProformaBussniees';
import { ProductoRepository } from '../../repository/Repository/producto.repository';

@Injectable()
export class ProformaBussnies implements IProformaBussniees {

  constructor(
    private readonly repo: ProformaRepository,
    private readonly productoRepo: ProductoRepository,
  ) {}

  async getAll(): Promise<ProformaResponse[]> {
    const lista = await this.repo.getAll();
    return lista.map((p) => this.mapProforma(p));
  }

  async create(dto: CrearProformaRequest): Promise<ProformaResponse> {
    for (const item of dto.items) {
      const producto = await this.productoRepo.getById(item.id_producto);
      if (!producto) throw new NotFoundException(`Producto ${item.id_producto} no encontrado`);
    }

    const proforma = await this.repo.guardarConItems({
      empresa: { id_empresa: dto.id_empresa } as any,
      cliente: { id_cliente: dto.id_cliente } as any,
      serie: dto.serie,
      numero: dto.numero,
      total_gravada: dto.total_gravada,
      total_igv: dto.total_igv,
      total: dto.total,
      items: dto.items.map((item) => {
        const newItem: any = {
          producto: { id_producto: item.id_producto } as any,
          cantidad: item.cantidad,
          precio_unitario: item.precio_unitario,
          subtotal: item.cantidad * item.precio_unitario,
        };
        return newItem;
      }),
    });

    return this.mapProforma(proforma);
  }

  private mapProforma(p: any): ProformaResponse {
    return {
      id_proforma: p.id_proforma,
      id_empresa: p.empresa?.id_empresa,
      id_cliente: p.cliente?.id_cliente,
      serie: p.serie,
      numero: p.numero,
      total_gravada: Number(p.total_gravada ?? 0),
      total_igv: Number(p.total_igv ?? 0),
      total: Number(p.total ?? 0),
      items: p.items?.map((item: any) => ({
        id_producto: item.producto?.id_producto,
        cantidad: item.cantidad,
        precio_unitario: Number(item.precio_unitario ?? 0),
      })) ?? [],
      creado_en: p.creado_en,
    };
  }
}

import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InventarioRepository, FiltroInventario } from '../../repository/Repository/inventario.repository';
import { ProductoRepository } from '../../repository/Repository/producto.repository';
import {
  ActualizarInventarioRequest,
  AjustarStockRequest,
  TransferirStockRequest,
} from '../../models/model/inventario.request';
import { InventarioResponse } from '../../models/model/inventario.response';
import { IInventarioBussniees } from '../Ibussnies/IInventarioBussniees';

const ETIQUETA_MOTIVO: Record<string, string> = {
  compra: 'Ingreso por compra',
  devolucion: 'Devolución de cliente',
  merma: 'Merma o producto dañado',
  robo: 'Faltante o robo',
  correccion: 'Corrección de registro',
  conteo_fisico: 'Ajuste por conteo físico',
  otro: 'Ajuste manual',
};

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
    if (!inventario) throw new NotFoundException(`El producto ${id_producto} no tiene inventario registrado`);
    return this.mapInventario(inventario);
  }

  /**
   * Atajo legacy: no permite fijar stock a ciegas (sin kardex).
   * Use POST /inventario/ajuste o PUT .../stock-minimo.
   */
  async update(_dto: ActualizarInventarioRequest): Promise<InventarioResponse> {
    throw new BadRequestException(
      'Para cambiar existencias use Ajuste o Transferencia (quedan en el kardex). ' +
        'El stock mínimo se edita desde el panel de Inventario.',
    );
  }

  // ── Panel de inventario ──────────────────────────────────────

  listar(filtro: FiltroInventario) {
    return this.repo.listarDetallado(filtro);
  }

  resumen() {
    return this.repo.resumen();
  }

  almacenes() {
    return this.repo.almacenes();
  }

  alertas() {
    return this.repo.listarDetallado({ solo_alertas: true, por_pagina: 200 });
  }

  movimientos(idProducto?: number, limite?: number) {
    return this.repo.movimientos(idProducto, limite);
  }

  /** Corrige el stock dejando escrito el motivo en el kardex. */
  async ajustar(dto: AjustarStockRequest) {
    if (!dto.cantidad) throw new BadRequestException('Indique cuántas unidades ingresan o salen');

    const producto = await this.productoRepo.getById(dto.id_producto);
    if (!producto) throw new NotFoundException(`Producto ${dto.id_producto} no encontrado`);

    const descripcion = [ETIQUETA_MOTIVO[dto.motivo] ?? dto.motivo, dto.comentario]
      .filter(Boolean)
      .join(' · ');

    try {
      const stock = await this.repo.ajustar(dto.id_producto, dto.id_almacen, dto.cantidad, descripcion);
      return { id_producto: dto.id_producto, id_almacen: dto.id_almacen, stock };
    } catch (error: any) {
      const mensaje = String(error?.message ?? '');
      if (mensaje.startsWith('STOCK_NEGATIVO:')) {
        const disponible = mensaje.split(':')[1];
        throw new BadRequestException(
          `No se puede retirar esa cantidad: solo hay ${disponible} unidades en ese almacén`,
        );
      }
      throw new BadRequestException(mensaje || 'No se pudo ajustar el stock');
    }
  }

  async transferir(dto: TransferirStockRequest) {
    if (dto.id_almacen_origen === dto.id_almacen_destino) {
      throw new BadRequestException('El almacén de origen y el de destino deben ser distintos');
    }

    const descripcion = ['Transferencia entre almacenes', dto.comentario].filter(Boolean).join(' · ');

    try {
      await this.repo.transferir(
        dto.id_producto,
        dto.id_almacen_origen,
        dto.id_almacen_destino,
        dto.cantidad,
        descripcion,
      );
      return { transferido: true };
    } catch (error: any) {
      const mensaje = String(error?.message ?? '');
      if (mensaje.startsWith('STOCK_INSUFICIENTE:')) {
        throw new BadRequestException(
          `El almacén de origen solo tiene ${mensaje.split(':')[1]} unidades disponibles`,
        );
      }
      throw new BadRequestException(mensaje || 'No se pudo transferir el stock');
    }
  }

  async fijarStockMinimo(idInventario: number, minimo: number) {
    if (minimo < 0) throw new BadRequestException('El stock mínimo no puede ser negativo');
    await this.repo.fijarStockMinimo(idInventario, minimo);
    return { id_inventario: idInventario, stock_minimo: minimo };
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

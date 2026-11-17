import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { StockSucursalRepository } from '../../repository/Repository/stock-sucursal.repository';
import { ProductoRepository } from '../../repository/Repository/producto.repository';
import { SucursalRepository } from '../../repository/Repository/sucursal.repository';
import { MovimientoInventarioRepository } from '../../repository/Repository/movimiento-inventario.repository';

export const MENSAJE_ESCRITURA_LEGADA =
  'Use Inventario › Ajuste o Transferencia (quedan en el kardex).';

@Injectable()
export class StockSucursalBussnies {
  constructor(
    private readonly stockRepo: StockSucursalRepository,
    private readonly productoRepo: ProductoRepository,
    private readonly sucursalRepo: SucursalRepository,
    private readonly movimientoRepo: MovimientoInventarioRepository,
  ) {}

  async obtenerStockProductoEnSucursal(id_producto: number, id_sucursal: number) {
    const stock = await this.stockRepo.buscarPorProductoYSucursal(id_producto, id_sucursal);
    if (!stock) throw new NotFoundException('Stock no encontrado');
    return {
      id_producto: stock.producto.id_producto,
      id_sucursal: stock.sucursal.id_sucursal,
      stock: stock.stock,
      stock_comprometido: stock.stock_comprometido,
      actualizado_en: stock.actualizado_en,
    };
  }

  /**
   * Escrituras legadas de `/stock`: tocaban `stock_sucursal` (tabla que el POS no usa)
   * sin transacción ni kardex. El stock real se cambia solo desde Inventario, como
   * `InventarioBussnies.update`. Las lecturas de esta clase siguen igual.
   */
  async actualizarStock(): Promise<never> {
    throw new BadRequestException(MENSAJE_ESCRITURA_LEGADA);
  }

  async transferirStock(): Promise<never> {
    throw new BadRequestException(MENSAJE_ESCRITURA_LEGADA);
  }

  async listarBajoStock(threshold = 10) {
    const todos = await this.stockRepo.listarPorFiltro();
    return todos.filter((s: any) => (s.stock ?? 0) <= threshold).map((s: any) => ({
      id_producto: s.producto?.id_producto,
      nombre_producto: s.producto?.nombre,
      id_sucursal: s.sucursal?.id_sucursal,
      nombre_sucursal: s.sucursal?.nombre,
      stock: s.stock,
      stock_comprometido: s.stock_comprometido,
      stock_minimo: s.producto?.stock_minimo ?? 0,
      alerta: ((s.stock ?? 0) <= (s.producto?.stock_minimo ?? 0) || (s.stock ?? 0) <= threshold),
      actualizado_en: s.actualizado_en,
    }));
  }

  async listarAlertasStockMinimo() {
    const todos = await this.stockRepo.listarPorFiltro();
    return todos.filter((s: any) => (s.stock ?? 0) <= (s.producto?.stock_minimo ?? 0)).map((s: any) => ({
      id_producto: s.producto?.id_producto,
      nombre_producto: s.producto?.nombre,
      id_sucursal: s.sucursal?.id_sucursal,
      nombre_sucursal: s.sucursal?.nombre,
      stock_actual: s.stock,
      stock_minimo: s.producto?.stock_minimo ?? 0,
      diferencia: (s.producto?.stock_minimo ?? 0) - (s.stock ?? 0),
    }));
  }

  async listarStockFiltrado(id_producto?: number, id_sucursal?: number) {
    const items = await this.stockRepo.listarPorFiltro(id_producto, id_sucursal);
    return items.map((s: any) => ({
      id_producto: s.producto?.id_producto,
      nombre_producto: s.producto?.nombre,
      id_sucursal: s.sucursal?.id_sucursal,
      nombre_sucursal: s.sucursal?.nombre,
      stock: s.stock,
      stock_comprometido: s.stock_comprometido,
      stock_disponible: (s.stock ?? 0) - (s.stock_comprometido ?? 0),
      actualizado_en: s.actualizado_en,
    }));
  }

  async listarMovimientos(id_producto?: number, id_sucursal?: number) {
    const items = await this.movimientoRepo.getAll();
    return items
      .filter((m: any) => {
        const matchProducto = !id_producto || m.producto?.id_producto === id_producto;
        const matchSucursal = !id_sucursal || m.sucursal_origen?.id_sucursal === id_sucursal || m.sucursal_destino?.id_sucursal === id_sucursal;
        return matchProducto && matchSucursal;
      })
      .map((m: any) => ({
        id_movimiento: m.id_movimiento,
        tipo: m.tipo,
        cantidad: m.cantidad,
        producto_id: m.producto?.id_producto,
        producto_nombre: m.producto?.nombre,
        sucursal_origen: m.sucursal_origen?.id_sucursal,
        sucursal_destino: m.sucursal_destino?.id_sucursal,
        descripcion: m.descripcion,
        creado_en: m.creado_en,
      }));
  }

  async resumenPorSucursal() {
    const items = await this.stockRepo.listarPorFiltro();
    const grupos = new Map<number, any>();

    for (const item of items) {
      const sucursalId = item.sucursal?.id_sucursal;
      if (!sucursalId) continue;
      const current = grupos.get(sucursalId) || { id_sucursal: sucursalId, nombre_sucursal: item.sucursal?.nombre, total_productos: 0, stock_total: 0, stock_comprometido_total: 0 };
      current.total_productos += 1;
      current.stock_total += item.stock ?? 0;
      current.stock_comprometido_total += item.stock_comprometido ?? 0;
      grupos.set(sucursalId, current);
    }

    return Array.from(grupos.values());
  }
}

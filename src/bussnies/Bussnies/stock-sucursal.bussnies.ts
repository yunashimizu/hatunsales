import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { StockSucursalRepository } from '../../repository/Repository/stock-sucursal.repository';
import { ProductoRepository } from '../../repository/Repository/producto.repository';
import { SucursalRepository } from '../../repository/Repository/sucursal.repository';
import { MovimientoInventarioRepository } from '../../repository/Repository/movimiento-inventario.repository';

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

  async actualizarStock(id_producto: number, id_sucursal: number, cantidad: number) {
    if (cantidad < 0) throw new BadRequestException('El stock no puede ser negativo');

    const producto = await this.productoRepo.getById(id_producto);
    if (!producto) throw new NotFoundException('Producto no encontrado');
    const sucursal = await this.sucursalRepo.getById(id_sucursal);
    if (!sucursal) throw new NotFoundException('Sucursal no encontrada');

    const existente = await this.stockRepo.buscarPorProductoYSucursal(id_producto, id_sucursal);
    if (existente) {
      const anterior = existente.stock ?? 0;
      await this.stockRepo.update(existente.id_stock, { stock: cantidad, stock_comprometido: Math.max(0, existente.stock_comprometido ?? 0) } as any);
      await this.movimientoRepo.create({
        producto: { id_producto } as any,
        tipo: 'ajuste',
        cantidad: Math.abs(cantidad - anterior),
        sucursal_origen: undefined,
        sucursal_destino: { id_sucursal } as any,
        descripcion: `Ajuste de stock a ${cantidad}`,
      } as any);
      return this.obtenerStockProductoEnSucursal(id_producto, id_sucursal);
    }

    const nuevo = await this.stockRepo.create({ producto: { id_producto } as any, sucursal: { id_sucursal } as any, stock: cantidad, stock_comprometido: 0 } as any);
    await this.movimientoRepo.create({
      producto: { id_producto } as any,
      tipo: 'entrada',
      cantidad: cantidad,
      sucursal_destino: { id_sucursal } as any,
      descripcion: 'Creación de stock inicial',
    } as any);
    return {
      id_stock: nuevo.id_stock,
      id_producto: id_producto,
      id_sucursal: id_sucursal,
      stock: nuevo.stock,
      stock_comprometido: nuevo.stock_comprometido,
    };
  }

  async transferirStock(id_producto: number, from_sucursal: number, to_sucursal: number, cantidad: number) {
    if (cantidad <= 0) throw new BadRequestException('La cantidad debe ser mayor a cero');
    if (from_sucursal === to_sucursal) throw new BadRequestException('Sucursales iguales');

    const producto = await this.productoRepo.getById(id_producto);
    if (!producto) throw new NotFoundException('Producto no encontrado');

    const origen = await this.stockRepo.buscarPorProductoYSucursal(id_producto, from_sucursal);
    if (!origen) throw new NotFoundException('Stock de origen no encontrado');
    if ((origen.stock ?? 0) < cantidad) throw new BadRequestException('Stock insuficiente en origen');

    const destino = await this.stockRepo.buscarPorProductoYSucursal(id_producto, to_sucursal);

    await this.stockRepo.update(origen.id_stock, { stock: (origen.stock ?? 0) - cantidad } as any);

    if (destino) {
      await this.stockRepo.update(destino.id_stock, { stock: (destino.stock ?? 0) + cantidad } as any);
    } else {
      await this.stockRepo.create({ producto: { id_producto } as any, sucursal: { id_sucursal: to_sucursal } as any, stock: cantidad, stock_comprometido: 0 } as any);
    }

    await this.movimientoRepo.create({
      producto: { id_producto } as any,
      tipo: 'transferencia',
      cantidad,
      sucursal_origen: { id_sucursal: from_sucursal } as any,
      sucursal_destino: { id_sucursal: to_sucursal } as any,
      descripcion: 'Transferencia entre sucursales',
    } as any);

    return {
      success: true,
      id_producto,
      from_sucursal,
      to_sucursal,
      cantidad,
      stock_origen: (origen.stock ?? 0) - cantidad,
      stock_destino: (destino?.stock ?? 0) + cantidad,
    };
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

import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, IsNull, Repository } from 'typeorm';
import { Carrito } from '../../../models/DBModel/tienda/carrito.entity';
import { CarritoItem } from '../../../models/DBModel/tienda/carrito-item.entity';
import { Cliente } from '../../../models/DBModel/cliente.entity';
import { Producto } from '../../../models/DBModel/producto.entity';

@Injectable()
export class CarritoRepository {

  constructor(
    @InjectRepository(Carrito, 'pgConnection')
    private readonly carritoRepo: Repository<Carrito>,

    @InjectRepository(CarritoItem, 'pgConnection')
    private readonly itemRepo: Repository<CarritoItem>,
  ) {}

  async buscarPorCliente(idCliente: number): Promise<Carrito | null> {
    return this.carritoRepo.findOne({
      where: { cliente: { id_cliente: idCliente }, estado: 'activo' },
      relations: ['cliente'],
    });
  }

  async buscarPorToken(token: string): Promise<Carrito | null> {
    return this.carritoRepo.findOne({
      where: { token_invitado: token, estado: 'activo', cliente: IsNull() },
    });
  }

  async crearParaCliente(idCliente: number): Promise<Carrito> {
    return this.carritoRepo.save(
      this.carritoRepo.create({
        cliente: { id_cliente: idCliente } as Cliente,
        estado: 'activo',
        actualizado_en: new Date(),
      }),
    );
  }

  async crearParaInvitado(token: string): Promise<Carrito> {
    return this.carritoRepo.save(
      this.carritoRepo.create({
        token_invitado: token,
        estado: 'activo',
        actualizado_en: new Date(),
      }),
    );
  }

  async marcarConvertido(idCarrito: number, manager?: EntityManager): Promise<void> {
    const repo = manager ? manager.getRepository(Carrito) : this.carritoRepo;
    await repo.update(idCarrito, { estado: 'convertido', actualizado_en: new Date() });
  }

  async tocar(idCarrito: number): Promise<void> {
    await this.carritoRepo.update(idCarrito, { actualizado_en: new Date() });
  }

  async asignarCliente(idCarrito: number, idCliente: number): Promise<void> {
    await this.carritoRepo.update(idCarrito, {
      cliente: { id_cliente: idCliente } as Cliente,
      token_invitado: null as any,
      actualizado_en: new Date(),
    });
  }

  /** Devuelve las líneas del carrito ya enriquecidas con datos del producto y su stock. */
  async listarItems(idCarrito: number): Promise<any[]> {
    const politica = await this.politicaStockWeb();

    // Fase 6: en exclusivo mostramos solo el stock del almacén de despacho web.
    if (politica.exclusivo && politica.idAlmacen) {
      return this.carritoRepo.manager.query(
        `SELECT ci.id_item,
                ci.cantidad,
                ci.precio_unitario,
                p.id_producto,
                p.nombre,
                m.nombre AS marca,
                COALESCE(i.stock, 0)::INTEGER AS stock_disponible,
                (
                  SELECT pi.url FROM productos_imagenes pi
                  WHERE pi.id_producto = p.id_producto
                  ORDER BY pi.is_primary DESC NULLS LAST, COALESCE(pi.orden, 0) ASC, pi.id_imagen ASC
                  LIMIT 1
                ) AS imagen
         FROM carrito_items ci
         JOIN productos p ON p.id_producto = ci.id_producto
         LEFT JOIN marcas m ON m.id_marca = p.id_marca
         LEFT JOIN inventario i ON i.id_producto = p.id_producto AND i.id_almacen = $2
         WHERE ci.id_carrito = $1
         ORDER BY ci.id_item ASC`,
        [idCarrito, politica.idAlmacen],
      );
    }

    return this.carritoRepo.manager.query(
      `SELECT ci.id_item,
              ci.cantidad,
              ci.precio_unitario,
              p.id_producto,
              p.nombre,
              m.nombre AS marca,
              COALESCE(st.stock_total, 0)::INTEGER AS stock_disponible,
              (
                SELECT pi.url FROM productos_imagenes pi
                WHERE pi.id_producto = p.id_producto
                ORDER BY pi.is_primary DESC NULLS LAST, COALESCE(pi.orden, 0) ASC, pi.id_imagen ASC
                LIMIT 1
              ) AS imagen
       FROM carrito_items ci
       JOIN productos p ON p.id_producto = ci.id_producto
       LEFT JOIN marcas m ON m.id_marca = p.id_marca
       LEFT JOIN vw_producto_stock st ON st.id_producto = p.id_producto
       WHERE ci.id_carrito = $1
       ORDER BY ci.id_item ASC`,
      [idCarrito],
    );
  }

  /** Misma política que la reserva de pedidos (Fase 6 / D2). */
  private async politicaStockWeb(): Promise<{
    exclusivo: boolean;
    idAlmacen?: number;
  }> {
    const filas = await this.carritoRepo.manager.query(
      `SELECT clave, valor FROM configuraciones
        WHERE clave IN ('tienda_stock_modo', 'tienda_id_almacen')`,
    );
    const mapa = new Map<string, string>();
    for (const f of filas ?? []) {
      if (f.valor !== undefined && f.valor !== null && String(f.valor).trim() !== '') {
        mapa.set(String(f.clave), String(f.valor));
      }
    }
    const modo = (mapa.get('tienda_stock_modo') ?? 'exclusivo').toLowerCase();
    const idAlmacen = Number(mapa.get('tienda_id_almacen'));
    const almacenOk = Number.isFinite(idAlmacen) && idAlmacen > 0 ? idAlmacen : undefined;
    return {
      exclusivo: modo !== 'spillover' && almacenOk != null,
      idAlmacen: almacenOk,
    };
  }

  async buscarItem(idCarrito: number, idProducto: number): Promise<CarritoItem | null> {
    return this.itemRepo.findOne({
      where: {
        carrito: { id_carrito: idCarrito },
        producto: { id_producto: idProducto },
      },
    });
  }

  async buscarItemPorId(idItem: number, idCarrito: number): Promise<CarritoItem | null> {
    return this.itemRepo.findOne({
      where: { id_item: idItem, carrito: { id_carrito: idCarrito } },
    });
  }

  async agregarItem(idCarrito: number, idProducto: number, cantidad: number, precio: number): Promise<CarritoItem> {
    return this.itemRepo.save(
      this.itemRepo.create({
        carrito: { id_carrito: idCarrito } as Carrito,
        producto: { id_producto: idProducto } as Producto,
        cantidad,
        precio_unitario: precio,
      }),
    );
  }

  async actualizarCantidad(idItem: number, cantidad: number): Promise<void> {
    await this.itemRepo.update(idItem, { cantidad });
  }

  async eliminarItem(idItem: number): Promise<void> {
    await this.itemRepo.delete(idItem);
  }

  async vaciar(idCarrito: number, manager?: EntityManager): Promise<void> {
    const repo = manager ? manager.getRepository(CarritoItem) : this.itemRepo;
    await repo.delete({ carrito: { id_carrito: idCarrito } } as any);
  }
}

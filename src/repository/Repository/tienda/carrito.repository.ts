import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
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

  async marcarConvertido(idCarrito: number): Promise<void> {
    await this.carritoRepo.update(idCarrito, { estado: 'convertido', actualizado_en: new Date() });
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

  async vaciar(idCarrito: number): Promise<void> {
    await this.itemRepo.delete({ carrito: { id_carrito: idCarrito } } as any);
  }
}

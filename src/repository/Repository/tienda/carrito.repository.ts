import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, IsNull, Repository } from 'typeorm';
import { Carrito } from '../../../models/DBModel/tienda/carrito.entity';
import { CarritoItem } from '../../../models/DBModel/tienda/carrito-item.entity';
import { Cliente } from '../../../models/DBModel/cliente.entity';
import { Producto } from '../../../models/DBModel/producto.entity';
import { StockTiendaRepository } from './stock-tienda.repository';
import { filasDe } from '../../../caja/bd/resultado-consulta';

/** Precio nuevo de una línea del carrito. */
export interface PrecioActualizado {
  id_item: number;
  precio: number;
}

@Injectable()
export class CarritoRepository {

  constructor(
    @InjectRepository(Carrito, 'pgConnection')
    private readonly carritoRepo: Repository<Carrito>,

    @InjectRepository(CarritoItem, 'pgConnection')
    private readonly itemRepo: Repository<CarritoItem>,

    private readonly stockRepo: StockTiendaRepository,
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

  /**
   * Pasa las líneas del carrito de invitado al del cliente (sumando cantidades si
   * el producto ya estaba) y cierra el de invitado, en una sola transacción: si
   * algo falla no queda nada a medias y el navegador puede reintentar sin
   * duplicar cantidades. Devuelve false si otra pestaña ya lo había fusionado.
   */
  async fusionarEn(idOrigen: number, idDestino: number): Promise<boolean> {
    return this.carritoRepo.manager.transaction(async (manager) => {
      const [origen] = filasDe(await manager.query(
        `UPDATE carritos SET estado = 'convertido', actualizado_en = NOW()
          WHERE id_carrito = $1 AND estado = 'activo'
          RETURNING id_carrito`,
        [idOrigen],
      ));
      if (!origen) return false;

      await manager.query(
        `INSERT INTO carrito_items (id_carrito, id_producto, cantidad, precio_unitario)
         SELECT $2, ci.id_producto, ci.cantidad, ci.precio_unitario
           FROM carrito_items ci
          WHERE ci.id_carrito = $1
         ON CONFLICT (id_carrito, id_producto)
         DO UPDATE SET cantidad = carrito_items.cantidad + EXCLUDED.cantidad`,
        [idOrigen, idDestino],
      );
      await manager.query('UPDATE carritos SET actualizado_en = NOW() WHERE id_carrito = $1', [idDestino]);
      return true;
    });
  }

  /**
   * Líneas del carrito con el precio VIGENTE del catálogo (el mismo `precio_final`
   * de la tienda), si el producto sigue activo y su stock según la política web
   * (en exclusivo, solo el almacén de despacho). `precio_unitario` es el que tenía
   * al agregarse: sirve para avisar si cambió.
   */
  async listarItems(idCarrito: number): Promise<any[]> {
    const politica = await this.stockRepo.politicaStock();
    const almacenWeb = politica.exclusivo && politica.idAlmacen ? politica.idAlmacen : null;

    return this.carritoRepo.manager.query(
      `SELECT ci.id_item,
              ci.cantidad,
              ci.precio_unitario,
              round(p.precio_venta - COALESCE(p.descuento, 0::numeric), 2) AS precio_vigente,
              COALESCE(p.estado, TRUE) AS activo,
              p.id_producto,
              p.nombre,
              m.nombre AS marca,
              COALESCE(st.stock, 0)::INTEGER AS stock_disponible,
              (
                SELECT pi.url FROM productos_imagenes pi
                WHERE pi.id_producto = p.id_producto
                ORDER BY pi.is_primary DESC NULLS LAST, COALESCE(pi.orden, 0) ASC, pi.id_imagen ASC
                LIMIT 1
              ) AS imagen
         FROM carrito_items ci
         JOIN productos p ON p.id_producto = ci.id_producto
         LEFT JOIN marcas m ON m.id_marca = p.id_marca
         LEFT JOIN LATERAL (
           SELECT SUM(i.stock) AS stock
             FROM inventario i
            WHERE i.id_producto = p.id_producto
              AND ($2::integer IS NULL OR i.id_almacen = $2::integer)
         ) st ON TRUE
        WHERE ci.id_carrito = $1
        ORDER BY ci.id_item ASC`,
      [idCarrito, almacenWeb],
    );
  }

  /** Deja guardado el precio vigente para no volver a avisar el mismo cambio. */
  async actualizarPrecios(cambios: PrecioActualizado[]): Promise<void> {
    if (!cambios.length) return;
    await this.itemRepo.manager.query(
      `UPDATE carrito_items ci
          SET precio_unitario = v.precio
         FROM unnest($1::integer[], $2::numeric[]) AS v(id_item, precio)
        WHERE ci.id_item = v.id_item`,
      [cambios.map((c) => c.id_item), cambios.map((c) => c.precio)],
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

  async vaciar(idCarrito: number, manager?: EntityManager): Promise<void> {
    const repo = manager ? manager.getRepository(CarritoItem) : this.itemRepo;
    await repo.delete({ carrito: { id_carrito: idCarrito } } as any);
  }
}

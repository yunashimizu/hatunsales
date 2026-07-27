import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { CarritoRepository } from '../../../repository/Repository/tienda/carrito.repository';
import { CatalogoRepository } from '../../../repository/Repository/tienda/catalogo.repository';
import { CarritoItemResponse, CarritoResponse } from '../../../models/model/tienda/carrito.response';
import { Carrito } from '../../../models/DBModel/tienda/carrito.entity';

/** Los precios de la tienda ya incluyen IGV, así que el impuesto se desagrega del total. */
export const TASA_IGV = 0.18;

export interface ContextoCarrito {
  idCliente?: number;
  tokenInvitado?: string;
}

@Injectable()
export class CarritoBussnies {

  constructor(
    private readonly repo: CarritoRepository,
    private readonly catalogoRepo: CatalogoRepository,
  ) {}

  /** Devuelve el carrito activo del contexto, creándolo si hace falta. */
  async obtenerOCrear(ctx: ContextoCarrito): Promise<Carrito> {
    if (ctx.idCliente) {
      const existente = await this.repo.buscarPorCliente(ctx.idCliente);
      if (existente) return existente;
      return this.repo.crearParaCliente(ctx.idCliente);
    }

    const token = ctx.tokenInvitado?.trim();
    if (token) {
      const existente = await this.repo.buscarPorToken(token);
      if (existente) return existente;
      return this.repo.crearParaInvitado(token);
    }

    return this.repo.crearParaInvitado(randomUUID());
  }

  async ver(ctx: ContextoCarrito): Promise<CarritoResponse> {
    const carrito = await this.obtenerOCrear(ctx);
    return this.armarRespuesta(carrito);
  }

  async agregar(ctx: ContextoCarrito, idProducto: number, cantidad: number): Promise<CarritoResponse> {
    if (cantidad <= 0) throw new BadRequestException('La cantidad debe ser mayor a cero');

    const producto = await this.catalogoRepo.obtenerPorId(idProducto);
    if (!producto) throw new NotFoundException(`Producto ${idProducto} no encontrado`);

    const stock = Number(producto.stock ?? 0);
    const carrito = await this.obtenerOCrear(ctx);
    const existente = await this.repo.buscarItem(carrito.id_carrito, idProducto);
    const cantidadFinal = (existente?.cantidad ?? 0) + cantidad;

    if (stock > 0 && cantidadFinal > stock) {
      throw new BadRequestException(`Solo quedan ${stock} unidades de "${producto.nombre}"`);
    }

    const precio = Number(producto.precio_final ?? producto.precio_venta ?? 0);

    if (existente) {
      await this.repo.actualizarCantidad(existente.id_item, cantidadFinal);
    } else {
      await this.repo.agregarItem(carrito.id_carrito, idProducto, cantidad, precio);
    }

    await this.repo.tocar(carrito.id_carrito);
    return this.armarRespuesta(carrito);
  }

  async actualizarCantidad(ctx: ContextoCarrito, idItem: number, cantidad: number): Promise<CarritoResponse> {
    if (cantidad <= 0) throw new BadRequestException('La cantidad debe ser mayor a cero');

    const carrito = await this.obtenerOCrear(ctx);
    const item = await this.repo.buscarItemPorId(idItem, carrito.id_carrito);
    if (!item) throw new NotFoundException('El producto no está en tu carrito');

    await this.repo.actualizarCantidad(idItem, cantidad);
    await this.repo.tocar(carrito.id_carrito);
    return this.armarRespuesta(carrito);
  }

  async eliminar(ctx: ContextoCarrito, idItem: number): Promise<CarritoResponse> {
    const carrito = await this.obtenerOCrear(ctx);
    const item = await this.repo.buscarItemPorId(idItem, carrito.id_carrito);
    if (!item) throw new NotFoundException('El producto no está en tu carrito');

    await this.repo.eliminarItem(idItem);
    await this.repo.tocar(carrito.id_carrito);
    return this.armarRespuesta(carrito);
  }

  async vaciar(ctx: ContextoCarrito): Promise<CarritoResponse> {
    const carrito = await this.obtenerOCrear(ctx);
    await this.repo.vaciar(carrito.id_carrito);
    return this.armarRespuesta(carrito);
  }

  /**
   * Al iniciar sesión, pasa lo que el visitante había agregado como invitado
   * a su carrito de cliente registrado.
   */
  async fusionar(idCliente: number, tokenInvitado: string): Promise<CarritoResponse> {
    const carritoInvitado = await this.repo.buscarPorToken(tokenInvitado);
    if (!carritoInvitado) return this.ver({ idCliente });

    const carritoCliente = await this.repo.buscarPorCliente(idCliente);

    if (!carritoCliente) {
      await this.repo.asignarCliente(carritoInvitado.id_carrito, idCliente);
      return this.ver({ idCliente });
    }

    const itemsInvitado = await this.repo.listarItems(carritoInvitado.id_carrito);

    for (const item of itemsInvitado) {
      const yaExiste = await this.repo.buscarItem(carritoCliente.id_carrito, Number(item.id_producto));

      if (yaExiste) {
        await this.repo.actualizarCantidad(yaExiste.id_item, yaExiste.cantidad + Number(item.cantidad));
      } else {
        await this.repo.agregarItem(
          carritoCliente.id_carrito,
          Number(item.id_producto),
          Number(item.cantidad),
          Number(item.precio_unitario),
        );
      }
    }

    await this.repo.marcarConvertido(carritoInvitado.id_carrito);
    return this.ver({ idCliente });
  }

  async armarRespuesta(carrito: Carrito): Promise<CarritoResponse> {
    const filas = await this.repo.listarItems(carrito.id_carrito);

    const items: CarritoItemResponse[] = filas.map((fila) => {
      const cantidad = Number(fila.cantidad ?? 0);
      const precio = Number(fila.precio_unitario ?? 0);
      const stock = Number(fila.stock_disponible ?? 0);

      return {
        id_item: Number(fila.id_item),
        id_producto: Number(fila.id_producto),
        nombre: fila.nombre ?? '',
        imagen: fila.imagen ?? null,
        marca: fila.marca ?? undefined,
        cantidad,
        precio_unitario: precio,
        subtotal: this.redondear(precio * cantidad),
        stock_disponible: stock,
        excede_stock: stock > 0 && cantidad > stock,
      };
    });

    const totalConIgv = items.reduce((suma, item) => suma + item.subtotal, 0);
    const { subtotal, igv } = this.desagregarIgv(totalConIgv);

    return {
      id_carrito: carrito.id_carrito,
      token_invitado: carrito.token_invitado ?? undefined,
      items,
      cantidad_items: items.reduce((suma, item) => suma + item.cantidad, 0),
      subtotal,
      igv,
      total: this.redondear(totalConIgv),
    };
  }

  /** Separa el valor de venta y el IGV de un monto que ya incluye impuesto. */
  desagregarIgv(totalConIgv: number): { subtotal: number; igv: number } {
    const subtotal = this.redondear(totalConIgv / (1 + TASA_IGV));
    return { subtotal, igv: this.redondear(totalConIgv - subtotal) };
  }

  redondear(valor: number): number {
    return Math.round((valor + Number.EPSILON) * 100) / 100;
  }
}

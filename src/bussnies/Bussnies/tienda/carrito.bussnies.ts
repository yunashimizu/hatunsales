import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { CarritoRepository, PrecioActualizado } from '../../../repository/Repository/tienda/carrito.repository';
import { CatalogoRepository } from '../../../repository/Repository/tienda/catalogo.repository';
import { CarritoItemResponse, CarritoResponse } from '../../../models/model/tienda/carrito.response';
import { Carrito } from '../../../models/DBModel/tienda/carrito.entity';

/** Los precios de la tienda ya incluyen IGV, así que el impuesto se desagrega del total. */
export const TASA_IGV = 0.18;

/** Largo de `carritos.token_invitado`: un token más largo no puede ser de un carrito. */
const LARGO_MAXIMO_TOKEN = 80;

export interface ContextoCarrito {
  idCliente?: number;
  tokenInvitado?: string;
}

/** Línea del carrito con los avisos de la tienda (campos opcionales de la respuesta). */
export interface CarritoItemTienda extends CarritoItemResponse {
  /** El precio vigente del catálogo difiere del que tenía cuando se agregó. */
  precio_cambio?: boolean;
  precio_anterior?: number;
  /** El producto se retiró del catálogo: hay que quitarlo para poder comprar. */
  no_disponible?: boolean;
}

export interface CarritoTienda extends CarritoResponse {
  items: CarritoItemTienda[];
}

function carritoVacio(): CarritoTienda {
  return { id_carrito: 0, items: [], cantidad_items: 0, subtotal: 0, igv: 0, total: 0 };
}

function centavos(monto: number): number {
  return Math.round(monto * 100);
}

function esViolacionUnica(error: any): boolean {
  return (error?.code ?? error?.driverError?.code) === '23505';
}

@Injectable()
export class CarritoBussnies {

  constructor(
    private readonly repo: CarritoRepository,
    private readonly catalogoRepo: CatalogoRepository,
  ) {}

  /**
   * Carrito activo del contexto, SIN crearlo: null si todavía no existe. Ver el
   * carrito es una lectura; antes cada GET de un visitante nuevo (el header lo
   * pide en cada visita, también los bots) insertaba una fila en `carritos`.
   */
  async buscar(ctx: ContextoCarrito): Promise<Carrito | null> {
    if (ctx.idCliente) return this.repo.buscarPorCliente(ctx.idCliente);

    const token = this.tokenDe(ctx.tokenInvitado);
    return token ? this.repo.buscarPorToken(token) : null;
  }

  async ver(ctx: ContextoCarrito): Promise<CarritoTienda> {
    const carrito = await this.buscar(ctx);
    return carrito ? this.armarRespuesta(carrito) : carritoVacio();
  }

  /** Único punto donde nace un carrito: al agregar el primer producto. */
  async agregar(ctx: ContextoCarrito, idProducto: number, cantidad: number): Promise<CarritoTienda> {
    if (!Number.isInteger(cantidad) || cantidad <= 0) {
      throw new BadRequestException('La cantidad debe ser un número entero mayor a cero');
    }

    const producto = await this.catalogoRepo.obtenerPorId(idProducto);
    if (!producto) throw new NotFoundException(`Producto ${idProducto} no encontrado`);
    if (producto.estado === false) {
      throw new BadRequestException(`"${producto.nombre}" ya no está a la venta`);
    }

    const stock = Number(producto.stock ?? 0);
    if (stock <= 0) throw new BadRequestException(`"${producto.nombre}" está agotado`);

    const previo = await this.buscar(ctx);
    const existente = previo ? await this.repo.buscarItem(previo.id_carrito, idProducto) : null;
    const cantidadFinal = (existente?.cantidad ?? 0) + cantidad;

    if (cantidadFinal > stock) {
      throw new BadRequestException(`Solo quedan ${stock} unidades de "${producto.nombre}"`);
    }

    const carrito = previo ?? (await this.crear(ctx));
    const precio = Number(producto.precio_final ?? producto.precio_venta ?? 0);

    if (existente) {
      await this.repo.actualizarCantidad(existente.id_item, cantidadFinal);
    } else {
      await this.repo.agregarItem(carrito.id_carrito, idProducto, cantidad, precio);
    }

    await this.repo.tocar(carrito.id_carrito);
    return this.armarRespuesta(carrito);
  }

  async actualizarCantidad(ctx: ContextoCarrito, idItem: number, cantidad: number): Promise<CarritoTienda> {
    if (!Number.isInteger(cantidad) || cantidad <= 0) {
      throw new BadRequestException('La cantidad debe ser un número entero mayor a cero');
    }

    const carrito = await this.exigirItem(ctx, idItem);
    await this.repo.actualizarCantidad(idItem, cantidad);
    await this.repo.tocar(carrito.id_carrito);
    return this.armarRespuesta(carrito);
  }

  async eliminar(ctx: ContextoCarrito, idItem: number): Promise<CarritoTienda> {
    const carrito = await this.exigirItem(ctx, idItem);
    await this.repo.eliminarItem(idItem);
    await this.repo.tocar(carrito.id_carrito);
    return this.armarRespuesta(carrito);
  }

  async vaciar(ctx: ContextoCarrito): Promise<CarritoTienda> {
    const carrito = await this.buscar(ctx);
    if (!carrito) return carritoVacio();

    await this.repo.vaciar(carrito.id_carrito);
    return this.armarRespuesta(carrito);
  }

  /**
   * Al iniciar sesión, pasa lo que el visitante había agregado como invitado
   * a su carrito de cliente registrado (en una sola operación atómica).
   */
  async fusionar(idCliente: number, tokenInvitado: string): Promise<CarritoTienda> {
    const token = this.tokenDe(tokenInvitado);
    const carritoInvitado = token ? await this.repo.buscarPorToken(token) : null;
    if (!carritoInvitado) return this.ver({ idCliente });

    const carritoCliente = await this.repo.buscarPorCliente(idCliente);

    if (!carritoCliente) {
      await this.repo.asignarCliente(carritoInvitado.id_carrito, idCliente);
      return this.ver({ idCliente });
    }

    await this.repo.fusionarEn(carritoInvitado.id_carrito, carritoCliente.id_carrito);
    return this.armarRespuesta(carritoCliente);
  }

  /**
   * Arma la respuesta con el precio VIGENTE del catálogo: el carrito guarda el
   * precio del momento en que se agregó, y antes se compraba a ese precio aunque
   * la oferta hubiera terminado. Si cambió, se avisa en la línea y se guarda el
   * nuevo para no repetir el aviso.
   */
  async armarRespuesta(carrito: Carrito): Promise<CarritoTienda> {
    const filas = await this.repo.listarItems(carrito.id_carrito);
    const cambios: PrecioActualizado[] = [];

    const items: CarritoItemTienda[] = filas.map((fila) => {
      const idItem = Number(fila.id_item);
      const cantidad = Number(fila.cantidad ?? 0);
      const guardado = Number(fila.precio_unitario ?? 0);
      const vigente = Number(fila.precio_vigente ?? guardado);
      const stock = Number(fila.stock_disponible ?? 0);

      const item: CarritoItemTienda = {
        id_item: idItem,
        id_producto: Number(fila.id_producto),
        nombre: fila.nombre ?? '',
        imagen: fila.imagen ?? null,
        marca: fila.marca ?? undefined,
        cantidad,
        precio_unitario: vigente,
        subtotal: this.redondear(vigente * cantidad),
        stock_disponible: stock,
        // Sin la condición `stock > 0`: un producto agotado también excede.
        excede_stock: cantidad > stock,
      };

      if (centavos(vigente) !== centavos(guardado)) {
        cambios.push({ id_item: idItem, precio: vigente });
        item.precio_cambio = true;
        item.precio_anterior = guardado;
      }

      if (fila.activo === false) item.no_disponible = true;
      return item;
    });

    if (cambios.length) await this.repo.actualizarPrecios(cambios);

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

  // -------------------------------------------------------------- privados

  /** Carrito del contexto que contiene la línea; sin carrito no hay línea que tocar. */
  private async exigirItem(ctx: ContextoCarrito, idItem: number): Promise<Carrito> {
    const carrito = await this.buscar(ctx);
    const item = carrito ? await this.repo.buscarItemPorId(idItem, carrito.id_carrito) : null;
    if (!carrito || !item) throw new NotFoundException('El producto no está en tu carrito');
    return carrito;
  }

  /**
   * Crea el carrito del contexto. El token de invitado lo genera el servidor:
   * el que mandó el navegador ya no corresponde a ningún carrito activo.
   */
  private async crear(ctx: ContextoCarrito): Promise<Carrito> {
    if (!ctx.idCliente) return this.repo.crearParaInvitado(randomUUID());

    try {
      return await this.repo.crearParaCliente(ctx.idCliente);
    } catch (error) {
      // Dos "agregar" a la vez de un cliente sin carrito: el índice único deja
      // uno solo activo, y el que perdió la carrera usa ese.
      const existente = esViolacionUnica(error) ? await this.repo.buscarPorCliente(ctx.idCliente) : null;
      if (existente) return existente;
      throw error;
    }
  }

  private tokenDe(token?: string): string | undefined {
    const limpio = typeof token === 'string' ? token.trim() : '';
    return limpio && limpio.length <= LARGO_MAXIMO_TOKEN ? limpio : undefined;
  }
}

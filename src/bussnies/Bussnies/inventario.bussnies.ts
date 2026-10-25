import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { EntityManager } from 'typeorm';
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

/** Convierte los errores técnicos de stock (repositorio o PostgreSQL) en un mensaje para el usuario. */
export function traducirErrorStock(mensaje: string): string {
  if (mensaje.startsWith('STOCK_FUERA_DE_RANGO:')) {
    return 'El stock resultante supera el máximo que admite el sistema (2,147,483,647 unidades)';
  }
  if (/integer out of range|numeric field overflow/i.test(mensaje)) {
    return 'La cantidad es demasiado grande para el sistema. Revise el número ingresado.';
  }
  if (/invalid input syntax for type integer/i.test(mensaje)) {
    return 'La cantidad debe ser un número entero de unidades (sin decimales)';
  }
  if (/invalid input value for enum tipo_movimiento_inv/i.test(mensaje)) {
    return 'Falta aplicar la migración de inventario (sql/fase8_correcciones_esquema.sql) en la base de datos';
  }
  return mensaje;
}

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
    this.validarCantidad(dto);

    const producto = await this.productoRepo.getById(dto.id_producto);
    if (!producto) throw new NotFoundException(`Producto ${dto.id_producto} no encontrado`);

    const stock = await this.aplicarAjuste(dto);
    return { id_producto: dto.id_producto, id_almacen: dto.id_almacen, stock };
  }

  /**
   * El mismo ajuste dentro de la transacción de quien llama (recepción, visto bueno de una
   * observación): si algo posterior falla, el stock vuelve atrás junto con lo demás. Quien
   * llama ya validó que el producto existe (y la FK lo exige igual).
   */
  async ajustarEnTransaccion(manager: EntityManager, dto: AjustarStockRequest): Promise<number> {
    this.validarCantidad(dto);
    return this.aplicarAjuste(dto, manager);
  }

  private validarCantidad(dto: AjustarStockRequest): void {
    if (!dto.cantidad) throw new BadRequestException('Indique cuántas unidades ingresan o salen');
    // También llegan ajustes internos (recepción) que no pasan por el ValidationPipe.
    if (!Number.isInteger(Number(dto.cantidad))) {
      throw new BadRequestException('La cantidad debe ser un número entero de unidades (sin decimales)');
    }
  }

  private async aplicarAjuste(dto: AjustarStockRequest, manager?: EntityManager): Promise<number> {
    const descripcion = [ETIQUETA_MOTIVO[dto.motivo] ?? dto.motivo, dto.comentario]
      .filter(Boolean)
      .join(' · ');

    try {
      return await this.repo.ajustar(dto.id_producto, dto.id_almacen, Number(dto.cantidad), descripcion, manager);
    } catch (error: any) {
      const mensaje = String(error?.message ?? '');
      if (mensaje.startsWith('STOCK_NEGATIVO:')) {
        const disponible = mensaje.split(':')[1];
        throw new BadRequestException(
          `No se puede retirar esa cantidad: solo hay ${disponible} unidades en ese almacén`,
        );
      }
      throw new BadRequestException(traducirErrorStock(mensaje) || 'No se pudo ajustar el stock');
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
      throw new BadRequestException(traducirErrorStock(mensaje) || 'No se pudo transferir el stock');
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

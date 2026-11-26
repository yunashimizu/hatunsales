import { BadRequestException, ConflictException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { BitacoraService } from '../../bitacora/bitacora.service';
import { ACCIONES_BITACORA } from '../../bitacora/bitacora.acciones';
import type { UsuarioToken } from '../../guards/usuario-actual.decorator';
import { InventarioRepository, FiltroInventario } from '../../repository/Repository/inventario.repository';
import { ProductoRepository } from '../../repository/Repository/producto.repository';
import {
  ActualizarInventarioRequest,
  AjustarStockRequest,
  TransferirStockRequest,
} from '../../models/model/inventario.request';
import { InventarioResponse } from '../../models/model/inventario.response';
import { IInventarioBussniees } from '../Ibussnies/IInventarioBussniees';
import { esErrorDeBaseDatos } from '../../util/http/errores/traductor-errores-bd';
import { LocalesUsuarioService } from '../../stock/locales-usuario.service';
import type { RastroMovimiento } from '../../stock/rastro-movimiento';

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
    /** Bitácora (Fase 6.3): quién ajustó el stock. Nunca hace fallar el ajuste. */
    @Optional() private readonly bitacora?: BitacoraService,
    /** Fase 8.5: usuarios atados a locales. Sin él (pruebas antiguas) nadie queda restringido. */
    @Optional() private readonly locales?: LocalesUsuarioService,
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

  /** Fase 8.5: un usuario atado a locales solo ve los almacenes de sus locales (admin y sin asignar: todos). */
  async almacenes(usuario?: UsuarioToken) {
    const lista = await this.repo.almacenes();
    return this.locales ? this.locales.filtrar(usuario, lista) : lista;
  }

  /** Stock del producto en cada almacén (los que no tienen fila salen con 0 y `registrado: false`). */
  stockPorProducto(idProducto: number) {
    return this.repo.stockPorProducto(idProducto);
  }

  alertas() {
    return this.repo.listarDetallado({ solo_alertas: true, por_pagina: 200 });
  }

  movimientos(idProducto?: number, limite?: number) {
    return this.repo.movimientos(idProducto, limite);
  }

  /** Fase 8.1: historial del producto con quién, cuándo, dónde y por qué (paginado). */
  movimientosDeProducto(idProducto: number, opciones: { pagina?: number; por_pagina?: number; id_almacen?: number }) {
    return this.repo.movimientosDeProducto(idProducto, opciones);
  }

  /** Corrige el stock dejando escrito el motivo en el kardex. */
  async ajustar(dto: AjustarStockRequest, usuario?: UsuarioToken) {
    this.validarCantidad(dto);

    const producto = await this.productoRepo.getById(dto.id_producto);
    if (!producto) throw new NotFoundException(`Producto ${dto.id_producto} no encontrado`);
    // Fase 8.5: fuera de sus locales → 403 (admin y usuarios sin locales asignados: como hoy).
    await this.locales?.exigirAlmacen(usuario, dto.id_almacen, 'ajustar');

    // Fase 8.1: el movimiento guarda quién ajustó (el motivo de lista ya lo exige el DTO).
    const stock = await this.aplicarAjuste(dto, undefined, { id_usuario: usuario?.id_usuario ?? null, tipo_documento: 'ajuste', id_documento: null });
    // Fase 6.3: el ajuste ya está confirmado (el repositorio abre y cierra su transacción); la bitácora no lo frena.
    await this.bitacora?.registrarCon(() => ({
      accion: ACCIONES_BITACORA.INVENTARIO_AJUSTE,
      id_usuario: usuario?.id_usuario ?? null,
      rol: usuario?.rol ?? null,
      id_almacen: dto.id_almacen,
      entidad: 'producto',
      id_entidad: dto.id_producto,
      antes: { stock: stock - Number(dto.cantidad) },
      despues: { stock, cantidad: Number(dto.cantidad), motivo: dto.motivo },
      motivo: [ETIQUETA_MOTIVO[dto.motivo] ?? dto.motivo, dto.comentario?.trim()].filter(Boolean).join(' · '),
    }));
    return { id_producto: dto.id_producto, id_almacen: dto.id_almacen, stock };
  }

  /** Fase 8.5: la ficha de producto también ajusta stock; la misma regla que POST /inventario/ajuste. */
  async exigirAlmacenParaAjuste(usuario: UsuarioToken | undefined, idAlmacen: number): Promise<void> {
    await this.locales?.exigirAlmacen(usuario, idAlmacen, 'ajustar');
  }

  /**
   * El mismo ajuste dentro de la transacción de quien llama (recepción, visto bueno de una
   * observación): si algo posterior falla, el stock vuelve atrás junto con lo demás. Quien
   * llama ya validó que el producto existe (y la FK lo exige igual).
   */
  async ajustarEnTransaccion(manager: EntityManager, dto: AjustarStockRequest, rastro?: RastroMovimiento): Promise<number> {
    this.validarCantidad(dto);
    return this.aplicarAjuste(dto, manager, rastro);
  }

  private validarCantidad(dto: AjustarStockRequest): void {
    if (!dto.cantidad) throw new BadRequestException('Indique cuántas unidades ingresan o salen');
    // También llegan ajustes internos (recepción) que no pasan por el ValidationPipe.
    if (!Number.isInteger(Number(dto.cantidad))) {
      throw new BadRequestException('La cantidad debe ser un número entero de unidades (sin decimales)');
    }
  }

  private async aplicarAjuste(dto: AjustarStockRequest, manager?: EntityManager, rastro?: RastroMovimiento): Promise<number> {
    const descripcion = [ETIQUETA_MOTIVO[dto.motivo] ?? dto.motivo, dto.comentario]
      .filter(Boolean)
      .join(' · ');

    try {
      return await this.repo.ajustar(
        dto.id_producto,
        dto.id_almacen,
        Number(dto.cantidad),
        descripcion,
        manager,
        dto.stock_esperado === undefined || dto.stock_esperado === null ? undefined : Number(dto.stock_esperado),
        rastro,
      );
    } catch (error: any) {
      // Los de la base salen tal cual: el filtro global los traduce (p. ej. «intente de nuevo»).
      if (esErrorDeBaseDatos(error)) throw error;
      const mensaje = String(error?.message ?? '');
      if (mensaje.startsWith('STOCK_DESACTUALIZADO:')) throw this.stockDesactualizado(mensaje);
      if (mensaje.startsWith('STOCK_NEGATIVO:')) {
        const disponible = mensaje.split(':')[1];
        throw new BadRequestException(
          `No se puede retirar esa cantidad: solo hay ${disponible} unidades en ese almacén`,
        );
      }
      throw new BadRequestException(traducirErrorStock(mensaje) || 'No se pudo ajustar el stock');
    }
  }

  async transferir(dto: TransferirStockRequest, usuario?: UsuarioToken) {
    if (dto.id_almacen_origen === dto.id_almacen_destino) {
      throw new BadRequestException('El almacén de origen y el de destino deben ser distintos');
    }
    // Fase 8.5: el stock solo puede SALIR de un almacén de sus locales (enviar a otro local sí se puede).
    await this.locales?.exigirAlmacen(usuario, dto.id_almacen_origen, 'transferir');

    const descripcion = ['Transferencia entre almacenes', dto.comentario].filter(Boolean).join(' · ');

    try {
      await this.repo.transferir(
        dto.id_producto,
        dto.id_almacen_origen,
        dto.id_almacen_destino,
        dto.cantidad,
        descripcion,
        dto.stock_origen_esperado === undefined || dto.stock_origen_esperado === null
          ? undefined
          : Number(dto.stock_origen_esperado),
        // Fase 8.1: quién transfirió.
        { id_usuario: usuario?.id_usuario ?? null },
      );
      return { transferido: true };
    } catch (error: any) {
      if (esErrorDeBaseDatos(error)) throw error;
      const mensaje = String(error?.message ?? '');
      if (mensaje.startsWith('STOCK_DESACTUALIZADO:')) throw this.stockDesactualizado(mensaje);
      if (mensaje.startsWith('STOCK_INSUFICIENTE:')) {
        throw new BadRequestException(
          `El almacén de origen solo tiene ${mensaje.split(':')[1]} unidades disponibles`,
        );
      }
      throw new BadRequestException(traducirErrorStock(mensaje) || 'No se pudo transferir el stock');
    }
  }

  /** 409 con código para que el panel recargue el stock y deje la ficha abierta (ajuste y transferencia). */
  private stockDesactualizado(mensaje: string): ConflictException {
    const stockActual = Number(mensaje.split(':')[1]);
    return new ConflictException({
      codigo: 'STOCK_DESACTUALIZADO',
      stock_actual: stockActual,
      message:
        `El stock de este producto en ese almacén cambió mientras lo editaba: ahora hay ${stockActual}. ` +
        'Recargue la ficha y vuelva a intentar.',
    });
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

import { BadRequestException, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { EsquemaCajaService } from '../caja/esquema/esquema-caja.service';
import { CacheTtl } from '../sunat/config/cache-ttl';
import { Dinero } from '../caja/dominio/dinero';
import { FilaFrecuente, FilaUltimoProducto, PosRapidoRepository } from './pos-rapido.repository';

/** Fase 3.2: cuántos productos distintos se devuelven del historial del cliente. */
export const LIMITE_ULTIMOS_PRODUCTOS = 5;
/** Fase 3.3: ventana, cantidad de botones y mínimo de productos distintos para que valga la pena. */
export const DIAS_FRECUENTES = 30;
export const LIMITE_FRECUENTES = 12;
export const MINIMO_FRECUENTES = 3;
/** Los frecuentes cambian despacio: 5 minutos por almacén. */
export const TTL_FRECUENTES_MS = 5 * 60_000;

export interface UltimoProducto {
  id_producto: number;
  nombre: string;
  unidad_medida: string;
  /** Último precio unitario pagado (después de descuentos). */
  precio: number;
  cantidad: number;
  /** Fecha de esa compra (ISO). */
  fecha: string;
  id_venta: number;
  /** Precio de lista de hoy (para avisar si cambió). */
  precio_venta_actual: number;
  activo: boolean;
}

export interface UltimosProductosResponse {
  tipo: 'cliente' | 'empresa';
  id: number;
  productos: UltimoProducto[];
}

export interface Frecuente {
  id_producto: number;
  nombre: string;
  precio_venta: number;
  /** Descuento de la ficha (%), igual que en el catálogo del POS. */
  descuento: number;
  unidad_medida: string;
  /** Stock en el almacén pedido. */
  stock: number;
}

export interface FrecuentesResponse {
  id_almacen: number;
  id_sucursal: number | null;
  dias: number;
  /** Vacío si hay menos de MINIMO_FRECUENTES productos vendidos: el POS conserva su lista de siempre. */
  productos: Frecuente[];
}

function numero(valor: unknown): number {
  const n = Number(valor ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/** Historial por cliente y frecuentes reales del local (Fases 3.2 y 3.3). Solo lectura. */
@Injectable()
export class PosRapidoService {
  private readonly log = new Logger(PosRapidoService.name);
  private readonly cacheFrecuentes = new CacheTtl<FrecuentesResponse>(TTL_FRECUENTES_MS);

  constructor(
    private readonly repo: PosRapidoRepository,
    @Optional() private readonly esquema?: EsquemaCajaService,
  ) {}

  private async tiene(capacidad: 'ventaEstado' | 'ventaEmpresa' | 'ventaStockSalida' | 'ventaStockDevuelto'): Promise<boolean> {
    if (!this.esquema) return true;
    try {
      return await this.esquema.tiene(capacidad);
    } catch {
      return false;
    }
  }

  async ultimosProductos(por: 'cliente' | 'empresa', id: number): Promise<UltimosProductosResponse> {
    if (!Number.isInteger(id) || id <= 0) throw new BadRequestException(`El ${por} no es válido`);
    // Sin ventas.id_empresa (muy antiguo) las ventas a empresa no se pueden separar: lista vacía.
    if (por === 'empresa' && !(await this.tiene('ventaEmpresa'))) return { tipo: por, id, productos: [] };
    const filas = await this.repo.ultimosProductos(por, id, LIMITE_ULTIMOS_PRODUCTOS, await this.tiene('ventaEstado'));
    return { tipo: por, id, productos: filas.map((f) => this.aUltimo(f)) };
  }

  private aUltimo(f: FilaUltimoProducto): UltimoProducto {
    const fecha = f.fecha instanceof Date ? f.fecha : new Date(String(f.fecha));
    return {
      id_producto: Number(f.id_producto),
      nombre: String(f.nombre ?? ''),
      unidad_medida: String(f.unidad_medida ?? ''),
      precio: Dinero.desdeBd(f.precio ?? 0).aNumero(),
      cantidad: numero(f.cantidad),
      fecha: Number.isNaN(fecha.getTime()) ? String(f.fecha) : fecha.toISOString(),
      id_venta: Number(f.id_venta),
      precio_venta_actual: Dinero.desdeBd(f.precio_venta_actual ?? 0).aNumero(),
      activo: f.activo !== false,
    };
  }

  /** Frecuentes del local del almacén. Caché de 5 min por almacén. Nunca lanza por la consulta: lista vacía. */
  async frecuentes(idAlmacen: number): Promise<FrecuentesResponse> {
    if (!Number.isInteger(idAlmacen) || idAlmacen <= 0) throw new BadRequestException('Indique el almacén (id_almacen)');
    return structuredClone(await this.cacheFrecuentes.obtener(String(idAlmacen), () => this.calcularFrecuentes(idAlmacen)));
  }

  private async calcularFrecuentes(idAlmacen: number): Promise<FrecuentesResponse> {
    const almacen = await this.repo.sucursalDeAlmacen(idAlmacen);
    if (!almacen) throw new NotFoundException('Almacén no encontrado');
    const vacia: FrecuentesResponse = { id_almacen: idAlmacen, id_sucursal: almacen.id_sucursal, dias: DIAS_FRECUENTES, productos: [] };
    // Sin venta_stock_salida (fase11) no se sabe de qué local salió cada venta: el POS usa su lista de siempre.
    if (!(await this.tiene('ventaStockSalida'))) return vacia;
    let filas: FilaFrecuente[];
    try {
      filas = await this.repo.frecuentes(
        idAlmacen, almacen.id_sucursal, DIAS_FRECUENTES, LIMITE_FRECUENTES,
        await this.tiene('ventaEstado'), await this.tiene('ventaStockDevuelto'),
      );
    } catch (error) {
      this.log.warn(`No se pudieron calcular los frecuentes del almacén ${idAlmacen}: ${(error as Error)?.message ?? error}`);
      return vacia;
    }
    if (filas.length < MINIMO_FRECUENTES) return vacia;
    return {
      ...vacia,
      productos: filas.map((f) => ({
        id_producto: Number(f.id_producto),
        nombre: String(f.nombre ?? ''),
        precio_venta: Dinero.desdeBd(f.precio_venta ?? 0).aNumero(),
        descuento: numero(f.descuento),
        unidad_medida: String(f.unidad_medida ?? ''),
        stock: numero(f.stock),
      })),
    };
  }
}

import { Injectable, NotFoundException, ConflictException, Logger } from '@nestjs/common';
import { ProductoRepository, FilaProducto } from '../../repository/Repository/producto.repository';
import { InventarioRepository } from '../../repository/Repository/inventario.repository';
import { CrearProductoRequest, ActualizarProductoRequest } from '../../models/model/producto.request';
import { ProductoResponse } from '../../models/model/producto.response';
import { IProductoBussniees } from '../Ibussnies/IProductoBussniees';

@Injectable()
export class ProductoBussnies implements IProductoBussniees {

  private readonly logger = new Logger(ProductoBussnies.name);

  constructor(
    private readonly repo: ProductoRepository,
    private readonly inventarioRepo: InventarioRepository,
  ) {}

  async getAll(): Promise<ProductoResponse[]> {
    const lista = await this.repo.listarDetallado();
    return lista.map((p) => this.mapFila(p));
  }

  async getById(id: number): Promise<ProductoResponse> {
    const producto = await this.repo.detallePorId(id);
    if (!producto) throw new NotFoundException(`Producto ${id} no encontrado`);
    return this.mapFila(producto);
  }

  async create(dto: CrearProductoRequest): Promise<ProductoResponse> {
    await this.verificarUnicidad(dto.codigo_barras, dto.sku);

    const producto = await this.repo.create({
      nombre: dto.nombre?.trim(),
      descripcion: dto.descripcion ?? '',
      descripcion_corta: dto.descripcion_corta ?? '',
      codigo_barras: dto.codigo_barras?.trim() ?? '',
      sku: dto.sku?.trim() ?? '',
      slug: this.generarSlug(dto.nombre),
      precio_compra: dto.precio_compra ?? 0,
      precio_venta: dto.precio_venta ?? 0,
      descuento: dto.descuento ?? 0,
      unidad_medida: dto.unidad_medida ?? '',
      estado: dto.estado ?? true,
      destacado: dto.destacado ?? false,
      categoria: dto.id_categoria
        ? ({ id_categoria: dto.id_categoria } as any)
        : null,
      marca: dto.id_marca ? ({ id_marca: dto.id_marca } as any) : null,
    } as any);

    // Stock inicial opcional: vive en `inventario`, no en `productos`.
    if (dto.stock !== undefined && dto.stock !== null) {
      await this.registrarStockInicial(producto.id_producto, Number(dto.stock) || 0, dto.id_almacen);
    }

    return this.getById(producto.id_producto);
  }

  /** Crea la fila de inventario del producto recién dado de alta. */
  private async registrarStockInicial(
    idProducto: number,
    stock: number,
    idAlmacen?: number,
  ): Promise<void> {
    let almacenId = idAlmacen ? Number(idAlmacen) : 0;

    if (!almacenId) {
      const almacenes = await this.inventarioRepo.almacenes();
      almacenId = almacenes[0]?.id_almacen ? Number(almacenes[0].id_almacen) : 0;
    }

    if (!almacenId) {
      this.logger.warn(
        `Producto ${idProducto} creado sin fila de inventario: no hay almacén configurado`,
      );
      return;
    }

    await this.inventarioRepo.guardarOActualizar({
      producto: { id_producto: idProducto } as any,
      almacen: { id_almacen: almacenId } as any,
      stock: Math.max(0, Math.trunc(stock)),
      stock_minimo: 0,
    });
  }

  async update(dto: ActualizarProductoRequest, id: number): Promise<ProductoResponse> {
    const existente = await this.repo.getById(id);
    if (!existente) throw new NotFoundException(`Producto ${id} no encontrado`);

    await this.verificarUnicidad(dto.codigo_barras, dto.sku, id);

    // Solo se tocan los campos que llegaron: así una edición parcial desde el
    // panel no borra datos que ese formulario no muestra.
    const cambios: Record<string, any> = {
      nombre: dto.nombre?.trim(),
      descripcion: dto.descripcion,
      descripcion_corta: dto.descripcion_corta,
      codigo_barras: dto.codigo_barras?.trim(),
      sku: dto.sku?.trim(),
      precio_compra: dto.precio_compra,
      precio_venta: dto.precio_venta,
      descuento: dto.descuento,
      unidad_medida: dto.unidad_medida,
      estado: dto.estado,
      destacado: dto.destacado,
    };

    if (dto.nombre?.trim()) cambios['slug'] = this.generarSlug(dto.nombre);

    if (dto.id_categoria !== undefined) {
      cambios['categoria'] = dto.id_categoria
        ? ({ id_categoria: dto.id_categoria } as any)
        : null;
    }
    if (dto.id_marca !== undefined) {
      cambios['marca'] = dto.id_marca ? ({ id_marca: dto.id_marca } as any) : null;
    }

    Object.keys(cambios).forEach((clave) => {
      if (cambios[clave] === undefined) delete cambios[clave];
    });

    if (Object.keys(cambios).length) {
      await this.repo.actualizar(id, cambios as any);
    }

    return this.getById(id);
  }

  async delete(id: number): Promise<number> {
    const existe = await this.repo.getById(id);
    if (!existe) throw new NotFoundException(`Producto ${id} no encontrado`);
    return this.repo.delete(id);
  }

  async buscarPorCodigoBarras(codigo_barras: string): Promise<ProductoResponse> {
    const producto = await this.repo.buscarPorCodigoBarras(codigo_barras);
    if (!producto) throw new NotFoundException(`Código de barras ${codigo_barras} no encontrado`);
    return this.getById(producto.id_producto);
  }

  // ── Auxiliares ───────────────────────────────────────────────

  private async verificarUnicidad(codigoBarras?: string, sku?: string, idActual?: number): Promise<void> {
    const codigo = codigoBarras?.trim();
    if (codigo) {
      const existe = await this.repo.buscarPorCodigoBarras(codigo);
      if (existe && existe.id_producto !== idActual) {
        throw new ConflictException('Ya existe un producto con ese código de barras');
      }
    }

    const codigoInterno = sku?.trim();
    if (codigoInterno) {
      const existe = await this.repo.buscarPorSku(codigoInterno);
      if (existe && existe.id_producto !== idActual) {
        throw new ConflictException('Ya existe un producto con ese SKU');
      }
    }
  }

  private generarSlug(nombre?: string): string {
    return (nombre ?? '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 120);
  }

  private mapFila(p: FilaProducto): ProductoResponse {
    return {
      id_producto: p.id_producto,
      nombre: p.nombre ?? '',
      descripcion: p.descripcion ?? '',
      descripcion_corta: p.descripcion_corta ?? '',
      codigo_barras: p.codigo_barras ?? '',
      sku: p.sku ?? '',
      precio_compra: Number(p.precio_compra ?? 0),
      precio_venta: Number(p.precio_venta ?? 0),
      descuento: Number(p.descuento ?? 0),
      unidad_medida: p.unidad_medida ?? '',
      id_categoria: p.id_categoria ?? undefined,
      categoria: p.categoria ?? '',
      id_marca: p.id_marca ?? undefined,
      marca: p.marca ?? '',
      estado: p.estado ?? true,
      destacado: p.destacado ?? false,
      imagen_url: p.imagen_url ?? '',
      thumb_url: p.thumb_url ?? p.imagen_url ?? '',
      total_imagenes: Number(p.total_imagenes ?? 0),
      stock_total: Number(p.stock_total ?? 0),
      creado_en: p.creado_en,
    };
  }
}

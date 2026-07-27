import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Producto } from '../../models/DBModel/producto.entity';
import { CrudRepository } from '../Irepository/GenericIRepository/crud.Irepository';

/** Fila plana del listado del panel, ya con categoría, imagen y stock. */
export interface FilaProducto {
  id_producto: number;
  nombre: string;
  descripcion: string;
  descripcion_corta: string;
  codigo_barras: string;
  sku: string;
  precio_compra: string | number;
  precio_venta: string | number;
  descuento: string | number;
  unidad_medida: string;
  estado: boolean;
  destacado: boolean;
  id_categoria: number | null;
  categoria: string | null;
  id_marca: number | null;
  marca: string | null;
  imagen_url: string | null;
  thumb_url: string | null;
  total_imagenes: string | number;
  stock_total: string | number;
  creado_en: Date;
}

@Injectable()
export class ProductoRepository extends CrudRepository<Producto> {

  constructor(
    @InjectRepository(Producto, 'pgConnection')
    private readonly productoRepo: Repository<Producto>,
  ) {
    super(productoRepo);
  }

  override async getAll(): Promise<Producto[]> {
    return this.productoRepo.find({ order: { id_producto: 'ASC' } });
  }

  override async getById(id: number): Promise<Producto | null> {
    return this.productoRepo.findOne({ where: { id_producto: id } });
  }

  async buscarPorCodigoBarras(codigo_barras: string): Promise<Producto | null> {
    return this.productoRepo.findOne({ where: { codigo_barras } });
  }

  async buscarPorSku(sku: string): Promise<Producto | null> {
    return this.productoRepo.findOne({ where: { sku } });
  }

  async actualizar(id: number, data: Partial<Producto>): Promise<Producto> {
    await this.productoRepo.update(id, data as any);
    return this.getById(id) as Promise<Producto>;
  }

  /**
   * Listado para el panel. Resuelve en una sola consulta la imagen principal y
   * el stock consolidado; hacerlo con relaciones de TypeORM traería una consulta
   * por producto y la tabla se sentiría lenta apenas crezca el catálogo.
   */
  async listarDetallado(): Promise<FilaProducto[]> {
    return this.productoRepo.query(`
      SELECT
        p.id_producto,
        COALESCE(p.nombre, '')            AS nombre,
        COALESCE(p.descripcion, '')       AS descripcion,
        COALESCE(p.descripcion_corta, '') AS descripcion_corta,
        COALESCE(p.codigo_barras, '')     AS codigo_barras,
        COALESCE(p.sku, '')               AS sku,
        COALESCE(p.precio_compra, 0)      AS precio_compra,
        COALESCE(p.precio_venta, 0)       AS precio_venta,
        COALESCE(p.descuento, 0)          AS descuento,
        COALESCE(p.unidad_medida, '')     AS unidad_medida,
        COALESCE(p.estado, true)          AS estado,
        COALESCE(p.destacado, false)      AS destacado,
        p.id_categoria,
        c.nombre                          AS categoria,
        p.id_marca,
        m.nombre                          AS marca,
        img.url                           AS imagen_url,
        img.thumb_url                     AS thumb_url,
        COALESCE(conteo.total, 0)         AS total_imagenes,
        COALESCE(inv.stock, 0)            AS stock_total,
        p.creado_en
      FROM productos p
      LEFT JOIN categorias c ON c.id_categoria = p.id_categoria
      LEFT JOIN marcas m ON m.id_marca = p.id_marca
      LEFT JOIN LATERAL (
        SELECT i.url, i.thumb_url
        FROM productos_imagenes i
        WHERE i.id_producto = p.id_producto
        ORDER BY i.is_primary DESC, i.orden ASC, i.id_imagen ASC
        LIMIT 1
      ) img ON TRUE
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS total
        FROM productos_imagenes i
        WHERE i.id_producto = p.id_producto
      ) conteo ON TRUE
      LEFT JOIN LATERAL (
        SELECT SUM(i.stock)::int AS stock
        FROM inventario i
        WHERE i.id_producto = p.id_producto
      ) inv ON TRUE
      ORDER BY p.id_producto DESC
    `);
  }

  async detallePorId(id: number): Promise<FilaProducto | null> {
    const filas: FilaProducto[] = await this.productoRepo.query(
      `
      SELECT
        p.id_producto,
        COALESCE(p.nombre, '')            AS nombre,
        COALESCE(p.descripcion, '')       AS descripcion,
        COALESCE(p.descripcion_corta, '') AS descripcion_corta,
        COALESCE(p.codigo_barras, '')     AS codigo_barras,
        COALESCE(p.sku, '')               AS sku,
        COALESCE(p.precio_compra, 0)      AS precio_compra,
        COALESCE(p.precio_venta, 0)       AS precio_venta,
        COALESCE(p.descuento, 0)          AS descuento,
        COALESCE(p.unidad_medida, '')     AS unidad_medida,
        COALESCE(p.estado, true)          AS estado,
        COALESCE(p.destacado, false)      AS destacado,
        p.id_categoria,
        c.nombre                          AS categoria,
        p.id_marca,
        m.nombre                          AS marca,
        img.url                           AS imagen_url,
        img.thumb_url                     AS thumb_url,
        COALESCE(conteo.total, 0)         AS total_imagenes,
        COALESCE(inv.stock, 0)            AS stock_total,
        p.creado_en
      FROM productos p
      LEFT JOIN categorias c ON c.id_categoria = p.id_categoria
      LEFT JOIN marcas m ON m.id_marca = p.id_marca
      LEFT JOIN LATERAL (
        SELECT i.url, i.thumb_url
        FROM productos_imagenes i
        WHERE i.id_producto = p.id_producto
        ORDER BY i.is_primary DESC, i.orden ASC, i.id_imagen ASC
        LIMIT 1
      ) img ON TRUE
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS total
        FROM productos_imagenes i
        WHERE i.id_producto = p.id_producto
      ) conteo ON TRUE
      LEFT JOIN LATERAL (
        SELECT SUM(i.stock)::int AS stock
        FROM inventario i
        WHERE i.id_producto = p.id_producto
      ) inv ON TRUE
      WHERE p.id_producto = $1
      `,
      [id],
    );

    return filas[0] ?? null;
  }
}

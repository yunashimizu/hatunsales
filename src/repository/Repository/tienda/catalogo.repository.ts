import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Producto } from '../../../models/DBModel/producto.entity';

export interface FiltrosCatalogo {
  q?: string;
  id_categoria?: number;
  id_marca?: number;
  precio_min?: number;
  precio_max?: number;
  solo_stock?: boolean;
  solo_oferta?: boolean;
  solo_destacado?: boolean;
  atributos?: { nombre: string; valor: string }[];
  orden?: string;
  pagina: number;
  limite: number;
}

/**
 * Lee del catálogo apoyándose en la vista `vw_catalogo`, que ya resuelve
 * precio final, categoría, marca, stock, rating e imagen principal.
 */
@Injectable()
export class CatalogoRepository {

  constructor(
    @InjectRepository(Producto, 'pgConnection')
    private readonly productoRepo: Repository<Producto>,
  ) {}

  private get manager() {
    return this.productoRepo.manager;
  }

  private construirWhere(
    filtros: FiltrosCatalogo,
    politica?: { exclusivo: boolean; idAlmacen?: number },
  ): { where: string; params: any[] } {
    const condiciones: string[] = ['COALESCE(c.estado, TRUE) = TRUE'];
    const params: any[] = [];

    if (filtros.q) {
      params.push(`%${filtros.q.toLowerCase()}%`);
      const i = params.length;
      condiciones.push(`(
        LOWER(c.nombre) LIKE $${i}
        OR LOWER(COALESCE(c.sku, '')) LIKE $${i}
        OR LOWER(COALESCE(c.codigo_barras, '')) LIKE $${i}
        OR LOWER(COALESCE(c.descripcion, '')) LIKE $${i}
        OR LOWER(COALESCE(c.marca, '')) LIKE $${i}
        OR LOWER(COALESCE(c.categoria, '')) LIKE $${i}
      )`);
    }

    if (filtros.id_categoria) {
      params.push(filtros.id_categoria);
      condiciones.push(`c.id_categoria = $${params.length}`);
    }

    if (filtros.id_marca) {
      params.push(filtros.id_marca);
      condiciones.push(`c.id_marca = $${params.length}`);
    }

    if (filtros.precio_min !== undefined) {
      params.push(filtros.precio_min);
      condiciones.push(`c.precio_final >= $${params.length}`);
    }

    if (filtros.precio_max !== undefined) {
      params.push(filtros.precio_max);
      condiciones.push(`c.precio_final <= $${params.length}`);
    }

    if (filtros.solo_stock) {
      if (politica?.exclusivo && politica.idAlmacen) {
        params.push(politica.idAlmacen);
        condiciones.push(`EXISTS (
          SELECT 1 FROM inventario i
           WHERE i.id_producto = c.id_producto
             AND i.id_almacen = $${params.length}
             AND i.stock > 0
        )`);
      } else {
        condiciones.push('c.stock > 0');
      }
    }

    if (filtros.solo_oferta) {
      condiciones.push('COALESCE(c.descuento, 0) > 0');
    }

    if (filtros.solo_destacado) {
      condiciones.push('c.destacado = TRUE');
    }

    for (const atributo of filtros.atributos ?? []) {
      params.push(atributo.nombre);
      const iNombre = params.length;
      params.push(atributo.valor);
      const iValor = params.length;
      condiciones.push(`EXISTS (
        SELECT 1 FROM producto_atributos pa
        WHERE pa.id_producto = c.id_producto
          AND LOWER(pa.nombre) = LOWER($${iNombre})
          AND LOWER(pa.valor)  = LOWER($${iValor})
      )`);
    }

    return { where: condiciones.join(' AND '), params };
  }

  private construirOrden(orden?: string): string {
    switch (orden) {
      case 'precio_asc':  return 'c.precio_final ASC';
      case 'precio_desc': return 'c.precio_final DESC';
      case 'nombre':      return 'c.nombre ASC';
      case 'nuevo':       return 'c.id_producto DESC';
      case 'rating':      return 'c.rating DESC, c.total_resenas DESC';
      default:            return 'c.destacado DESC, c.stock > 0 DESC, c.id_producto DESC';
    }
  }

  async buscar(filtros: FiltrosCatalogo): Promise<{ rows: any[]; total: number }> {
    const politica = await this.politicaStockWeb();
    const { where, params } = this.construirWhere(filtros, politica);
    const offset = (filtros.pagina - 1) * filtros.limite;

    const [{ total }] = await this.manager.query(
      `SELECT COUNT(*)::INTEGER AS total FROM vw_catalogo c WHERE ${where}`,
      params,
    );

    const rows = await this.manager.query(
      `SELECT * FROM vw_catalogo c
       WHERE ${where}
       ORDER BY ${this.construirOrden(filtros.orden)}
       LIMIT ${filtros.limite} OFFSET ${offset}`,
      params,
    );

    return { rows: await this.aplicarStockTienda(rows, politica), total: Number(total ?? 0) };
  }

  async obtenerPorId(id: number): Promise<any | null> {
    const rows = await this.manager.query(
      'SELECT * FROM vw_catalogo c WHERE c.id_producto = $1 LIMIT 1',
      [id],
    );
    const mapeadas = await this.aplicarStockTienda(rows);
    return mapeadas[0] ?? null;
  }

  async obtenerPorSlug(slug: string): Promise<any | null> {
    const rows = await this.manager.query(
      'SELECT * FROM vw_catalogo c WHERE c.slug = $1 LIMIT 1',
      [slug],
    );
    const mapeadas = await this.aplicarStockTienda(rows);
    return mapeadas[0] ?? null;
  }

  async obtenerImagenes(idProducto: number): Promise<any[]> {
    return this.manager.query(
      `SELECT id_imagen, url, thumb_url, COALESCE(is_primary, FALSE) AS is_primary
       FROM productos_imagenes
       WHERE id_producto = $1
       ORDER BY is_primary DESC NULLS LAST, COALESCE(orden, 0) ASC, id_imagen ASC`,
      [idProducto],
    );
  }

  async obtenerEspecificaciones(idProducto: number): Promise<any[]> {
    return this.manager.query(
      `SELECT nombre, valor FROM producto_atributos
       WHERE id_producto = $1
       ORDER BY COALESCE(orden, 0) ASC, id_atributo ASC`,
      [idProducto],
    );
  }

  async obtenerStockPorSucursal(idProducto: number): Promise<any[]> {
    return this.manager.query(
      `SELECT id_sucursal, sucursal, direccion_sucursal AS direccion, stock
       FROM vw_producto_stock_sucursal
       WHERE id_producto = $1
       ORDER BY sucursal ASC`,
      [idProducto],
    );
  }

  async obtenerRelacionados(idProducto: number, idCategoria: number | null, limite: number): Promise<any[]> {
    let rows: any[];
    if (!idCategoria) {
      rows = await this.manager.query(
        `SELECT * FROM vw_catalogo c
         WHERE c.id_producto <> $1 AND COALESCE(c.estado, TRUE) = TRUE
         ORDER BY c.destacado DESC, c.id_producto DESC LIMIT $2`,
        [idProducto, limite],
      );
    } else {
      rows = await this.manager.query(
        `SELECT * FROM vw_catalogo c
         WHERE c.id_categoria = $1 AND c.id_producto <> $2 AND COALESCE(c.estado, TRUE) = TRUE
         ORDER BY c.destacado DESC, c.id_producto DESC LIMIT $3`,
        [idCategoria, idProducto, limite],
      );
    }
    return this.aplicarStockTienda(rows);
  }

  async obtenerCategorias(): Promise<any[]> {
    return this.manager.query(
      `SELECT cat.id_categoria, cat.nombre, cat.slug, cat.descripcion, cat.icono, cat.imagen_url,
              COUNT(p.id_producto)::INTEGER AS total_productos
       FROM categorias cat
       LEFT JOIN productos p ON p.id_categoria = cat.id_categoria AND COALESCE(p.estado, TRUE) = TRUE
       WHERE COALESCE(cat.activo, TRUE) = TRUE
       GROUP BY cat.id_categoria, cat.nombre, cat.slug, cat.descripcion, cat.icono, cat.imagen_url, cat.orden
       ORDER BY COALESCE(cat.orden, 0) ASC, cat.nombre ASC`,
    );
  }

  async obtenerMarcas(): Promise<any[]> {
    return this.manager.query(
      `SELECT m.id_marca, m.nombre, m.slug, m.logo_url,
              COUNT(p.id_producto)::INTEGER AS total_productos
       FROM marcas m
       LEFT JOIN productos p ON p.id_marca = m.id_marca AND COALESCE(p.estado, TRUE) = TRUE
       WHERE COALESCE(m.activo, TRUE) = TRUE
       GROUP BY m.id_marca, m.nombre, m.slug, m.logo_url
       ORDER BY m.nombre ASC`,
    );
  }

  async obtenerRangoPrecios(): Promise<{ min: number; max: number }> {
    const rows = await this.manager.query(
      `SELECT COALESCE(MIN(precio_final), 0)::NUMERIC AS min,
              COALESCE(MAX(precio_final), 0)::NUMERIC AS max
       FROM vw_catalogo WHERE COALESCE(estado, TRUE) = TRUE`,
    );
    return { min: Number(rows[0]?.min ?? 0), max: Number(rows[0]?.max ?? 0) };
  }

  async obtenerAtributosFiltrables(idCategoria?: number): Promise<any[]> {
    const params: any[] = [];
    let filtroCategoria = '';

    if (idCategoria) {
      params.push(idCategoria);
      filtroCategoria = `AND p.id_categoria = $${params.length}`;
    }

    return this.manager.query(
      `SELECT pa.nombre, pa.valor, COUNT(*)::INTEGER AS total
       FROM producto_atributos pa
       JOIN productos p ON p.id_producto = pa.id_producto AND COALESCE(p.estado, TRUE) = TRUE
       WHERE COALESCE(pa.filtrable, TRUE) = TRUE ${filtroCategoria}
       GROUP BY pa.nombre, pa.valor
       ORDER BY pa.nombre ASC, pa.valor ASC`,
      params,
    );
  }

  async obtenerBanners(): Promise<any[]> {
    return this.manager.query(
      `SELECT id_banner, titulo, subtitulo, etiqueta, imagen_url, cta_texto, cta_url
       FROM banners
       WHERE COALESCE(activo, TRUE) = TRUE
         AND (fecha_inicio IS NULL OR fecha_inicio <= CURRENT_DATE)
         AND (fecha_fin    IS NULL OR fecha_fin    >= CURRENT_DATE)
       ORDER BY COALESCE(orden, 0) ASC, id_banner ASC`,
    );
  }

  async obtenerStockTotal(idProducto: number): Promise<number> {
    const politica = await this.politicaStockWeb();
    if (politica.exclusivo && politica.idAlmacen) {
      const rows = await this.manager.query(
        `SELECT COALESCE(stock, 0)::INTEGER AS stock
           FROM inventario
          WHERE id_producto = $1 AND id_almacen = $2
          LIMIT 1`,
        [idProducto, politica.idAlmacen],
      );
      return Number(rows[0]?.stock ?? 0);
    }

    const rows = await this.manager.query(
      'SELECT COALESCE(stock_total, 0)::INTEGER AS stock FROM vw_producto_stock WHERE id_producto = $1',
      [idProducto],
    );
    return Number(rows[0]?.stock ?? 0);
  }

  /** Fase 6 / D2: exclusivo si hay tienda_id_almacen y modo ≠ spillover. */
  private async politicaStockWeb(): Promise<{ exclusivo: boolean; idAlmacen?: number }> {
    const filas = await this.manager.query(
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

  /** Sustituye el stock SUM del catálogo por el del almacén de despacho web. */
  private async aplicarStockTienda(
    rows: any[],
    politica?: { exclusivo: boolean; idAlmacen?: number },
  ): Promise<any[]> {
    if (!rows?.length) return rows ?? [];
    const pol = politica ?? (await this.politicaStockWeb());
    if (!pol.exclusivo || !pol.idAlmacen) return rows;

    const ids = rows.map((r) => Number(r.id_producto)).filter((id) => Number.isFinite(id));
    if (!ids.length) return rows;

    const stocks = await this.manager.query(
      `SELECT id_producto, COALESCE(stock, 0)::INTEGER AS stock
         FROM inventario
        WHERE id_almacen = $1 AND id_producto = ANY($2)`,
      [pol.idAlmacen, ids],
    );
    const mapa = new Map<number, number>();
    for (const s of stocks ?? []) mapa.set(Number(s.id_producto), Number(s.stock ?? 0));

    return rows.map((r) => ({
      ...r,
      stock: mapa.get(Number(r.id_producto)) ?? 0,
    }));
  }
}

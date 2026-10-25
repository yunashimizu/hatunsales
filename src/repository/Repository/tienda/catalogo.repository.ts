import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Producto } from '../../../models/DBModel/producto.entity';
import { PoliticaStockTienda, StockTiendaRepository } from './stock-tienda.repository';
import { SQL_HOY_LIMA } from '../../../util/fecha-lima';

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

export interface OpcionesBusqueda {
  /** false en portada y buscador, que no muestran el total: se ahorra el COUNT. */
  conTotal?: boolean;
}

const COLUMNAS_PRODUCTO = `p.id_producto, p.nombre, p.slug, p.descripcion, p.descripcion_corta, p.sku,
         p.codigo_barras, p.precio_venta, p.descuento,
         round(p.precio_venta - COALESCE(p.descuento, 0::numeric), 2) AS precio_final,
         p.destacado, p.estado, p.unidad_medida,
         cat.id_categoria, cat.nombre AS categoria,
         m.id_marca, m.nombre AS marca,
         COALESCE(st.stock_total, 0) AS stock`;

/** Subconsulta suelta: PostgreSQL la calcula después del ORDER BY + LIMIT, solo para las filas devueltas. */
const IMAGEN_PRINCIPAL = `(SELECT pi.url
            FROM productos_imagenes pi
           WHERE pi.id_producto = p.id_producto
           ORDER BY pi.is_primary DESC NULLS LAST, pi.orden, pi.id_imagen
           LIMIT 1) AS imagen_principal`;

const RATING_POR_FILA = `COALESCE((SELECT round(avg(r.calificacion), 2)
                     FROM resenas r
                    WHERE r.id_producto = p.id_producto AND r.aprobado = true), 0::numeric) AS rating,
         (SELECT count(r.id_resena)::integer
            FROM resenas r
           WHERE r.id_producto = p.id_producto AND r.aprobado = true) AS total_resenas`;

const UNIONES_PRODUCTO = `FROM productos p
    LEFT JOIN categorias cat ON cat.id_categoria = p.id_categoria
    LEFT JOIN marcas m ON m.id_marca = p.id_marca
    LEFT JOIN LATERAL (
      SELECT SUM(i.stock)::integer AS stock_total
        FROM inventario i
       WHERE i.id_producto = p.id_producto
    ) st ON TRUE`;

/**
 * Productos del catálogo con las mismas columnas que la vista `vw_catalogo`
 * (precio final, categoría, marca, stock, rating e imagen principal). La vista
 * agrupa TODO el inventario y TODAS las reseñas antes de filtrar, así que hasta
 * un `LIMIT 4` pagaba el catálogo entero; aquí el stock va por producto
 * (LATERAL, hace falta para filtrar y ordenar) y rating e imagen se calculan
 * solo para las filas que se devuelven. Un COUNT no evalúa ninguno.
 */
export const FUENTE_CATALOGO = `(
  SELECT ${COLUMNAS_PRODUCTO},
         ${RATING_POR_FILA},
         ${IMAGEN_PRINCIPAL}
    ${UNIONES_PRODUCTO}
) c`;

/** Para ordenar por rating hace falta el de todos: las reseñas se agrupan una sola vez. */
const FUENTE_CATALOGO_POR_RATING = `(
  SELECT ${COLUMNAS_PRODUCTO},
         COALESCE(rt.rating, 0::numeric) AS rating,
         COALESCE(rt.total_resenas, 0) AS total_resenas,
         ${IMAGEN_PRINCIPAL}
    ${UNIONES_PRODUCTO}
    LEFT JOIN (
      SELECT r.id_producto, round(avg(r.calificacion), 2) AS rating, count(*)::integer AS total_resenas
        FROM resenas r
       WHERE r.aprobado = true
       GROUP BY r.id_producto
    ) rt ON rt.id_producto = p.id_producto
) c`;

/** Topes del paginado; el servicio ya los valida, esto evita que un valor raro llegue al SQL. */
const LIMITE_SQL_MAXIMO = 100;

/** `%`, `_` y `\` del texto buscado son literales, no comodines de LIKE. */
function patronContiene(texto: string): string {
  return `%${texto.toLowerCase().replace(/[\\%_]/g, '\\$&')}%`;
}

@Injectable()
export class CatalogoRepository {

  constructor(
    @InjectRepository(Producto, 'pgConnection')
    private readonly productoRepo: Repository<Producto>,
    private readonly stockRepo: StockTiendaRepository,
  ) {}

  private get manager() {
    return this.productoRepo.manager;
  }

  private construirWhere(filtros: FiltrosCatalogo, politica: PoliticaStockTienda): { where: string; params: any[] } {
    const condiciones: string[] = ['COALESCE(c.estado, TRUE) = TRUE'];
    const params: any[] = [];

    if (filtros.q) {
      params.push(patronContiene(filtros.q));
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
      if (politica.exclusivo && politica.idAlmacen) {
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

  async buscar(
    filtros: FiltrosCatalogo,
    opciones: OpcionesBusqueda = {},
  ): Promise<{ rows: any[]; total?: number }> {
    const politica = await this.stockRepo.politicaStock();
    const { where, params } = this.construirWhere(filtros, politica);
    const limite = Math.min(Math.max(1, Math.trunc(filtros.limite) || 1), LIMITE_SQL_MAXIMO);
    const offset = (Math.max(1, Math.trunc(filtros.pagina) || 1) - 1) * limite;
    const fuente = filtros.orden === 'rating' ? FUENTE_CATALOGO_POR_RATING : FUENTE_CATALOGO;

    const filas = this.manager.query(
      `SELECT * FROM ${fuente}
       WHERE ${where}
       ORDER BY ${this.construirOrden(filtros.orden)}
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limite, offset],
    );

    if (opciones.conTotal === false) {
      return { rows: await this.aplicarStockTienda(await filas, politica) };
    }

    // COUNT y filas a la vez: cada viaje a la BD cuesta el RTT del proxy público.
    const [conteo, rows] = await Promise.all([
      this.manager.query(`SELECT COUNT(*)::INTEGER AS total FROM ${FUENTE_CATALOGO} WHERE ${where}`, params),
      filas,
    ]);

    return { rows: await this.aplicarStockTienda(rows, politica), total: Number(conteo[0]?.total ?? 0) };
  }

  async obtenerPorId(id: number): Promise<any | null> {
    const rows = await this.manager.query(
      `SELECT * FROM ${FUENTE_CATALOGO} WHERE c.id_producto = $1 LIMIT 1`,
      [id],
    );
    const mapeadas = await this.aplicarStockTienda(rows);
    return mapeadas[0] ?? null;
  }

  async obtenerPorSlug(slug: string): Promise<any | null> {
    const rows = await this.manager.query(
      `SELECT * FROM ${FUENTE_CATALOGO} WHERE c.slug = $1 LIMIT 1`,
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
        `SELECT * FROM ${FUENTE_CATALOGO}
         WHERE c.id_producto <> $1 AND COALESCE(c.estado, TRUE) = TRUE
         ORDER BY c.destacado DESC, c.id_producto DESC LIMIT $2`,
        [idProducto, limite],
      );
    } else {
      rows = await this.manager.query(
        `SELECT * FROM ${FUENTE_CATALOGO}
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

  /** Mismo precio final que el catálogo, sin pasar por stock ni reseñas. */
  async obtenerRangoPrecios(): Promise<{ min: number; max: number }> {
    const rows = await this.manager.query(
      `SELECT COALESCE(MIN(round(precio_venta - COALESCE(descuento, 0::numeric), 2)), 0)::NUMERIC AS min,
              COALESCE(MAX(round(precio_venta - COALESCE(descuento, 0::numeric), 2)), 0)::NUMERIC AS max
       FROM productos WHERE COALESCE(estado, TRUE) = TRUE`,
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

  /** Vigencia por día de Lima: con CURRENT_DATE (UTC) los banners cambiaban a las 19:00. */
  async obtenerBanners(): Promise<any[]> {
    return this.manager.query(
      `SELECT id_banner, titulo, subtitulo, etiqueta, imagen_url, cta_texto, cta_url
       FROM banners
       WHERE COALESCE(activo, TRUE) = TRUE
         AND (fecha_inicio IS NULL OR fecha_inicio <= ${SQL_HOY_LIMA})
         AND (fecha_fin    IS NULL OR fecha_fin    >= ${SQL_HOY_LIMA})
       ORDER BY COALESCE(orden, 0) ASC, id_banner ASC`,
    );
  }

  /** Sustituye el stock total del catálogo por el del almacén de despacho web. */
  private async aplicarStockTienda(rows: any[], politica?: PoliticaStockTienda): Promise<any[]> {
    if (!rows?.length) return rows ?? [];
    const pol = politica ?? (await this.stockRepo.politicaStock());
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

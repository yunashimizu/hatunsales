import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { Producto } from '../../models/DBModel/producto.entity';
import { patronSku } from '../../util/codigo-sku';
import { CrudRepository } from '../Irepository/GenericIRepository/crud.Irepository';

/** Producto activo sin código SUNAT, para la tarjeta de carga del panel. */
export interface FilaProductoSinCodigoSunat {
  id_producto: number;
  nombre: string;
  sku: string;
  codigo_barras: string;
  categoria: string | null;
  unidad_medida: string;
}

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
  codigo_sunat: string | null;
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

  /**
   * Búsqueda exacta por código de barras (recortado con `btrim`) y, si no hay, por SKU sin distinguir
   * mayúsculas. No filtra por estado: el panel ve también los inactivos. Si varios coinciden gana el
   * que coincide por barras y luego el de menor id.
   */
  async buscarPorCodigoBarras(codigo_barras: string): Promise<Producto | null> {
    const codigo = String(codigo_barras ?? '').trim();
    if (!codigo) return null;
    // Sin COALESCE en el WHERE para que el planificador use `uq_productos_codigo_barras`
    // (sobre btrim(codigo_barras)) e `idx_productos_sku_lower` (sobre lower(sku)). Con un
    // código no vacío el resultado es el mismo: NULL nunca es igual a nada. En el ORDER BY
    // sí se queda el COALESCE: ahí `NULL = :codigo` daría NULL y DESC pone los NULL primero,
    // con lo que un producto hallado por SKU y sin barras le ganaría al que coincide por barras.
    return this.productoRepo
      .createQueryBuilder('p')
      .where('btrim(p.codigo_barras) = :codigo', { codigo })
      .orWhere('LOWER(p.sku) = LOWER(:codigo)', { codigo })
      .orderBy("(btrim(COALESCE(p.codigo_barras, '')) = :codigo)", 'DESC')
      .addOrderBy('p.id_producto', 'ASC')
      .getOne();
  }

  /**
   * Siguiente número de la secuencia de códigos internos. Si la secuencia no existe, Postgres
   * responde 42P01 y el error sube tal cual para que el negocio lo traduzca.
   */
  async siguienteCodigoInterno(): Promise<number> {
    const filas = await this.productoRepo.query(`SELECT nextval('productos_codigo_interno_seq')::bigint AS n`);
    const numero = Number(filas?.[0]?.n);
    if (!Number.isSafeInteger(numero) || numero <= 0) {
      throw new Error(`La secuencia de códigos internos devolvió un número inválido: ${filas?.[0]?.n}`);
    }
    return numero;
  }

  async buscarPorSku(sku: string): Promise<Producto | null> {
    return this.productoRepo.findOne({ where: { sku } });
  }

  /**
   * Productos que ya usan alguno de estos códigos como barras (exacto tras `btrim`) o como SKU
   * (sin distinguir mayúsculas), en UNA consulta. La unicidad del alta y la edición decide en
   * memoria qué choque reportar. `codigos` llega ya recortado y sin vacíos; vacío → no consulta.
   */
  async buscarChoquesDeCodigos(
    codigos: string[],
  ): Promise<Array<{ id_producto: number; nombre: string | null; codigo_barras: string | null; sku: string | null }>> {
    const lista = [...new Set((codigos ?? []).map((c) => String(c ?? '').trim()).filter(Boolean))];
    if (!lista.length) return [];
    // `btrim(p.codigo_barras) <> ''` es el predicado del índice parcial `uq_productos_codigo_barras`:
    // escrito así el planificador puede usarlo; `lower(p.sku)` usa `idx_productos_sku_lower`.
    return this.productoRepo.query(
      `SELECT p.id_producto, p.nombre, p.codigo_barras, p.sku
         FROM productos p
        WHERE (btrim(p.codigo_barras) <> '' AND btrim(p.codigo_barras) = ANY($1::text[]))
           OR lower(p.sku) = ANY($2::text[])
        ORDER BY p.id_producto ASC`,
      [lista, lista.map((c) => c.toLowerCase())],
    );
  }

  /**
   * UPDATE parcial sin leer antes ni después: `true` si el producto existía. Quien llama lee el
   * detalle completo una sola vez al final (antes se leía la entidad dos veces de más).
   */
  async actualizarSiExiste(id: number, cambios: Partial<Producto>): Promise<boolean> {
    const resultado = await this.productoRepo.update(id, cambios as any);
    return (resultado.affected ?? 0) > 0;
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
        p.codigo_sunat,
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
        ORDER BY i.is_primary DESC, COALESCE(i.orden, 0) ASC, i.id_imagen ASC
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
        p.codigo_sunat,
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
        ORDER BY i.is_primary DESC, COALESCE(i.orden, 0) ASC, i.id_imagen ASC
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

  /** Productos activos sin código SUNAT (los primeros `limite`, por categoría y nombre) y el total. */
  async listarSinCodigoSunat(limite = 500): Promise<{ total: number; datos: FilaProductoSinCodigoSunat[] }> {
    const tope = Math.min(Math.max(Math.trunc(Number(limite)) || 500, 1), 5000);
    const datos: FilaProductoSinCodigoSunat[] = await this.productoRepo.query(
      `
      SELECT
        p.id_producto,
        COALESCE(p.nombre, '')          AS nombre,
        COALESCE(p.sku, '')             AS sku,
        COALESCE(p.codigo_barras, '')   AS codigo_barras,
        c.nombre                        AS categoria,
        COALESCE(p.unidad_medida, '')   AS unidad_medida
      FROM productos p
      LEFT JOIN categorias c ON c.id_categoria = p.id_categoria
      WHERE p.codigo_sunat IS NULL AND COALESCE(p.estado, true)
      ORDER BY c.nombre NULLS LAST, p.nombre
      LIMIT $1
      `,
      [tope],
    );
    return { total: await this.contarSinCodigoSunat(), datos };
  }

  /** Cuántos productos activos no tienen código SUNAT. */
  async contarSinCodigoSunat(): Promise<number> {
    const filas = await this.productoRepo.query(
      `SELECT COUNT(*)::int AS total FROM productos p WHERE p.codigo_sunat IS NULL AND COALESCE(p.estado, true)`,
    );
    return Number(filas?.[0]?.total ?? 0);
  }

  /** Asigna el mismo código a varios productos; devuelve los ids que sí existían y se actualizaron. */
  async asignarCodigoSunat(ids: number[], codigo: string): Promise<number[]> {
    if (!ids.length) return [];
    const resultado: unknown = await this.productoRepo.query(
      `UPDATE productos SET codigo_sunat = $2 WHERE id_producto = ANY($1::int[]) RETURNING id_producto`,
      [ids, codigo],
    );
    // En UPDATE ... RETURNING el driver de PostgreSQL entrega [filas, cantidad], no solo las filas.
    const filas = (
      Array.isArray(resultado) && resultado.length === 2 && Array.isArray(resultado[0]) && typeof resultado[1] === 'number'
        ? resultado[0]
        : resultado
    ) as Array<{ id_producto: number }>;
    return filas.map((f) => Number(f.id_producto));
  }

  /** Fase 2.8: nombre de la categoría (null si no existe). */
  async nombreCategoria(idCategoria: number): Promise<string | null> {
    const filas = filasConsulta(await this.productoRepo.query('SELECT nombre FROM categorias WHERE id_categoria = $1', [idCategoria]));
    return filas.length ? String(filas[0].nombre ?? '') : null;
  }

  /** Fase 2.8: el mayor correlativo usado por los SKU con ese prefijo (0 si ninguno). Solo lectura. */
  async mayorCorrelativoSku(prefijo: string): Promise<number> {
    const patron = patronSku(prefijo);
    const filas = filasConsulta(await this.productoRepo.query(
      `SELECT COALESCE(MAX((substring(UPPER(BTRIM(sku)) FROM $1))::bigint), 0) AS mayor
         FROM productos
        WHERE BTRIM(sku) ~* $1`,
      [patron],
    ));
    return Number(filas[0]?.mayor ?? 0);
  }

  /** Fase 2.8: ¿ese texto ya es SKU o código de barras de algún producto? (sin distinguir mayúsculas). */
  async codigoEnUso(codigo: string): Promise<boolean> {
    const filas = filasConsulta(await this.productoRepo.query(
      `SELECT 1 FROM productos
        WHERE LOWER(BTRIM(sku)) = LOWER($1) OR LOWER(BTRIM(codigo_barras)) = LOWER($1)
        LIMIT 1`,
      [codigo],
    ));
    return filas.length > 0;
  }

  /**
   * Fase 9.3: borra el producto SOLO si no tiene historial, en una transacción con la fila bloqueada
   * (`FOR UPDATE`: una venta que quiera usarlo a la vez espera y después falla por la llave foránea).
   * Si tiene historial no borra nada y devuelve el conteo. Si no lo tiene, quita antes sus filas de
   * configuración (inventario en cero, reglas mayoristas, impuestos, proveedores) que de otro modo
   * impedirían el borrado por llave foránea.
   */
  async eliminarSiNoTieneHistorial(id: number): Promise<{ borrados: number; historial: HistorialProducto | null }> {
    return this.productoRepo.manager.transaction(async (manager) => {
      const existe = await manager.query('SELECT id_producto FROM productos WHERE id_producto = $1 FOR UPDATE', [id]);
      if (!filasConsulta(existe).length) return { borrados: 0, historial: null };

      const historial = await contarHistorialProducto(manager, id);
      if (historial.total > 0) return { borrados: 0, historial };

      const tablas = await tablasExistentes(manager, LIMPIEZA_SIN_HISTORIAL);
      for (const tabla of LIMPIEZA_SIN_HISTORIAL) {
        if (!tablas.has(tabla)) continue;
        // Nombres de tabla de una lista fija del código (nunca del usuario).
        await manager.query(`DELETE FROM ${tabla} WHERE id_producto = $1`, [id]);
      }
      const borrado = await manager.query('DELETE FROM productos WHERE id_producto = $1 RETURNING id_producto', [id]);
      return { borrados: filasConsulta(borrado).length, historial };
    });
  }
}

/** Conteo de lo que impide borrar un producto (Fase 9.3). `detalle`: etiqueta → cantidad (solo las > 0). */
export interface HistorialProducto {
  total: number;
  detalle: Record<string, number>;
}

/**
 * Qué cuenta como historial: documentos (ventas, comprobantes, pedidos web, cotizaciones, recepciones,
 * compras, guías), movimientos de stock, stock en existencia y fotos (sus archivos no se borran aquí).
 * Las tablas que no existan en la base se saltan.
 */
const HISTORIAL_PRODUCTO: Array<{ tabla: string; etiqueta: string; condicion?: string }> = [
  { tabla: 'detalle_venta', etiqueta: 'ventas' },
  { tabla: 'comprobante_items', etiqueta: 'comprobantes' },
  { tabla: 'pedido_items', etiqueta: 'pedidos web' },
  { tabla: 'proformas_items', etiqueta: 'cotizaciones' },
  { tabla: 'recepcion_items', etiqueta: 'recepciones' },
  { tabla: 'recepcion_observaciones', etiqueta: 'observaciones de recepción' },
  { tabla: 'detalle_compra', etiqueta: 'compras' },
  { tabla: 'guias_remision_items', etiqueta: 'guías de remisión' },
  { tabla: 'movimientos_inventario', etiqueta: 'movimientos de stock' },
  { tabla: 'kardex', etiqueta: 'kardex' },
  { tabla: 'inventario', etiqueta: 'stock', condicion: 'COALESCE(stock, 0) <> 0' },
  { tabla: 'productos_imagenes', etiqueta: 'fotos' },
];

/** Filas de configuración que se quitan junto con un producto sin historial (todas sin datos de negocio). */
const LIMPIEZA_SIN_HISTORIAL = ['inventario', 'producto_descuento_mayorista', 'producto_impuesto', 'producto_proveedor'];

function filasConsulta(resultado: unknown): any[] {
  if (Array.isArray(resultado) && resultado.length === 2 && Array.isArray(resultado[0]) && typeof resultado[1] === 'number') {
    return resultado[0];
  }
  return Array.isArray(resultado) ? resultado : [];
}

async function tablasExistentes(manager: EntityManager, tablas: string[]): Promise<Set<string>> {
  const filas = await manager.query(
    `SELECT c.relname AS tabla FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND c.relname = ANY($1::text[])`,
    [tablas],
  );
  return new Set(filasConsulta(filas).map((f: any) => String(f.tabla)));
}

export async function contarHistorialProducto(manager: EntityManager, id: number): Promise<HistorialProducto> {
  const tablas = await tablasExistentes(manager, HISTORIAL_PRODUCTO.map((h) => h.tabla));
  const presentes = HISTORIAL_PRODUCTO.filter((h) => tablas.has(h.tabla));
  if (!presentes.length) return { total: 0, detalle: {} };
  // Una sola consulta; cada conteo se corta en 1 000 (basta para el mensaje y no recorre tablas enteras).
  const partes = presentes.map((h, i) =>
    `SELECT ${i} AS i, (SELECT COUNT(*) FROM (SELECT 1 FROM ${h.tabla} WHERE id_producto = $1${h.condicion ? ` AND ${h.condicion}` : ''} LIMIT 1000) x)::int AS n`,
  );
  const filas = filasConsulta(await manager.query(partes.join(' UNION ALL '), [id]));
  const detalle: Record<string, number> = {};
  let total = 0;
  for (const f of filas) {
    const n = Number(f.n ?? 0);
    if (n > 0) {
      const etiqueta = presentes[Number(f.i)].etiqueta;
      detalle[etiqueta] = (detalle[etiqueta] ?? 0) + n;
      total += n;
    }
  }
  return { total, detalle };
}

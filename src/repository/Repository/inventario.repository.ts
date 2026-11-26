import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { Repository, DataSource, EntityManager } from 'typeorm';
import { Inventario } from '../../models/DBModel/inventario.entity';
import { CrudRepository } from '../Irepository/GenericIRepository/crud.Irepository';
import { reintentarSiHuboConflicto } from '../../util/reintento-bd';
import { patronContiene } from './venta-documentos.repository';
import { EsquemaCajaService } from '../../caja/esquema/esquema-caja.service';
import {
  columnasRastro, extrasFila, RastroMovimiento, sufijo, TipoDocumentoMovimiento,
} from '../../stock/rastro-movimiento';

export interface FiltroInventario {
  texto?: string;
  id_almacen?: number;
  id_categoria?: number;
  /** Solo las filas de ese producto (la edición de producto lo usa para leer su stock). */
  id_producto?: number;
  solo_alertas?: boolean;
  pagina?: number;
  por_pagina?: number;
}

/** Máximo de la columna `inventario.stock` (integer de PostgreSQL). */
export const STOCK_MAXIMO_BD = 2_147_483_647;

/** Stock de un producto en un almacén (ficha de edición). Todos los almacenes salen, con o sin fila. */
export interface StockPorAlmacen {
  id_almacen: number;
  almacen: string;
  sucursal: string;
  stock: number;
  /** false = el producto todavía no tiene fila de inventario en ese almacén. */
  registrado: boolean;
}

/** Un movimiento de stock del producto con su rastro (8.1). Sin fase21 los campos de rastro van en null. */
export interface MovimientoConRastro {
  id_movimiento: number;
  fecha: string;
  tipo: string;
  cantidad: number;
  descripcion: string;
  sucursal_origen: string;
  sucursal_destino: string;
  id_usuario: number | null;
  usuario: string | null;
  id_almacen: number | null;
  almacen: string | null;
  tipo_documento: TipoDocumentoMovimiento | null;
  id_documento: number | null;
}

export interface PaginaMovimientos {
  datos: MovimientoConRastro[];
  pagina: number;
  por_pagina: number;
  /** true si hay al menos una página más (se lee una fila de más en vez de contar). */
  hay_mas: boolean;
  /** Qué columnas de rastro existen (false mientras falte sql/fase21). */
  rastro: { usuario: boolean; almacen: boolean; documento: boolean };
}

export interface FilaInventario {
  id_inventario: number;
  id_producto: number;
  producto: string;
  sku: string;
  codigo_barras: string;
  unidad_medida: string;
  categoria: string;
  id_almacen: number;
  almacen: string;
  sucursal: string;
  stock: number;
  stock_minimo: number;
  precio_compra: number;
  precio_venta: number;
  valorizado: number;
  estado: 'sin_stock' | 'bajo' | 'ok';
  imagen_url: string;
}

@Injectable()
export class InventarioRepository extends CrudRepository<Inventario> implements OnModuleInit {

  private readonly log = new Logger(InventarioRepository.name);

  constructor(
    @InjectRepository(Inventario, 'pgConnection')
    private readonly inventarioRepo: Repository<Inventario>,

    @InjectDataSource('pgConnection')
    private readonly dataSource: DataSource,

    /** Fase 8.1 (fase21): columnas de rastro del movimiento. Sin él (pruebas antiguas) se guarda como antes. */
    @Optional() private readonly esquema?: EsquemaCajaService,
  ) {
    super(inventarioRepo);
  }

  /**
   * En producción `movimientos_inventario.tipo` es el enum tipo_movimiento_inv
   * (entrada, salida, ajuste) y no admitía 'transferencia': toda transferencia
   * entre almacenes fallaba. Se agrega el valor (idempotente, igual que
   * sql/fase8_correcciones_esquema.sql). Si la columna no es un enum en otra
   * base, el ALTER falla y solo queda el aviso.
   */
  async onModuleInit(): Promise<void> {
    try {
      await this.dataSource.query(
        `ALTER TYPE tipo_movimiento_inv ADD VALUE IF NOT EXISTS 'transferencia'`,
      );
    } catch (error: any) {
      this.log.warn(`No se pudo asegurar el tipo 'transferencia' del kardex: ${error?.message ?? error}`);
    }
  }

  // ── Compatibilidad con el comportamiento anterior ────────────

  buscarPorProducto(id_producto: number): Promise<Inventario | null> {
    return this.inventarioRepo.findOne({
      where: { producto: { id_producto } as any },
      relations: ['producto'],
    });
  }

  async guardarOActualizar(inventario: Partial<Inventario>): Promise<Inventario> {
    const idProducto = inventario.producto?.id_producto;
    const idAlmacen = (inventario as any).almacen?.id_almacen;

    const existe = idProducto
      ? await this.inventarioRepo.findOne({
          where: idAlmacen
            ? ({ producto: { id_producto: idProducto }, almacen: { id_almacen: idAlmacen } } as any)
            : ({ producto: { id_producto: idProducto } } as any),
          relations: ['producto'],
        })
      : null;

    if (existe) {
      await this.inventarioRepo.update(existe.id_inventario, inventario as any);
      return this.inventarioRepo.findOne({
        where: { id_inventario: existe.id_inventario },
        relations: ['producto'],
      }) as Promise<Inventario>;
    }

    return this.inventarioRepo.save(this.inventarioRepo.create(inventario));
  }

  listarTodos(): Promise<Inventario[]> {
    return this.inventarioRepo.find({ relations: ['producto'], order: { id_inventario: 'ASC' } });
  }

  // ── Vista enriquecida para el panel ──────────────────────────

  /**
   * Inventario con nombre de producto, almacén, sucursal y el estado calculado
   * contra el stock mínimo. Todo en una consulta, en vez de completar los datos
   * desde el navegador.
   */
  async listarDetallado(filtro: FiltroInventario): Promise<{ datos: FilaInventario[]; total: number; pagina: number; por_pagina: number }> {
    const pagina = Math.max(1, Number(filtro.pagina) || 1);
    const porPagina = Math.min(200, Math.max(1, Number(filtro.por_pagina) || 50));

    const condiciones: string[] = ['1 = 1'];
    const parametros: any[] = [];

    if (filtro.texto?.trim()) {
      // `%`, `_` y `\` del usuario se buscan tal cual, no como comodines.
      parametros.push(patronContiene(filtro.texto.trim().toLowerCase()));
      condiciones.push(
        `(LOWER(p.nombre) LIKE $${parametros.length} ESCAPE '\\'
          OR LOWER(COALESCE(p.sku, '')) LIKE $${parametros.length} ESCAPE '\\'
          OR LOWER(COALESCE(p.codigo_barras, '')) LIKE $${parametros.length} ESCAPE '\\')`,
      );
    }
    if (filtro.id_almacen) {
      parametros.push(filtro.id_almacen);
      condiciones.push(`i.id_almacen = $${parametros.length}`);
    }
    if (filtro.id_categoria) {
      parametros.push(filtro.id_categoria);
      condiciones.push(`p.id_categoria = $${parametros.length}`);
    }
    if (filtro.id_producto) {
      parametros.push(filtro.id_producto);
      condiciones.push(`i.id_producto = $${parametros.length}`);
    }
    if (filtro.solo_alertas) {
      condiciones.push('COALESCE(i.stock, 0) <= COALESCE(i.stock_minimo, 0)');
    }

    const donde = condiciones.join(' AND ');

    // El conteo solo necesita inventario y productos: los filtros usan i.* y p.* (la
    // categoría filtra por p.id_categoria). Antes contaba con todos los JOIN y con el
    // LATERAL de la imagen evaluado para cada fila del inventario.
    const sqlConteo = `
      SELECT COUNT(*)::int AS total
        FROM inventario i
        JOIN productos p ON p.id_producto = i.id_producto
       WHERE ${donde}`;

    // Primero se ordena y se corta la página; la imagen se busca después y solo para esas
    // filas (antes el LATERAL corría para todo el inventario). `alerta` sale como columna
    // para repetir el mismo orden afuera; id_inventario desempata (páginas estables).
    const sqlFilas = `
      SELECT b.*, COALESCE(img.url, '') AS imagen_url
        FROM (
          SELECT i.id_inventario,
                 i.id_producto,
                 p.nombre                          AS producto,
                 COALESCE(p.sku, '')               AS sku,
                 COALESCE(p.codigo_barras, '')     AS codigo_barras,
                 COALESCE(p.unidad_medida, 'NIU')  AS unidad_medida,
                 COALESCE(cat.nombre, '')          AS categoria,
                 i.id_almacen,
                 COALESCE(a.nombre, 'Sin almacén') AS almacen,
                 COALESCE(s.nombre, '')            AS sucursal,
                 COALESCE(i.stock, 0)              AS stock,
                 COALESCE(i.stock_minimo, 0)       AS stock_minimo,
                 COALESCE(p.precio_compra, 0)      AS precio_compra,
                 COALESCE(p.precio_venta, 0)       AS precio_venta,
                 (COALESCE(i.stock, 0) <= COALESCE(i.stock_minimo, 0)) AS alerta
            FROM inventario i
            JOIN productos p ON p.id_producto = i.id_producto
            LEFT JOIN almacenes a ON a.id_almacen = i.id_almacen
            LEFT JOIN sucursales s ON s.id_sucursal = a.id_sucursal
            LEFT JOIN categorias cat ON cat.id_categoria = p.id_categoria
           WHERE ${donde}
           ORDER BY alerta DESC, p.nombre ASC, i.id_inventario ASC
           LIMIT $${parametros.length + 1} OFFSET $${parametros.length + 2}
        ) b
        LEFT JOIN LATERAL (
               SELECT pi.url
                 FROM productos_imagenes pi
                WHERE pi.id_producto = b.id_producto
                ORDER BY pi.is_primary DESC NULLS LAST,
                         COALESCE(pi.orden, 0) ASC,
                         pi.id_imagen ASC
                LIMIT 1
             ) img ON TRUE
       ORDER BY b.alerta DESC, b.producto ASC, b.id_inventario ASC`;

    const [totales, filas] = await Promise.all([
      this.dataSource.query(sqlConteo, parametros),
      this.dataSource.query(sqlFilas, [...parametros, porPagina, (pagina - 1) * porPagina]),
    ]);

    return {
      datos: filas.map((f: any) => this.mapFila(f)),
      total: totales[0]?.total ?? 0,
      pagina,
      por_pagina: porPagina,
    };
  }

  private mapFila(f: any): FilaInventario {
    const stock = Number(f.stock ?? 0);
    const minimo = Number(f.stock_minimo ?? 0);
    const precioCompra = Number(f.precio_compra ?? 0);

    return {
      id_inventario: Number(f.id_inventario),
      id_producto: Number(f.id_producto),
      producto: f.producto,
      sku: f.sku,
      codigo_barras: f.codigo_barras,
      unidad_medida: f.unidad_medida,
      categoria: f.categoria,
      id_almacen: Number(f.id_almacen),
      almacen: f.almacen,
      sucursal: f.sucursal,
      stock,
      stock_minimo: minimo,
      precio_compra: precioCompra,
      precio_venta: Number(f.precio_venta ?? 0),
      valorizado: Math.round((stock * precioCompra + Number.EPSILON) * 100) / 100,
      estado: stock <= 0 ? 'sin_stock' : stock <= minimo ? 'bajo' : 'ok',
      imagen_url: f.imagen_url,
    };
  }

  /** Cifras de cabecera: cuántos productos, cuántos en alerta y cuánto vale todo. */
  async resumen(): Promise<{ productos: number; sin_stock: number; bajo_stock: number; valorizado: number; unidades: number }> {
    const filas = await this.dataSource.query(
      `SELECT COUNT(DISTINCT i.id_producto)::int                                            AS productos,
              COUNT(*) FILTER (WHERE COALESCE(i.stock, 0) <= 0)::int                        AS sin_stock,
              COUNT(*) FILTER (WHERE COALESCE(i.stock, 0) > 0
                                 AND COALESCE(i.stock, 0) <= COALESCE(i.stock_minimo, 0))::int AS bajo_stock,
              COALESCE(SUM(COALESCE(i.stock, 0) * COALESCE(p.precio_compra, 0)), 0)         AS valorizado,
              COALESCE(SUM(COALESCE(i.stock, 0)), 0)                                        AS unidades
         FROM inventario i
         JOIN productos p ON p.id_producto = i.id_producto`,
    );

    const f = filas[0] ?? {};
    return {
      productos: Number(f.productos ?? 0),
      sin_stock: Number(f.sin_stock ?? 0),
      bajo_stock: Number(f.bajo_stock ?? 0),
      valorizado: Number(f.valorizado ?? 0),
      unidades: Number(f.unidades ?? 0),
    };
  }

  async almacenes(): Promise<{ id_almacen: number; nombre: string; sucursal: string }[]> {
    return this.dataSource.query(
      `SELECT a.id_almacen, a.nombre, COALESCE(s.nombre, '') AS sucursal
         FROM almacenes a
         LEFT JOIN sucursales s ON s.id_sucursal = a.id_sucursal
        ORDER BY a.nombre`,
    );
  }

  /**
   * Stock del producto en cada almacén, en una consulta. La ficha de edición lo pide una vez y
   * cambia de almacén sin volver a la red (antes usaba `listarDetallado`: conteo + filas con
   * cinco JOIN para traer una fila, y otra petición por cada cambio de almacén).
   */
  async stockPorProducto(idProducto: number): Promise<StockPorAlmacen[]> {
    const filas = await this.dataSource.query(
      `SELECT a.id_almacen, a.nombre AS almacen, COALESCE(s.nombre, '') AS sucursal,
              COALESCE(i.stock, 0)::int AS stock, (i.id_inventario IS NOT NULL) AS registrado
         FROM almacenes a
         LEFT JOIN sucursales s ON s.id_sucursal = a.id_sucursal
         LEFT JOIN inventario i ON i.id_almacen = a.id_almacen AND i.id_producto = $1
        ORDER BY a.nombre`,
      [idProducto],
    );
    return filas.map((f: any) => ({
      id_almacen: Number(f.id_almacen),
      almacen: f.almacen ?? '',
      sucursal: f.sucursal ?? '',
      stock: Number(f.stock ?? 0),
      registrado: f.registrado === true || f.registrado === 't',
    }));
  }

  /** Últimos movimientos, para la pestaña de historial. */
  async movimientos(idProducto?: number, limite = 50): Promise<any[]> {
    const condicion = idProducto ? 'WHERE m.id_producto = $1' : '';
    const parametros = idProducto ? [idProducto, limite] : [limite];

    return this.dataSource.query(
      `SELECT m.id_movimiento, m.id_producto, p.nombre AS producto, m.tipo, m.cantidad,
              m.descripcion, m.fecha,
              COALESCE(so.nombre, '') AS sucursal_origen,
              COALESCE(sd.nombre, '') AS sucursal_destino
         FROM movimientos_inventario m
         LEFT JOIN productos p ON p.id_producto = m.id_producto
         LEFT JOIN sucursales so ON so.id_sucursal = m.id_sucursal_origen
         LEFT JOIN sucursales sd ON sd.id_sucursal = m.id_sucursal_destino
         ${condicion}
        ORDER BY m.fecha DESC
        LIMIT $${parametros.length}`,
      parametros,
    );
  }

  /**
   * Historial de movimientos de UN producto con quién, cuándo, dónde y por qué (8.1), paginado por
   * número de página (se lee una fila de más para saber si hay otra página, sin COUNT). Sin las columnas
   * de fase21 los campos de rastro salen en null. Usa ix_movimientos_inventario_producto (id_producto, fecha).
   */
  async movimientosDeProducto(
    idProducto: number,
    opciones: { pagina?: number; por_pagina?: number; id_almacen?: number } = {},
  ): Promise<PaginaMovimientos> {
    const pagina = Math.max(1, Math.trunc(Number(opciones.pagina)) || 1);
    const porPagina = Math.min(100, Math.max(1, Math.trunc(Number(opciones.por_pagina)) || 30));
    const columnas = await columnasRastro(this.esquema);

    const parametros: unknown[] = [idProducto];
    let filtroAlmacen = '';
    const idAlmacen = Number(opciones.id_almacen);
    if (columnas.almacen && Number.isSafeInteger(idAlmacen) && idAlmacen > 0) {
      parametros.push(idAlmacen);
      filtroAlmacen = `AND m.id_almacen = $${parametros.length}`;
    }
    parametros.push(porPagina + 1, (pagina - 1) * porPagina);

    // Fragmentos fijos del código según el catálogo (nunca texto del usuario).
    const filas: any[] = await this.dataSource.query(
      `SELECT m.id_movimiento, m.fecha, m.tipo::text AS tipo, m.cantidad, COALESCE(m.descripcion, '') AS descripcion,
              COALESCE(so.nombre, '') AS sucursal_origen,
              COALESCE(sd.nombre, '') AS sucursal_destino,
              ${columnas.usuario ? 'm.id_usuario, u.nombre AS usuario' : 'NULL::int AS id_usuario, NULL::text AS usuario'},
              ${columnas.almacen ? 'm.id_almacen, al.nombre AS almacen' : 'NULL::int AS id_almacen, NULL::text AS almacen'},
              ${columnas.documento ? 'm.tipo_documento, m.id_documento' : 'NULL::text AS tipo_documento, NULL::int AS id_documento'}
         FROM movimientos_inventario m
         LEFT JOIN sucursales so ON so.id_sucursal = m.id_sucursal_origen
         LEFT JOIN sucursales sd ON sd.id_sucursal = m.id_sucursal_destino
         ${columnas.usuario ? 'LEFT JOIN usuarios u ON u.id_usuario = m.id_usuario' : ''}
         ${columnas.almacen ? 'LEFT JOIN almacenes al ON al.id_almacen = m.id_almacen' : ''}
        WHERE m.id_producto = $1 ${filtroAlmacen}
        ORDER BY m.fecha DESC, m.id_movimiento DESC
        LIMIT $${parametros.length - 1} OFFSET $${parametros.length}`,
      parametros,
    );

    const hayMas = filas.length > porPagina;
    const entero = (v: unknown) => (v === null || v === undefined ? null : Number(v));
    return {
      datos: filas.slice(0, porPagina).map((f) => ({
        id_movimiento: Number(f.id_movimiento),
        fecha: f.fecha,
        tipo: String(f.tipo ?? ''),
        cantidad: Number(f.cantidad ?? 0),
        descripcion: f.descripcion ?? '',
        sucursal_origen: f.sucursal_origen ?? '',
        sucursal_destino: f.sucursal_destino ?? '',
        id_usuario: entero(f.id_usuario),
        usuario: f.usuario ?? null,
        id_almacen: entero(f.id_almacen),
        almacen: f.almacen ?? null,
        tipo_documento: f.tipo_documento ?? null,
        id_documento: entero(f.id_documento),
      })),
      pagina,
      por_pagina: porPagina,
      hay_mas: hayMas,
      rastro: { ...columnas },
    };
  }

  // ── Operaciones con rastro ───────────────────────────────────

  /**
   * Suma o resta unidades dejando constancia del motivo en el kardex.
   * Crea la fila de inventario si el producto todavía no está en ese almacén.
   *
   * `stockEsperado`: el stock que vio quien pide el ajuste (la ficha de edición). Si el real,
   * ya bloqueado con FOR UPDATE, es otro, lanza `STOCK_DESACTUALIZADO:<actual>` sin escribir
   * nada: así una venta entre medio o un reintento no terminan en un doble ajuste.
   */
  async ajustar(
    idProducto: number,
    idAlmacen: number,
    cantidad: number,
    descripcion: string,
    manager?: EntityManager,
    stockEsperado?: number,
    /** Fase 8.1: quién y por qué documento (solo se escribe con las columnas de fase21). */
    rastro?: RastroMovimiento,
  ): Promise<number> {
    // Con `manager` el ajuste entra en la transacción de quien llama (alta de
    // producto con stock inicial); sin él abre la suya.
    if (manager) return this.ajustarCon(manager, idProducto, idAlmacen, cantidad, descripcion, stockEsperado, rastro);
    // Solo la transacción propia se repite tras un interbloqueo: la de quien llama ya quedó abortada.
    return reintentarSiHuboConflicto(() => this.dataSource.transaction((m) =>
      this.ajustarCon(m, idProducto, idAlmacen, cantidad, descripcion, stockEsperado, rastro),
    ), { operacion: 'Ajustar stock' });
  }

  private async ajustarCon(
    manager: EntityManager,
    idProducto: number,
    idAlmacen: number,
    cantidad: number,
    descripcion: string,
    stockEsperado?: number,
    rastro?: RastroMovimiento,
  ): Promise<number> {
    const filas = await manager.query(
      'SELECT id_inventario, stock FROM inventario WHERE id_producto = $1 AND id_almacen = $2 FOR UPDATE',
      [idProducto, idAlmacen],
    );

    if (stockEsperado !== undefined && stockEsperado !== null) {
      const actual = filas.length ? Number(filas[0].stock ?? 0) : 0;
      if (actual !== Number(stockEsperado)) throw new Error(`STOCK_DESACTUALIZADO:${actual}`);
    }

    let stockFinal: number;

    if (filas.length) {
      stockFinal = Number(filas[0].stock ?? 0) + cantidad;
      if (stockFinal < 0) {
        throw new Error(`STOCK_NEGATIVO:${Number(filas[0].stock ?? 0)}`);
      }
      if (stockFinal > STOCK_MAXIMO_BD) throw new Error(`STOCK_FUERA_DE_RANGO:${STOCK_MAXIMO_BD}`);
      await manager.query('UPDATE inventario SET stock = $1 WHERE id_inventario = $2', [
        stockFinal,
        filas[0].id_inventario,
      ]);
    } else {
      if (cantidad < 0) throw new Error('STOCK_NEGATIVO:0');
      if (cantidad > STOCK_MAXIMO_BD) throw new Error(`STOCK_FUERA_DE_RANGO:${STOCK_MAXIMO_BD}`);
      stockFinal = cantidad;
      await manager.query(
        'INSERT INTO inventario (id_producto, id_almacen, stock, stock_minimo) VALUES ($1, $2, $3, 0)',
        [idProducto, idAlmacen, cantidad],
      );
    }

    await this.registrarMovimiento(
      manager,
      idProducto,
      idAlmacen,
      Math.abs(cantidad),
      cantidad >= 0 ? 'entrada' : 'salida',
      descripcion,
      rastro,
    );

    return stockFinal;
  }

  /**
   * Fila del producto en el almacén con stock 0 (sin movimiento en el kardex). Solo el INSERT:
   * la usa el alta, donde el producto nació en esta misma transacción y no puede tener fila
   * todavía (antes se consultaba primero si existía: un viaje de más).
   */
  async insertarFilaVacia(manager: EntityManager, idProducto: number, idAlmacen: number): Promise<void> {
    await manager.query(
      'INSERT INTO inventario (id_producto, id_almacen, stock, stock_minimo) VALUES ($1, $2, 0, 0)',
      [idProducto, idAlmacen],
    );
  }

  async existeAlmacen(idAlmacen: number): Promise<boolean> {
    const filas = await this.dataSource.query('SELECT 1 FROM almacenes WHERE id_almacen = $1 LIMIT 1', [idAlmacen]);
    return filas.length > 0;
  }

  /**
   * Mueve stock entre dos almacenes. Las dos filas se bloquean en UNA sentencia y en orden fijo
   * (id_almacen, id_inventario): dos transferencias opuestas del mismo producto (A→B y B→A) ya no
   * se interbloquean. `stockOrigenEsperado`: el stock de origen que vio quien transfiere; si el
   * real es otro, `STOCK_DESACTUALIZADO:<actual>` sin escribir nada (doble envío o venta entre medio).
   */
  async transferir(
    idProducto: number,
    idOrigen: number,
    idDestino: number,
    cantidad: number,
    descripcion: string,
    stockOrigenEsperado?: number,
    /** Fase 8.1: quién transfiere (el tipo es siempre `transferencia`; el almacén guardado es el de origen). */
    rastro?: RastroMovimiento,
  ): Promise<void> {
    const columnas = await columnasRastro(this.esquema);
    await reintentarSiHuboConflicto(() => this.dataSource.transaction(async (manager) => {
      const bloqueadas: { id_inventario: unknown; id_almacen: unknown; stock: unknown }[] = await manager.query(
        `SELECT id_inventario, id_almacen, stock
           FROM inventario
          WHERE id_producto = $1 AND id_almacen = ANY($2::int[])
          ORDER BY id_almacen, id_inventario
            FOR UPDATE`,
        [idProducto, [idOrigen, idDestino]],
      );
      const origen = bloqueadas.filter((f) => Number(f.id_almacen) === Number(idOrigen));
      const destino = bloqueadas.filter((f) => Number(f.id_almacen) === Number(idDestino));

      const disponible = Number(origen[0]?.stock ?? 0);
      if (stockOrigenEsperado !== undefined && stockOrigenEsperado !== null
        && Math.round(disponible * 1000) !== Math.round(Number(stockOrigenEsperado) * 1000)) {
        throw new Error(`STOCK_DESACTUALIZADO:${disponible}`);
      }
      if (disponible < cantidad) throw new Error(`STOCK_INSUFICIENTE:${disponible}`);

      await manager.query('UPDATE inventario SET stock = stock - $1 WHERE id_inventario = $2', [
        cantidad,
        origen[0].id_inventario,
      ]);

      if (Number(destino[0]?.stock ?? 0) + cantidad > STOCK_MAXIMO_BD) {
        throw new Error(`STOCK_FUERA_DE_RANGO:${STOCK_MAXIMO_BD}`);
      }

      if (destino.length) {
        await manager.query('UPDATE inventario SET stock = stock + $1 WHERE id_inventario = $2', [
          cantidad,
          destino[0].id_inventario,
        ]);
      } else {
        await manager.query(
          'INSERT INTO inventario (id_producto, id_almacen, stock, stock_minimo) VALUES ($1, $2, $3, 0)',
          [idProducto, idDestino, cantidad],
        );
      }

      const sucursales = await manager.query(
        'SELECT id_almacen, id_sucursal FROM almacenes WHERE id_almacen = ANY($1)',
        [[idOrigen, idDestino]],
      );
      const mapa = new Map(sucursales.map((s: any) => [Number(s.id_almacen), s.id_sucursal]));

      const extras = extrasFila(columnas, { ...rastro, tipo_documento: 'transferencia', id_documento: null }, idOrigen, 6);
      await manager.query(
        `INSERT INTO movimientos_inventario
           (id_producto, tipo, cantidad, id_sucursal_origen, id_sucursal_destino, descripcion, fecha${sufijo(extras.columnas)})
         VALUES ($1, 'transferencia', $2, $3, $4, $5, NOW()${sufijo(extras.expresiones)})`,
        [idProducto, cantidad, mapa.get(idOrigen) ?? null, mapa.get(idDestino) ?? null, descripcion, ...extras.valores],
      );

      // Kardex (misma TX): no duplicar movimientos_inventario (ya hay fila transferencia)
      await manager.query(
        `INSERT INTO kardex (id_producto, tipo_movimiento, cantidad, costo, fecha)
         SELECT $1, 'salida', $2, COALESCE(p.precio_compra, 0), NOW()
           FROM productos p WHERE p.id_producto = $1`,
        [idProducto, cantidad],
      );
      await manager.query(
        `INSERT INTO kardex (id_producto, tipo_movimiento, cantidad, costo, fecha)
         SELECT $1, 'entrada', $2, COALESCE(p.precio_compra, 0), NOW()
           FROM productos p WHERE p.id_producto = $1`,
        [idProducto, cantidad],
      );
    }), { operacion: 'Transferir stock' });
  }

  async fijarStockMinimo(idInventario: number, minimo: number): Promise<void> {
    await this.inventarioRepo.update(idInventario, { stock_minimo: minimo });
  }

  private async registrarMovimiento(
    manager: EntityManager,
    idProducto: number,
    idAlmacen: number,
    cantidad: number,
    tipo: 'entrada' | 'salida',
    descripcion: string,
    rastro?: RastroMovimiento,
  ): Promise<void> {
    const columnas = await columnasRastro(this.esquema);
    const extras = extrasFila(columnas, rastro, idAlmacen, 7);
    const sucursal = await manager.query(
      'SELECT id_sucursal FROM almacenes WHERE id_almacen = $1 LIMIT 1',
      [idAlmacen],
    );
    const idSucursal = sucursal[0]?.id_sucursal ?? null;

    await manager.query(
      `INSERT INTO movimientos_inventario
         (id_producto, tipo, cantidad, id_sucursal_origen, id_sucursal_destino, descripcion, fecha${sufijo(extras.columnas)})
       VALUES ($1, $2, $3, $4, $5, $6, NOW()${sufijo(extras.expresiones)})`,
      [
        idProducto,
        tipo,
        cantidad,
        tipo === 'salida' ? idSucursal : null,
        tipo === 'entrada' ? idSucursal : null,
        descripcion,
        ...extras.valores,
      ],
    );

    await manager.query(
      `INSERT INTO kardex (id_producto, tipo_movimiento, cantidad, costo, fecha)
       SELECT $1, $2, $3, COALESCE(p.precio_compra, 0), NOW()
         FROM productos p WHERE p.id_producto = $1`,
      [idProducto, tipo, cantidad],
    );
  }
}

import { Injectable } from '@nestjs/common';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { Repository, DataSource, EntityManager } from 'typeorm';
import { Inventario } from '../../models/DBModel/inventario.entity';
import { CrudRepository } from '../Irepository/GenericIRepository/crud.Irepository';

export interface FiltroInventario {
  texto?: string;
  id_almacen?: number;
  id_categoria?: number;
  solo_alertas?: boolean;
  pagina?: number;
  por_pagina?: number;
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
export class InventarioRepository extends CrudRepository<Inventario> {

  constructor(
    @InjectRepository(Inventario, 'pgConnection')
    private readonly inventarioRepo: Repository<Inventario>,

    @InjectDataSource('pgConnection')
    private readonly dataSource: DataSource,
  ) {
    super(inventarioRepo);
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
      parametros.push(`%${filtro.texto.trim().toLowerCase()}%`);
      condiciones.push(
        `(LOWER(p.nombre) LIKE $${parametros.length}
          OR LOWER(COALESCE(p.sku, '')) LIKE $${parametros.length}
          OR LOWER(COALESCE(p.codigo_barras, '')) LIKE $${parametros.length})`,
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
    if (filtro.solo_alertas) {
      condiciones.push('COALESCE(i.stock, 0) <= COALESCE(i.stock_minimo, 0)');
    }

    const donde = condiciones.join(' AND ');

    const base = `
      FROM inventario i
      JOIN productos p ON p.id_producto = i.id_producto
      LEFT JOIN almacenes a ON a.id_almacen = i.id_almacen
      LEFT JOIN sucursales s ON s.id_sucursal = a.id_sucursal
      LEFT JOIN categorias cat ON cat.id_categoria = p.id_categoria
      WHERE ${donde}`;

    const totales = await this.dataSource.query(`SELECT COUNT(*)::int AS total ${base}`, parametros);

    parametros.push(porPagina, (pagina - 1) * porPagina);

    const filas = await this.dataSource.query(
      `SELECT i.id_inventario,
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
              COALESCE(img.url, '')             AS imagen_url
         ${base}
         LEFT JOIN LATERAL (
                SELECT pi.url FROM productos_imagenes pi
                 WHERE pi.id_producto = p.id_producto
                 ORDER BY pi.is_primary DESC NULLS LAST, pi.orden ASC NULLS LAST
                 LIMIT 1
              ) img ON TRUE
        ORDER BY (COALESCE(i.stock, 0) <= COALESCE(i.stock_minimo, 0)) DESC, p.nombre ASC
        LIMIT $${parametros.length - 1} OFFSET $${parametros.length}`,
      parametros,
    );

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

  // ── Operaciones con rastro ───────────────────────────────────

  /**
   * Suma o resta unidades dejando constancia del motivo en el kardex.
   * Crea la fila de inventario si el producto todavía no está en ese almacén.
   */
  async ajustar(
    idProducto: number,
    idAlmacen: number,
    cantidad: number,
    descripcion: string,
  ): Promise<number> {
    return this.dataSource.transaction(async (manager) => {
      const filas = await manager.query(
        'SELECT id_inventario, stock FROM inventario WHERE id_producto = $1 AND id_almacen = $2 FOR UPDATE',
        [idProducto, idAlmacen],
      );

      let stockFinal: number;

      if (filas.length) {
        stockFinal = Number(filas[0].stock ?? 0) + cantidad;
        if (stockFinal < 0) {
          throw new Error(`STOCK_NEGATIVO:${Number(filas[0].stock ?? 0)}`);
        }
        await manager.query('UPDATE inventario SET stock = $1 WHERE id_inventario = $2', [
          stockFinal,
          filas[0].id_inventario,
        ]);
      } else {
        if (cantidad < 0) throw new Error('STOCK_NEGATIVO:0');
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
      );

      return stockFinal;
    });
  }

  async transferir(
    idProducto: number,
    idOrigen: number,
    idDestino: number,
    cantidad: number,
    descripcion: string,
  ): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const origen = await manager.query(
        'SELECT id_inventario, stock FROM inventario WHERE id_producto = $1 AND id_almacen = $2 FOR UPDATE',
        [idProducto, idOrigen],
      );

      const disponible = Number(origen[0]?.stock ?? 0);
      if (disponible < cantidad) throw new Error(`STOCK_INSUFICIENTE:${disponible}`);

      await manager.query('UPDATE inventario SET stock = stock - $1 WHERE id_inventario = $2', [
        cantidad,
        origen[0].id_inventario,
      ]);

      const destino = await manager.query(
        'SELECT id_inventario FROM inventario WHERE id_producto = $1 AND id_almacen = $2 FOR UPDATE',
        [idProducto, idDestino],
      );

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

      await manager.query(
        `INSERT INTO movimientos_inventario
           (id_producto, tipo, cantidad, id_sucursal_origen, id_sucursal_destino, descripcion, fecha)
         VALUES ($1, 'transferencia', $2, $3, $4, $5, NOW())`,
        [idProducto, cantidad, mapa.get(idOrigen) ?? null, mapa.get(idDestino) ?? null, descripcion],
      );
    });
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
  ): Promise<void> {
    const sucursal = await manager.query(
      'SELECT id_sucursal FROM almacenes WHERE id_almacen = $1 LIMIT 1',
      [idAlmacen],
    );
    const idSucursal = sucursal[0]?.id_sucursal ?? null;

    await manager.query(
      `INSERT INTO movimientos_inventario
         (id_producto, tipo, cantidad, id_sucursal_origen, id_sucursal_destino, descripcion, fecha)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
      [
        idProducto,
        tipo,
        cantidad,
        tipo === 'salida' ? idSucursal : null,
        tipo === 'entrada' ? idSucursal : null,
        descripcion,
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

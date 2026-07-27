import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { ProductoVentaResponse } from '../../models/model/venta/venta.response';

export interface LineaVentaPersistida {
  id_producto: number;
  descripcion: string;
  cantidad: number;
  precio_unitario: number;
  descuento: number;
  subtotal: number;
  igv: number;
  total: number;
}

export interface DatosVenta {
  id_cliente?: number;
  id_caja?: number;
  id_usuario?: number;
  subtotal: number;
  igv: number;
  descuento: number;
  total: number;
  origen: string;
  clave_idempotencia?: string;
  observaciones?: string;
}

export interface FiltroVentas {
  texto?: string;
  desde?: string;
  hasta?: string;
  origen?: string;
  pagina?: number;
  por_pagina?: number;
}

/**
 * Acceso a `ventas`, `detalle_venta` y `venta_pago`.
 *
 * Se usa SQL directo porque son tablas del núcleo transaccional que no tienen
 * entidad TypeORM, igual que hace el módulo de tienda.
 */
@Injectable()
export class VentaRepository {

  private readonly log = new Logger(VentaRepository.name);

  constructor(
    @InjectDataSource('pgConnection')
    private readonly dataSource: DataSource,
  ) {}

  // ── Búsqueda de productos para el mostrador ──────────────────

  /**
   * Autocompletado del punto de venta. Busca por nombre, SKU o código de
   * barras y trae el stock sumado de todos los almacenes.
   */
  async buscarProductos(termino: string, limite = 12): Promise<ProductoVentaResponse[]> {
    const texto = (termino ?? '').trim();
    if (texto.length < 1) return [];

    const filas = await this.dataSource.query(
      `SELECT p.id_producto,
              p.nombre,
              COALESCE(p.sku, '')            AS sku,
              COALESCE(p.codigo_barras, '')  AS codigo_barras,
              COALESCE(p.unidad_medida, '')  AS unidad_medida,
              COALESCE(p.precio_venta, 0)    AS precio_venta,
              COALESCE(p.descuento, 0)       AS descuento,
              COALESCE(inv.stock, 0)         AS stock_disponible,
              COALESCE(img.url, '')          AS imagen_url
         FROM productos p
         LEFT JOIN LATERAL (
                SELECT SUM(i.stock) AS stock FROM inventario i WHERE i.id_producto = p.id_producto
              ) inv ON TRUE
         LEFT JOIN LATERAL (
                SELECT pi.url FROM productos_imagenes pi
                 WHERE pi.id_producto = p.id_producto
                 ORDER BY pi.is_primary DESC NULLS LAST, pi.orden ASC NULLS LAST
                 LIMIT 1
              ) img ON TRUE
        WHERE COALESCE(p.estado, TRUE) = TRUE
          AND (
                LOWER(p.nombre) LIKE $1
             OR LOWER(COALESCE(p.sku, '')) LIKE $1
             OR COALESCE(p.codigo_barras, '') LIKE $2
          )
        ORDER BY (COALESCE(p.codigo_barras, '') = $3) DESC,
                 (LOWER(COALESCE(p.sku, '')) = $4) DESC,
                 p.nombre ASC
        LIMIT $5`,
      [`%${texto.toLowerCase()}%`, `%${texto}%`, texto, texto.toLowerCase(), limite],
    );

    return filas.map((f: any) => this.mapProducto(f));
  }

  async buscarPorCodigoBarras(codigo: string): Promise<ProductoVentaResponse | null> {
    const filas = await this.buscarProductos(codigo, 1);
    return filas[0] ?? null;
  }

  /** Trae los datos oficiales de los productos que se van a vender. */
  async cargarProductos(ids: number[]): Promise<Map<number, ProductoVentaResponse>> {
    if (!ids.length) return new Map();

    const filas = await this.dataSource.query(
      `SELECT p.id_producto,
              p.nombre,
              COALESCE(p.sku, '')            AS sku,
              COALESCE(p.codigo_barras, '')  AS codigo_barras,
              COALESCE(p.unidad_medida, '')  AS unidad_medida,
              COALESCE(p.precio_venta, 0)    AS precio_venta,
              COALESCE(p.descuento, 0)       AS descuento,
              COALESCE(inv.stock, 0)         AS stock_disponible,
              ''                             AS imagen_url
         FROM productos p
         LEFT JOIN LATERAL (
                SELECT SUM(i.stock) AS stock FROM inventario i WHERE i.id_producto = p.id_producto
              ) inv ON TRUE
        WHERE p.id_producto = ANY($1)`,
      [ids],
    );

    return new Map(filas.map((f: any) => [Number(f.id_producto), this.mapProducto(f)]));
  }

  private mapProducto(f: any): ProductoVentaResponse {
    const precio = Number(f.precio_venta ?? 0);
    const descuento = Number(f.descuento ?? 0);
    return {
      id_producto: Number(f.id_producto),
      nombre: f.nombre ?? '',
      sku: f.sku ?? '',
      codigo_barras: f.codigo_barras ?? '',
      unidad_medida: f.unidad_medida || 'NIU',
      precio_venta: precio,
      descuento,
      precio_final: Math.round((precio - descuento + Number.EPSILON) * 100) / 100,
      stock_disponible: Number(f.stock_disponible ?? 0),
      imagen_url: f.imagen_url ?? '',
    };
  }

  // ── Registro de la venta ─────────────────────────────────────

  async buscarPorClaveIdempotencia(clave: string): Promise<number | null> {
    const filas = await this.dataSource.query(
      'SELECT id_venta FROM ventas WHERE clave_idempotencia = $1 LIMIT 1',
      [clave],
    );
    return filas[0]?.id_venta ? Number(filas[0].id_venta) : null;
  }

  /**
   * Registra la venta completa en una sola transacción: descuenta stock, crea
   * la cabecera, el detalle y los pagos.
   *
   * Si el stock de cualquier línea no alcanza, no se escribe nada.
   */
  async registrar(
    datos: DatosVenta,
    lineas: LineaVentaPersistida[],
    pagos: { id_metodo?: number; monto: number; referencia?: string }[],
    opciones: { descontarStock: boolean; idAlmacenPreferido?: number },
  ): Promise<number> {
    return this.dataSource.transaction(async (manager) => {
      if (opciones.descontarStock) {
        await this.descontarStock(manager, lineas, opciones.idAlmacenPreferido);
      }

      const idCaja = datos.id_caja ?? (await this.cajaAbierta(manager));

      const insertadas = await manager.query(
        `INSERT INTO ventas (id_cliente, id_caja, fecha, subtotal, igv, total, origen, clave_idempotencia)
         VALUES ($1, $2, NOW(), $3, $4, $5, $6, $7)
         RETURNING id_venta`,
        [
          datos.id_cliente ?? null,
          idCaja,
          datos.subtotal,
          datos.igv,
          datos.total,
          datos.origen,
          datos.clave_idempotencia ?? null,
        ],
      );

      const idVenta = Number(insertadas[0]?.id_venta);

      for (const linea of lineas) {
        await manager.query(
          'INSERT INTO detalle_venta (id_venta, id_producto, cantidad, precio) VALUES ($1, $2, $3, $4)',
          [idVenta, linea.id_producto, linea.cantidad, linea.precio_unitario],
        );
      }

      for (const pago of pagos) {
        if (!pago.monto) continue;
        await manager.query(
          'INSERT INTO venta_pago (id_venta, id_metodo, monto) VALUES ($1, $2, $3)',
          [idVenta, pago.id_metodo ?? null, pago.monto],
        );
      }

      this.log.log(`Venta ${idVenta} registrada por ${datos.total}`);
      return idVenta;
    });
  }

  /**
   * Descuenta del almacén indicado y, si no alcanza, sigue por el que tenga más
   * existencias. El bloqueo de filas evita que dos cajas vendan la misma unidad.
   */
  private async descontarStock(
    manager: EntityManager,
    lineas: LineaVentaPersistida[],
    idAlmacenPreferido?: number,
  ): Promise<void> {
    for (const linea of lineas) {
      const filas = await manager.query(
        `SELECT id_inventario, id_almacen, stock
           FROM inventario
          WHERE id_producto = $1 AND stock > 0
          ORDER BY (id_almacen = $2) DESC, stock DESC
            FOR UPDATE`,
        [linea.id_producto, idAlmacenPreferido ?? -1],
      );

      let pendiente = linea.cantidad;

      for (const fila of filas) {
        if (pendiente <= 0) break;
        const tomar = Math.min(pendiente, Number(fila.stock));

        await manager.query('UPDATE inventario SET stock = stock - $1 WHERE id_inventario = $2', [
          tomar,
          fila.id_inventario,
        ]);
        await this.registrarMovimiento(manager, linea.id_producto, Number(fila.id_almacen), tomar, 'salida', 'Venta en mostrador');

        pendiente -= tomar;
      }

      if (pendiente > 0) {
        throw new Error(`STOCK_INSUFICIENTE:${linea.id_producto}:${pendiente}`);
      }
    }
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

  private async cajaAbierta(manager: EntityManager): Promise<number | null> {
    try {
      const filas = await manager.query(
        `SELECT c.id_caja
           FROM cajas c
           JOIN aperturas_caja a ON a.id_caja = c.id_caja
          WHERE NOT EXISTS (SELECT 1 FROM cierres_caja ci WHERE ci.id_apertura = a.id_apertura)
          ORDER BY a.fecha DESC
          LIMIT 1`,
      );
      return filas[0]?.id_caja ?? null;
    } catch {
      return null;
    }
  }

  // ── Consultas ────────────────────────────────────────────────

  async obtener(idVenta: number): Promise<any | null> {
    const filas = await this.dataSource.query(
      `SELECT v.id_venta, v.fecha, v.subtotal, v.igv, v.total,
              COALESCE(v.origen, 'mostrador') AS origen,
              v.id_cliente,
              TRIM(CONCAT_WS(' ', c.nombre, c.apellido_paterno, c.apellido_materno)) AS cliente_denominacion
         FROM ventas v
         LEFT JOIN clientes c ON c.id_cliente = v.id_cliente
        WHERE v.id_venta = $1`,
      [idVenta],
    );

    const venta = filas[0];
    if (!venta) return null;

    venta.items = await this.dataSource.query(
      `SELECT d.id_producto, d.cantidad, d.precio, COALESCE(p.nombre, 'Producto') AS descripcion
         FROM detalle_venta d
         LEFT JOIN productos p ON p.id_producto = d.id_producto
        WHERE d.id_venta = $1`,
      [idVenta],
    );

    venta.pagos = await this.dataSource.query(
      `SELECT vp.id_metodo, vp.monto FROM venta_pago vp WHERE vp.id_venta = $1`,
      [idVenta],
    );

    return venta;
  }

  async listar(filtro: FiltroVentas): Promise<{ datos: any[]; total: number; pagina: number; por_pagina: number }> {
    const pagina = Math.max(1, Number(filtro.pagina) || 1);
    const porPagina = Math.min(100, Math.max(1, Number(filtro.por_pagina) || 20));

    const condiciones: string[] = ['1 = 1'];
    const parametros: any[] = [];

    if (filtro.texto?.trim()) {
      parametros.push(`%${filtro.texto.trim().toLowerCase()}%`);
      condiciones.push(
        `(LOWER(TRIM(CONCAT_WS(' ', c.nombre, c.apellido_paterno, c.apellido_materno))) LIKE $${parametros.length}
          OR CAST(v.id_venta AS TEXT) LIKE $${parametros.length})`,
      );
    }
    if (filtro.desde) {
      parametros.push(filtro.desde);
      condiciones.push(`v.fecha >= $${parametros.length}`);
    }
    if (filtro.hasta) {
      parametros.push(`${filtro.hasta} 23:59:59`);
      condiciones.push(`v.fecha <= $${parametros.length}`);
    }
    if (filtro.origen) {
      parametros.push(filtro.origen);
      condiciones.push(`COALESCE(v.origen, 'mostrador') = $${parametros.length}`);
    }

    const donde = condiciones.join(' AND ');

    const totales = await this.dataSource.query(
      `SELECT COUNT(*)::int AS total FROM ventas v
       LEFT JOIN clientes c ON c.id_cliente = v.id_cliente
       WHERE ${donde}`,
      parametros,
    );

    parametros.push(porPagina, (pagina - 1) * porPagina);

    const datos = await this.dataSource.query(
      `SELECT v.id_venta, v.fecha, v.total,
              COALESCE(v.origen, 'mostrador') AS origen,
              COALESCE(NULLIF(TRIM(CONCAT_WS(' ', c.nombre, c.apellido_paterno, c.apellido_materno)), ''), 'CLIENTES VARIOS') AS cliente_denominacion,
              (SELECT COUNT(*)::int FROM detalle_venta d WHERE d.id_venta = v.id_venta) AS cantidad_items,
              cp.id_comprobante,
              cp.serie,
              cp.numero,
              cp.estado AS comprobante_estado,
              cp.anulado AS comprobante_anulado
         FROM ventas v
         LEFT JOIN clientes c ON c.id_cliente = v.id_cliente
         LEFT JOIN LATERAL (
                SELECT id_comprobante, serie, numero, estado, anulado
                  FROM comprobantes
                 WHERE id_venta = v.id_venta
                 ORDER BY creado_en DESC
                 LIMIT 1
              ) cp ON TRUE
        WHERE ${donde}
        ORDER BY v.fecha DESC
        LIMIT $${parametros.length - 1} OFFSET $${parametros.length}`,
      parametros,
    );

    return { datos, total: totales[0]?.total ?? 0, pagina, por_pagina: porPagina };
  }

  /** Devuelve al inventario lo que salió por una venta anulada. */
  async devolverStock(idVenta: number): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const lineas = await manager.query(
        'SELECT id_producto, cantidad FROM detalle_venta WHERE id_venta = $1 AND id_producto IS NOT NULL',
        [idVenta],
      );

      for (const linea of lineas) {
        const existentes = await manager.query(
          'SELECT id_inventario, id_almacen FROM inventario WHERE id_producto = $1 ORDER BY stock DESC LIMIT 1',
          [linea.id_producto],
        );

        if (existentes.length > 0) {
          await manager.query('UPDATE inventario SET stock = stock + $1 WHERE id_inventario = $2', [
            Number(linea.cantidad),
            existentes[0].id_inventario,
          ]);
          await this.registrarMovimiento(
            manager,
            Number(linea.id_producto),
            Number(existentes[0].id_almacen),
            Number(linea.cantidad),
            'entrada',
            'Devolución por venta anulada',
          );
        }
      }
    });
  }

  async metodosPago(): Promise<{ id_metodo: number; nombre: string }[]> {
    try {
      return await this.dataSource.query(
        `SELECT id_metodo, nombre FROM metodos_pago WHERE COALESCE(activo, TRUE) = TRUE ORDER BY id_metodo`,
      );
    } catch {
      return [];
    }
  }
}

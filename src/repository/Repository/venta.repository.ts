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
  id_empresa?: number;
  id_caja?: number;
  id_usuario?: number;
  subtotal: number;
  igv: number;
  descuento: number;
  total: number;
  origen: string;
  clave_idempotencia?: string;
  observaciones?: string;
  credito?: {
    monto: number;
    dias: number;
    id_cliente?: number | null;
    id_empresa?: number | null;
  };
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

  private indicesListos = false;

  /** Índices para barcode/SKU/nombre del POS (idempotente). */
  async asegurarIndicesBusqueda(): Promise<void> {
    if (this.indicesListos) return;
    try {
      await this.dataSource.query(`
        CREATE INDEX IF NOT EXISTS idx_productos_estado ON productos (estado);
        CREATE INDEX IF NOT EXISTS idx_productos_codigo_barras
          ON productos (codigo_barras)
          WHERE codigo_barras IS NOT NULL AND codigo_barras <> '';
        CREATE INDEX IF NOT EXISTS idx_productos_sku_lower
          ON productos (LOWER(sku));
        CREATE INDEX IF NOT EXISTS idx_productos_nombre_lower
          ON productos (LOWER(nombre));
        CREATE INDEX IF NOT EXISTS idx_inventario_id_producto
          ON inventario (id_producto);
        CREATE UNIQUE INDEX IF NOT EXISTS uq_ventas_clave_idempotencia
          ON ventas (clave_idempotencia)
          WHERE clave_idempotencia IS NOT NULL AND clave_idempotencia <> '';
        CREATE INDEX IF NOT EXISTS idx_inventario_producto_almacen
          ON inventario (id_producto, id_almacen);
      `);
      this.indicesListos = true;
    } catch (e) {
      this.log.warn(`No se pudieron crear índices de búsqueda POS: ${e}`);
    }
  }

  /** JOIN de stock: un almacén concreto o suma de todos (legacy). */
  private joinStock(idAlmacen?: number): { sql: string; params: number[] } {
    if (idAlmacen != null && Number.isFinite(idAlmacen) && idAlmacen > 0) {
      return {
        sql: `LEFT JOIN inventario inv
                ON inv.id_producto = p.id_producto AND inv.id_almacen = $ALM`,
        params: [idAlmacen],
      };
    }
    return {
      sql: `LEFT JOIN (
              SELECT i.id_producto, SUM(i.stock) AS stock
                FROM inventario i
               GROUP BY i.id_producto
            ) inv ON inv.id_producto = p.id_producto`,
      params: [],
    };
  }

  /**
   * Catálogo completo del mostrador (activos). Una carga para cache en el front.
   * Misma forma de respuesta que el autocompletado.
   */
  async catalogoProductos(limite = 5000, idAlmacen?: number): Promise<ProductoVentaResponse[]> {
    await this.asegurarIndicesBusqueda();
    const tope = Math.min(Math.max(Number(limite) || 5000, 1), 8000);
    const stock = this.joinStock(idAlmacen);
    const idxLimite = stock.params.length + 1;
    const joinSql = stock.sql.replace('$ALM', `$${stock.params.length || 1}`);

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
         ${joinSql}
         LEFT JOIN LATERAL (
                SELECT pi.url FROM productos_imagenes pi
                 WHERE pi.id_producto = p.id_producto
                 ORDER BY pi.is_primary DESC NULLS LAST, pi.orden ASC NULLS LAST
                 LIMIT 1
              ) img ON TRUE
        WHERE COALESCE(p.estado, TRUE) = TRUE
        ORDER BY p.nombre ASC
        LIMIT $${idxLimite}`,
      [...stock.params, tope],
    );

    return filas.map((f: any) => this.mapProducto(f));
  }

  /**
   * Autocompletado del punto de venta. Busca por nombre, SKU o código de
   * barras. Con idAlmacen: stock de ese almacén; sin él: suma de todos.
   */
  async buscarProductos(
    termino: string,
    limite = 12,
    idAlmacen?: number,
  ): Promise<ProductoVentaResponse[]> {
    await this.asegurarIndicesBusqueda();
    const texto = (termino ?? '').trim();
    if (texto.length < 1) return [];

    const stock = this.joinStock(idAlmacen);
    const offset = stock.params.length;
    const joinSql = stock.sql.replace('$ALM', `$${offset || 1}`);

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
         ${joinSql}
         LEFT JOIN LATERAL (
                SELECT pi.url FROM productos_imagenes pi
                 WHERE pi.id_producto = p.id_producto
                 ORDER BY pi.is_primary DESC NULLS LAST, pi.orden ASC NULLS LAST
                 LIMIT 1
              ) img ON TRUE
        WHERE COALESCE(p.estado, TRUE) = TRUE
          AND (
                LOWER(p.nombre) LIKE $${offset + 1}
             OR LOWER(COALESCE(p.sku, '')) LIKE $${offset + 1}
             OR COALESCE(p.codigo_barras, '') LIKE $${offset + 2}
          )
        ORDER BY (COALESCE(p.codigo_barras, '') = $${offset + 3}) DESC,
                 (LOWER(COALESCE(p.sku, '')) = $${offset + 4}) DESC,
                 p.nombre ASC
        LIMIT $${offset + 5}`,
      [
        ...stock.params,
        `%${texto.toLowerCase()}%`,
        `%${texto}%`,
        texto,
        texto.toLowerCase(),
        limite,
      ],
    );

    return filas.map((f: any) => this.mapProducto(f));
  }

  /**
   * Match exacto para el lector USB (HID): primero codigo_barras, luego SKU.
   * No usa LIKE para no agregar un producto equivocado.
   */
  async buscarPorCodigoBarras(
    codigo: string,
    idAlmacen?: number,
  ): Promise<ProductoVentaResponse | null> {
    await this.asegurarIndicesBusqueda();
    const valor = codigo.trim();
    if (!valor) return null;

    const stock = this.joinStock(idAlmacen);
    const offset = stock.params.length;
    const joinSql = stock.sql.replace('$ALM', `$${offset || 1}`);

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
         ${joinSql}
         LEFT JOIN LATERAL (
                SELECT pi.url FROM productos_imagenes pi
                 WHERE pi.id_producto = p.id_producto
                 ORDER BY pi.is_primary DESC NULLS LAST, pi.orden ASC NULLS LAST
                 LIMIT 1
              ) img ON TRUE
        WHERE COALESCE(p.estado, TRUE) = TRUE
          AND (
                COALESCE(p.codigo_barras, '') = $${offset + 1}
             OR LOWER(COALESCE(p.sku, '')) = LOWER($${offset + 1})
          )
        ORDER BY (COALESCE(p.codigo_barras, '') = $${offset + 1}) DESC
        LIMIT 1`,
      [...stock.params, valor],
    );

    return filas[0] ? this.mapProducto(filas[0]) : null;
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
   * Clave de idempotencia duplicada → se devuelve la venta ya existente
   * (la transacción se revierte para no descontar stock de más).
   */
  async registrar(
    datos: DatosVenta,
    lineas: LineaVentaPersistida[],
    pagos: { id_metodo?: number; monto: number; referencia?: string; monto_recibido?: number; vuelto?: number }[],
    opciones: { descontarStock: boolean; idAlmacenPreferido?: number },
  ): Promise<number> {
    try {
      return await this.dataSource.transaction(async (manager) => {
        if (datos.clave_idempotencia) {
          const previas = await manager.query(
            'SELECT id_venta FROM ventas WHERE clave_idempotencia = $1 LIMIT 1',
            [datos.clave_idempotencia],
          );
          if (previas[0]?.id_venta) return Number(previas[0].id_venta);
        }

        let salidasStock: { id_producto: number; id_almacen: number; cantidad: number }[] = [];
        if (opciones.descontarStock) {
          salidasStock = await this.descontarStock(manager, lineas, opciones.idAlmacenPreferido);
        }

        const idCaja =
          datos.id_caja
          ?? (await this.cajaAbierta(manager, {
            idUsuario: datos.id_usuario,
            idAlmacen: opciones.idAlmacenPreferido,
          }));

        await this.asegurarColumnaIdEmpresa(manager);

        const insertadas = await manager.query(
          `INSERT INTO ventas (id_cliente, id_empresa, id_caja, fecha, subtotal, igv, total, origen, clave_idempotencia)
           VALUES ($1, $2, $3, NOW(), $4, $5, $6, $7, $8)
           RETURNING id_venta`,
          [
            datos.id_cliente ?? null,
            datos.id_empresa ?? null,
            idCaja,
            datos.subtotal,
            datos.igv,
            datos.total,
            datos.origen,
            datos.clave_idempotencia ?? null,
          ],
        );

        const idVenta = Number(insertadas[0]?.id_venta);

        await this.asegurarTablaVentaStock(manager);
        for (const s of salidasStock) {
          await manager.query(
            `INSERT INTO venta_stock_salida (id_venta, id_producto, id_almacen, cantidad)
             VALUES ($1, $2, $3, $4)`,
            [idVenta, s.id_producto, s.id_almacen, s.cantidad],
          );
        }

        for (const linea of lineas) {
          await manager.query(
            'INSERT INTO detalle_venta (id_venta, id_producto, cantidad, precio) VALUES ($1, $2, $3, $4)',
            [idVenta, linea.id_producto, linea.cantidad, linea.precio_unitario],
          );
        }

        for (const pago of pagos) {
          if (!pago.monto) continue;
          await manager.query(
            `INSERT INTO venta_pago
               (id_venta, id_metodo, monto, referencia, monto_recibido, vuelto,
                id_cuenta_bancaria, voucher_pos, validacion, referencia_externa)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
            [
              idVenta,
              pago.id_metodo ?? null,
              pago.monto,
              (pago as any).referencia ?? null,
              (pago as any).monto_recibido ?? null,
              (pago as any).vuelto ?? null,
              (pago as any).id_cuenta_bancaria ?? null,
              (pago as any).voucher_pos ?? null,
              (pago as any).validacion ?? null,
              (pago as any).referencia_externa ?? null,
            ],
          );
        }

        if (datos.credito && Number(datos.credito.monto) > 0) {
          await this.assertCupoCreditoEnTx(manager, datos.credito);

          const dias = Math.max(1, Number(datos.credito.dias) || 15);
          const vencimiento = new Date();
          vencimiento.setDate(vencimiento.getDate() + dias);
          await manager.query(
            `INSERT INTO cuentas_por_cobrar
               (id_venta, id_cliente, id_empresa, monto_total, saldo, fecha_emision, fecha_vencimiento, estado)
             VALUES ($1, $2, $3, $4, $4, NOW(), $5::date, 'pendiente')`,
            [
              idVenta,
              datos.credito.id_cliente ?? null,
              datos.credito.id_empresa ?? null,
              Number(datos.credito.monto),
              vencimiento.toISOString().slice(0, 10),
            ],
          );
        }

        this.log.log(`Venta ${idVenta} registrada por ${datos.total}`);
        return idVenta;
      });
    } catch (error: any) {
      if (this.esViolacionUnica(error) && datos.clave_idempotencia) {
        const existente = await this.buscarPorClaveIdempotencia(datos.clave_idempotencia);
        if (existente) return existente;
      }
      throw error;
    }
  }

  private esViolacionUnica(error: any): boolean {
    const codigo = String(error?.code ?? error?.driverError?.code ?? '');
    return codigo === '23505';
  }

  /**
   * Rechequea cupo dentro de la TX (PostgreSQL FOR UPDATE) para evitar sobregiro
   * cuando dos cajas cobran crédito a la vez.
   */
  private async assertCupoCreditoEnTx(
    manager: EntityManager,
    credito: NonNullable<DatosVenta['credito']>,
  ): Promise<void> {
    const monto = Number(credito.monto);
    if (!(monto > 0)) return;

    let limite = 0;
    let activo = false;

    if (credito.id_empresa) {
      const filas = await manager.query(
        `SELECT COALESCE(credito_activo, FALSE) AS credito_activo,
                COALESCE(limite_credito, 0)::float AS limite_credito
           FROM empresas WHERE id_empresa = $1
           FOR UPDATE`,
        [credito.id_empresa],
      );
      if (!filas[0]) throw new Error('CREDITO_ENTIDAD:Empresa no encontrada');
      activo = filas[0].credito_activo === true || filas[0].credito_activo === 't';
      limite = Number(filas[0].limite_credito ?? 0);
    } else if (credito.id_cliente) {
      const filas = await manager.query(
        `SELECT COALESCE(credito_activo, FALSE) AS credito_activo,
                COALESCE(limite_credito, 0)::float AS limite_credito
           FROM clientes WHERE id_cliente = $1
           FOR UPDATE`,
        [credito.id_cliente],
      );
      if (!filas[0]) throw new Error('CREDITO_ENTIDAD:Cliente no encontrado');
      activo = filas[0].credito_activo === true || filas[0].credito_activo === 't';
      limite = Number(filas[0].limite_credito ?? 0);
    } else {
      throw new Error('CREDITO_SIN_CLIENTE');
    }

    if (!activo) throw new Error('CREDITO_INACTIVO');

    const deudaFilas = credito.id_empresa
      ? await manager.query(
          `SELECT COALESCE(SUM(saldo), 0)::float AS saldo
             FROM cuentas_por_cobrar
            WHERE id_empresa = $1 AND estado IN ('pendiente', 'parcial', 'vencido')`,
          [credito.id_empresa],
        )
      : await manager.query(
          `SELECT COALESCE(SUM(saldo), 0)::float AS saldo
             FROM cuentas_por_cobrar
            WHERE id_cliente = $1 AND estado IN ('pendiente', 'parcial', 'vencido')`,
          [credito.id_cliente],
        );

    const deuda = Number(deudaFilas[0]?.saldo ?? 0);
    const disponible = Math.round((limite - deuda + Number.EPSILON) * 100) / 100;
    if (monto > disponible + 0.05) {
      throw new Error(
        `CREDITO_INSUFICIENTE:${disponible.toFixed(2)}:${limite.toFixed(2)}:${deuda.toFixed(2)}`,
      );
    }
  }

  /**
   * Con idAlmacenPreferido: descuenta SOLO de ese almacén (sin derrame).
   * Sin él: comportamiento legacy — preferido si hay, luego el de más stock.
   * Devuelve de qué almacén salió cada unidad (para anular bien).
   */
  private async descontarStock(
    manager: EntityManager,
    lineas: LineaVentaPersistida[],
    idAlmacenPreferido?: number,
  ): Promise<{ id_producto: number; id_almacen: number; cantidad: number }[]> {
    const exclusivo =
      idAlmacenPreferido != null
      && Number.isFinite(idAlmacenPreferido)
      && idAlmacenPreferido > 0;

    const salidas: { id_producto: number; id_almacen: number; cantidad: number }[] = [];

    for (const linea of lineas) {
      const filas = exclusivo
        ? await manager.query(
            `SELECT id_inventario, id_almacen, stock
               FROM inventario
              WHERE id_producto = $1 AND id_almacen = $2 AND stock > 0
                FOR UPDATE`,
            [linea.id_producto, idAlmacenPreferido],
          )
        : await manager.query(
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

        salidas.push({
          id_producto: linea.id_producto,
          id_almacen: Number(fila.id_almacen),
          cantidad: tomar,
        });

        pendiente -= tomar;
      }

      if (pendiente > 0) {
        throw new Error(`STOCK_INSUFICIENTE:${linea.id_producto}:${pendiente}`);
      }
    }

    return salidas;
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

  /**
   * Caja abierta para la venta (Fase 7):
   * 1) Apertura del mismo usuario (si aperturas_caja.id_usuario existe)
   * 2) Caja de la sucursal del almacén de despacho
   * 3) Cualquier caja abierta (legacy)
   */
  private async cajaAbierta(
    manager: EntityManager,
    opts?: { idUsuario?: number; idAlmacen?: number },
  ): Promise<number | null> {
    try {
      await this.asegurarColumnaIdUsuarioApertura(manager);

      const idUsuario =
        opts?.idUsuario != null && Number.isFinite(Number(opts.idUsuario)) && Number(opts.idUsuario) > 0
          ? Number(opts.idUsuario)
          : null;
      const idAlmacen =
        opts?.idAlmacen != null && Number.isFinite(Number(opts.idAlmacen)) && Number(opts.idAlmacen) > 0
          ? Number(opts.idAlmacen)
          : null;

      if (idUsuario) {
        const porUsuario = await manager.query(
          `SELECT c.id_caja
             FROM cajas c
             JOIN aperturas_caja a ON a.id_caja = c.id_caja
            WHERE a.id_usuario = $1
              AND NOT EXISTS (SELECT 1 FROM cierres_caja ci WHERE ci.id_apertura = a.id_apertura)
            ORDER BY a.fecha DESC
            LIMIT 1`,
          [idUsuario],
        );
        if (porUsuario[0]?.id_caja) return Number(porUsuario[0].id_caja);
      }

      if (idAlmacen) {
        const porSucursal = await manager.query(
          `SELECT c.id_caja
             FROM cajas c
             JOIN aperturas_caja a ON a.id_caja = c.id_caja
             JOIN almacenes al ON al.id_sucursal = c.id_sucursal
            WHERE al.id_almacen = $1
              AND NOT EXISTS (SELECT 1 FROM cierres_caja ci WHERE ci.id_apertura = a.id_apertura)
            ORDER BY a.fecha DESC
            LIMIT 1`,
          [idAlmacen],
        );
        if (porSucursal[0]?.id_caja) return Number(porSucursal[0].id_caja);
      }

      const filas = await manager.query(
        `SELECT c.id_caja
           FROM cajas c
           JOIN aperturas_caja a ON a.id_caja = c.id_caja
          WHERE NOT EXISTS (SELECT 1 FROM cierres_caja ci WHERE ci.id_apertura = a.id_apertura)
          ORDER BY a.fecha DESC
          LIMIT 1`,
      );
      return filas[0]?.id_caja != null ? Number(filas[0].id_caja) : null;
    } catch {
      return null;
    }
  }

  private async asegurarColumnaIdUsuarioApertura(manager?: EntityManager): Promise<void> {
    const q = manager ?? this.dataSource;
    await q.query(`
      ALTER TABLE aperturas_caja ADD COLUMN IF NOT EXISTS id_usuario INTEGER
    `);
  }

  // ── Consultas ────────────────────────────────────────────────

  async obtener(idVenta: number): Promise<any | null> {
    await this.asegurarColumnaIdEmpresa();
    const filas = await this.dataSource.query(
      `SELECT v.id_venta, v.fecha, v.subtotal, v.igv, v.total,
              COALESCE(v.origen, 'mostrador') AS origen,
              v.id_cliente,
              v.id_empresa,
              COALESCE(
                NULLIF(TRIM(CONCAT_WS(' ', c.nombre, c.apellido_paterno, c.apellido_materno)), ''),
                NULLIF(TRIM(COALESCE(e.razon_social, e.nombre_comercial, e.ruc)), ''),
                'CLIENTES VARIOS'
              ) AS cliente_denominacion
         FROM ventas v
         LEFT JOIN clientes c ON c.id_cliente = v.id_cliente
         LEFT JOIN empresas e ON e.id_empresa = v.id_empresa
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
    await this.asegurarColumnaIdEmpresa();
    const pagina = Math.max(1, Number(filtro.pagina) || 1);
    const porPagina = Math.min(100, Math.max(1, Number(filtro.por_pagina) || 20));

    const condiciones: string[] = ['1 = 1'];
    const parametros: any[] = [];

    if (filtro.texto?.trim()) {
      parametros.push(`%${filtro.texto.trim().toLowerCase()}%`);
      condiciones.push(
        `(LOWER(TRIM(CONCAT_WS(' ', c.nombre, c.apellido_paterno, c.apellido_materno))) LIKE $${parametros.length}
          OR LOWER(COALESCE(e.razon_social, '')) LIKE $${parametros.length}
          OR LOWER(COALESCE(e.nombre_comercial, '')) LIKE $${parametros.length}
          OR LOWER(COALESCE(e.ruc, '')) LIKE $${parametros.length}
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
       LEFT JOIN empresas e ON e.id_empresa = v.id_empresa
       WHERE ${donde}`,
      parametros,
    );

    parametros.push(porPagina, (pagina - 1) * porPagina);

    const datos = await this.dataSource.query(
      `SELECT v.id_venta, v.fecha, v.total,
              COALESCE(v.origen, 'mostrador') AS origen,
              v.id_cliente,
              v.id_empresa,
              COALESCE(
                NULLIF(TRIM(CONCAT_WS(' ', c.nombre, c.apellido_paterno, c.apellido_materno)), ''),
                NULLIF(TRIM(COALESCE(e.razon_social, e.nombre_comercial, e.ruc)), ''),
                'CLIENTES VARIOS'
              ) AS cliente_denominacion,
              (SELECT COUNT(*)::int FROM detalle_venta d WHERE d.id_venta = v.id_venta) AS cantidad_items,
              cp.id_comprobante,
              cp.serie,
              cp.numero,
              cp.estado AS comprobante_estado,
              cp.anulado AS comprobante_anulado
         FROM ventas v
         LEFT JOIN clientes c ON c.id_cliente = v.id_cliente
         LEFT JOIN empresas e ON e.id_empresa = v.id_empresa
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

  /** Devuelve al inventario lo que salió por una venta anulada (mismo almacén) y cierra CxC. */
  async anularVentaCompleta(idVenta: number): Promise<{
    stock_devuelto: boolean;
    cxc_cerradas: number;
    ya_anulada: boolean;
  }> {
    return this.dataSource.transaction(async (manager) => {
      await this.asegurarTablaVentaStock(manager);
      await this.asegurarColumnaEstadoVenta(manager);

      const cab = await manager.query(
        `SELECT id_venta, COALESCE(estado, 'activa') AS estado FROM ventas WHERE id_venta = $1 FOR UPDATE`,
        [idVenta],
      );
      if (!cab[0]) throw new Error('VENTA_NO_ENCONTRADA');
      if (String(cab[0].estado).toLowerCase() === 'anulada') {
        return { stock_devuelto: false, cxc_cerradas: 0, ya_anulada: true };
      }

      const salidas = await manager.query(
        `SELECT id_producto, id_almacen, cantidad
           FROM venta_stock_salida WHERE id_venta = $1`,
        [idVenta],
      );

      if (salidas.length > 0) {
        for (const s of salidas) {
          await this.devolverAAlmacen(
            manager,
            Number(s.id_producto),
            Number(s.id_almacen),
            Number(s.cantidad),
          );
        }
      } else {
        // Ventas anteriores a Fase 4: fallback (mismo comportamiento mejorado por producto).
        const lineas = await manager.query(
          'SELECT id_producto, cantidad FROM detalle_venta WHERE id_venta = $1 AND id_producto IS NOT NULL',
          [idVenta],
        );
        for (const linea of lineas) {
          const existentes = await manager.query(
            `SELECT id_inventario, id_almacen FROM inventario
              WHERE id_producto = $1 ORDER BY stock DESC LIMIT 1 FOR UPDATE`,
            [linea.id_producto],
          );
          if (existentes[0]) {
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
      }

      const cxc = await manager.query(
        `UPDATE cuentas_por_cobrar
            SET saldo = 0, estado = 'anulado'
          WHERE id_venta = $1
            AND estado IN ('pendiente', 'parcial', 'vencido')
          RETURNING id_cxc`,
        [idVenta],
      );

      await manager.query(
        `UPDATE ventas SET estado = 'anulada' WHERE id_venta = $1`,
        [idVenta],
      );

      return {
        stock_devuelto: true,
        cxc_cerradas: (cxc ?? []).length,
        ya_anulada: false,
      };
    });
  }

  /** @deprecated Usar anularVentaCompleta */
  async devolverStock(idVenta: number): Promise<void> {
    await this.anularVentaCompleta(idVenta);
  }

  private async devolverAAlmacen(
    manager: EntityManager,
    idProducto: number,
    idAlmacen: number,
    cantidad: number,
  ): Promise<void> {
    const filas = await manager.query(
      `SELECT id_inventario FROM inventario
        WHERE id_producto = $1 AND id_almacen = $2
        FOR UPDATE`,
      [idProducto, idAlmacen],
    );
    if (filas[0]) {
      await manager.query('UPDATE inventario SET stock = stock + $1 WHERE id_inventario = $2', [
        cantidad,
        filas[0].id_inventario,
      ]);
    } else {
      await manager.query(
        `INSERT INTO inventario (id_producto, id_almacen, stock)
         VALUES ($1, $2, $3)`,
        [idProducto, idAlmacen, cantidad],
      );
    }
    await this.registrarMovimiento(
      manager,
      idProducto,
      idAlmacen,
      cantidad,
      'entrada',
      'Devolución por venta anulada',
    );
  }

  private async asegurarTablaVentaStock(manager?: EntityManager): Promise<void> {
    const q = manager ?? this.dataSource;
    await q.query(`
      CREATE TABLE IF NOT EXISTS venta_stock_salida (
        id SERIAL PRIMARY KEY,
        id_venta INTEGER NOT NULL REFERENCES ventas(id_venta) ON DELETE CASCADE,
        id_producto INTEGER NOT NULL,
        id_almacen INTEGER NOT NULL,
        cantidad NUMERIC(12, 3) NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_venta_stock_salida_venta ON venta_stock_salida (id_venta);
    `);
  }

  private async asegurarColumnaEstadoVenta(manager?: EntityManager): Promise<void> {
    const q = manager ?? this.dataSource;
    await q.query(`
      ALTER TABLE ventas ADD COLUMN IF NOT EXISTS estado VARCHAR(20) DEFAULT 'activa';
    `);
  }

  private async asegurarColumnaIdEmpresa(manager?: EntityManager): Promise<void> {
    const q = manager ?? this.dataSource;
    await q.query(`
      ALTER TABLE ventas
        ADD COLUMN IF NOT EXISTS id_empresa INTEGER REFERENCES empresas(id_empresa)
    `);
    await q.query(`
      CREATE INDEX IF NOT EXISTS idx_ventas_id_empresa ON ventas (id_empresa)
    `);
  }

  async metodosPago(): Promise<{ id_metodo: number; nombre: string; tipo: string }[]> {
    try {
      return await this.dataSource.query(
        `SELECT id_metodo, nombre, COALESCE(tipo, '') AS tipo
           FROM metodos_pago
          WHERE COALESCE(activo, TRUE) = TRUE
          ORDER BY COALESCE(orden, id_metodo), id_metodo`,
      );
    } catch {
      return [];
    }
  }

  /** Listado compacto de almacenes para el selector del POS. */
  async listarAlmacenesPos(): Promise<
    { id_almacen: number; nombre: string; sucursal: string; id_sucursal: number | null }[]
  > {
    try {
      const filas = await this.dataSource.query(
        `SELECT a.id_almacen,
                a.nombre,
                COALESCE(s.nombre, '') AS sucursal,
                a.id_sucursal
           FROM almacenes a
           LEFT JOIN sucursales s ON s.id_sucursal = a.id_sucursal
          ORDER BY a.nombre ASC`,
      );
      return (filas ?? []).map((f: any) => ({
        id_almacen: Number(f.id_almacen),
        nombre: f.nombre ?? '',
        sucursal: f.sucursal ?? '',
        id_sucursal: f.id_sucursal != null ? Number(f.id_sucursal) : null,
      }));
    } catch {
      return [];
    }
  }
}

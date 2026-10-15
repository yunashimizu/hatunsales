import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { ProductoVentaResponse } from '../../models/model/venta/venta.response';
import { EsquemaCajaService, SnapshotEsquema } from '../../caja/esquema/esquema-caja.service';
import { planificarSalidas, SalidaStock } from '../../caja/ventas/plan-salida-stock';
import { Dinero } from '../../caja/dominio/dinero';
import { filasDe } from '../../caja/bd/resultado-consulta';
import { SQL_HOY_LIMA, sqlFinExclusivoDiaLima, sqlInicioDiaLima } from '../../util/fecha-lima';

export interface LineaVentaPersistida {
  id_producto: number;
  descripcion: string;
  cantidad: number;
  precio_unitario: number;
  descuento: number;
  subtotal: number;
  igv: number;
  total: number;
  precio_lista_unitario: number;
  descuento_unitario_aplicado: number;
  descuento_total_linea: number;
  precio_unitario_final: number;
  id_regla_mayorista: number | null;
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
  id_proforma?: number;
  credito?: {
    monto: number;
    dias: number;
    id_cliente?: number | null;
    id_empresa?: number | null;
  };
}

export interface PagoVentaPersistido {
  id_metodo?: number;
  monto: number;
  referencia?: string;
  monto_recibido?: number;
  vuelto?: number;
  id_cuenta_bancaria?: number;
  voucher_pos?: string;
  validacion?: string;
  referencia_externa?: string;
}

export interface ResultadoRegistroVenta {
  id_venta: number;
  existente: boolean;
}

/** Filtro ya validado por la capa bussnies: desde/hasta son 'YYYY-MM-DD' (días de Lima). */
export interface FiltroVentas {
  texto?: string;
  desde?: string;
  hasta?: string;
  origen?: string;
  pagina?: number;
  por_pagina?: number;
}

/** Tope del autocompletado del POS (el frontend pide 12). */
export const LIMITE_BUSQUEDA_POS = 50;
const LARGO_MAXIMO_BUSQUEDA = 100;

type Consultor = Pick<EntityManager, 'query'>;

const SQL_MOVIMIENTO = {
  salida: { tipo: `'salida'`, sucursales: 'a.id_sucursal, NULL::int' },
  entrada: { tipo: `'entrada'`, sucursales: 'NULL::int, a.id_sucursal' },
} as const;

/** Línea de crédito del deudor: candado sobre su fila y, aparte, su deuda viva. */
const SQL_LINEA_CREDITO = {
  empresa: {
    bloquear: `SELECT COALESCE(e.credito_activo, FALSE) AS credito_activo,
                      COALESCE(e.limite_credito, 0)::text AS limite_credito
                 FROM empresas e WHERE e.id_empresa = $1
                  FOR UPDATE`,
    deuda: `SELECT COALESCE(SUM(saldo), 0)::text AS deuda
              FROM cuentas_por_cobrar
             WHERE id_empresa = $1 AND estado IN ('pendiente', 'parcial', 'vencido')`,
    noEncontrado: 'La empresa de la venta a crédito ya no existe',
  },
  cliente: {
    bloquear: `SELECT COALESCE(c.credito_activo, FALSE) AS credito_activo,
                      COALESCE(c.limite_credito, 0)::text AS limite_credito
                 FROM clientes c WHERE c.id_cliente = $1
                  FOR UPDATE`,
    deuda: `SELECT COALESCE(SUM(saldo), 0)::text AS deuda
              FROM cuentas_por_cobrar
             WHERE id_cliente = $1 AND estado IN ('pendiente', 'parcial', 'vencido')`,
    noEncontrado: 'El cliente de la venta a crédito ya no existe',
  },
} as const;

/**
 * Acceso a `ventas`, `detalle_venta` y `venta_pago`.
 *
 * SQL directo porque son tablas del núcleo transaccional sin entidad TypeORM. Sin DDL:
 * el esquema se consulta una vez en el catálogo (EsquemaCajaService) y las columnas
 * opcionales se usan solo si existen.
 *
 * Registrar una venta toma los candados siempre en el mismo orden para que dos cajas no
 * se bloqueen entre sí: clave de idempotencia → cotización → filas de inventario por
 * (id_producto, id_almacen) → línea de crédito del cliente o empresa.
 */
@Injectable()
export class VentaRepository {

  private readonly log = new Logger(VentaRepository.name);

  constructor(
    @InjectDataSource('pgConnection')
    private readonly dataSource: DataSource,
    private readonly esquema: EsquemaCajaService,
  ) {}

  // ── Búsqueda de productos para el mostrador ──────────────────

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
              COALESCE((SELECT json_agg(json_build_object(
                'id_regla', r.id_regla,
                'cantidad_minima', r.cantidad_minima,
                'descuento_unitario', r.descuento_unitario
              ) ORDER BY r.cantidad_minima)
                FROM producto_descuento_mayorista r
               WHERE r.id_producto = p.id_producto AND r.activo = TRUE), '[]'::json) AS reglas_mayoristas,
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
   * El límite se acota a 1..LIMITE_BUSQUEDA_POS aunque el controlador ya lo haga.
   */
  async buscarProductos(
    termino: string,
    limite = 12,
    idAlmacen?: number,
  ): Promise<ProductoVentaResponse[]> {
    const texto = (termino ?? '').trim().slice(0, LARGO_MAXIMO_BUSQUEDA);
    if (texto.length < 1) return [];
    const tope = Math.min(Math.max(Math.trunc(Number(limite)) || 12, 1), LIMITE_BUSQUEDA_POS);

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
              COALESCE((SELECT json_agg(json_build_object(
                'id_regla', r.id_regla,
                'cantidad_minima', r.cantidad_minima,
                'descuento_unitario', r.descuento_unitario
              ) ORDER BY r.cantidad_minima)
                FROM producto_descuento_mayorista r
               WHERE r.id_producto = p.id_producto AND r.activo = TRUE), '[]'::json) AS reglas_mayoristas,
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
        tope,
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
    const valor = codigo.trim().slice(0, LARGO_MAXIMO_BUSQUEDA);
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
              COALESCE((SELECT json_agg(json_build_object(
                'id_regla', r.id_regla,
                'cantidad_minima', r.cantidad_minima,
                'descuento_unitario', r.descuento_unitario
              ) ORDER BY r.cantidad_minima)
                FROM producto_descuento_mayorista r
               WHERE r.id_producto = p.id_producto AND r.activo = TRUE), '[]'::json) AS reglas_mayoristas,
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
              COALESCE((SELECT json_agg(json_build_object(
                'id_regla', r.id_regla,
                'cantidad_minima', r.cantidad_minima,
                'descuento_unitario', r.descuento_unitario
              ) ORDER BY r.cantidad_minima)
                FROM producto_descuento_mayorista r
               WHERE r.id_producto = p.id_producto AND r.activo = TRUE), '[]'::json) AS reglas_mayoristas,
              COALESCE(inv.stock, 0)         AS stock_disponible,
              ''                             AS imagen_url
         FROM productos p
         LEFT JOIN LATERAL (
                SELECT SUM(i.stock) AS stock FROM inventario i WHERE i.id_producto = p.id_producto
              ) inv ON TRUE
        WHERE p.id_producto = ANY($1::int[])`,
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
      reglas_mayoristas: Array.isArray(f.reglas_mayoristas) ? f.reglas_mayoristas.map((r: any) => ({
        id_regla: Number(r.id_regla),
        cantidad_minima: Number(r.cantidad_minima),
        descuento_unitario: Number(r.descuento_unitario),
      })) : [],
      stock_disponible: Number(f.stock_disponible ?? 0),
      imagen_url: f.imagen_url ?? '',
    };
  }

  // ── Registro de la venta ─────────────────────────────────────

  /** null si no hay venta con esa clave o si la columna aún no existe (script pendiente). */
  async buscarPorClaveIdempotencia(clave: string): Promise<number | null> {
    if (!clave || !(await this.esquema.tiene('idempotenciaVentas'))) return null;
    const filas = await this.dataSource.query(
      'SELECT id_venta FROM ventas WHERE clave_idempotencia = $1 LIMIT 1',
      [clave],
    );
    return filas[0]?.id_venta ? Number(filas[0].id_venta) : null;
  }

  /**
   * Registra la venta completa en una sola transacción: descuenta stock, crea
   * la cabecera, el detalle y los pagos (cada tabla con un solo INSERT por lotes).
   *
   * Si el stock de cualquier línea no alcanza, no se escribe nada.
   * Clave de idempotencia duplicada → se devuelve la venta ya existente
   * (la transacción se revierte para no descontar stock de más).
   */
  async registrar(
    datos: DatosVenta,
    lineas: LineaVentaPersistida[],
    pagos: PagoVentaPersistido[],
    opciones: { descontarStock: boolean; idAlmacenPreferido?: number },
  ): Promise<ResultadoRegistroVenta> {
    const esquema = await this.esquema.snapshot();
    const clave = datos.clave_idempotencia && (await this.esquema.tiene('idempotenciaVentas'))
      ? datos.clave_idempotencia
      : undefined;
    const conStockSalida = await this.esquema.tiene('ventaStockSalida');

    try {
      return await this.dataSource.transaction(async (manager) => {
        if (clave) {
          // Serializa reintentos concurrentes de la misma venta aunque falte el índice único.
          await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [clave]);
          const previas = await manager.query(
            'SELECT id_venta FROM ventas WHERE clave_idempotencia = $1 LIMIT 1',
            [clave],
          );
          if (previas[0]?.id_venta) {
            return { id_venta: Number(previas[0].id_venta), existente: true };
          }
        }

        if (datos.id_proforma) {
          await this.validarCotizacionParaVenta(manager, datos.id_proforma, lineas);
          if (!opciones.descontarStock) {
            throw new Error('COTIZACION_REQUIERE_STOCK');
          }
        }

        let salidasStock: SalidaStock[] = [];
        if (opciones.descontarStock) {
          salidasStock = await this.descontarStock(manager, lineas, opciones.idAlmacenPreferido);
        }

        const idCaja =
          datos.id_caja
          ?? (await this.cajaAbierta(manager, {
            idUsuario: datos.id_usuario,
            idAlmacen: opciones.idAlmacenPreferido,
          }));

        const idVenta = await this.insertarCabecera(manager, esquema, datos, idCaja, clave);

        if (salidasStock.length && conStockSalida) {
          await manager.query(
            `INSERT INTO venta_stock_salida (id_venta, id_producto, id_almacen, cantidad)
             SELECT $1, s.id_producto, s.id_almacen, s.cantidad
               FROM unnest($2::int[], $3::int[], $4::numeric[]) WITH ORDINALITY AS s(id_producto, id_almacen, cantidad, n)
              ORDER BY s.n`,
            [
              idVenta,
              salidasStock.map((s) => s.id_producto),
              salidasStock.map((s) => s.id_almacen),
              salidasStock.map((s) => s.cantidad),
            ],
          );
        }

        await this.insertarDetalle(manager, idVenta, lineas);
        await this.insertarPagos(manager, esquema, idVenta, pagos);

        if (datos.credito && Number(datos.credito.monto) > 0) {
          await this.assertCupoCreditoEnTx(manager, datos.credito);

          const dias = Math.max(1, Math.trunc(Number(datos.credito.dias)) || 15);
          // Vence en días calendario de Lima (CURRENT_DATE va en UTC y adelanta un día desde las 19:00).
          await manager.query(
            `INSERT INTO cuentas_por_cobrar
               (id_venta, id_cliente, id_empresa, monto_total, saldo, fecha_emision, fecha_vencimiento, estado)
             VALUES ($1, $2, $3, $4::numeric, $4::numeric, NOW(), ${SQL_HOY_LIMA} + $5::int, 'pendiente')`,
            [
              idVenta,
              datos.credito.id_cliente ?? null,
              datos.credito.id_empresa ?? null,
              Dinero.desdeNumeroRedondeado(Number(datos.credito.monto)).aTexto(),
              dias,
            ],
          );
        }

        if (datos.id_proforma) {
          const convertida = filasDe(await manager.query(
            `UPDATE proformas
                SET estado = 'convertida', id_venta = $1
              WHERE id_proforma = $2
                AND estado = 'aprobada'
                AND id_venta IS NULL
              RETURNING id_proforma`,
            [idVenta, datos.id_proforma],
          ));
          if (!convertida[0]) {
            throw new Error('COTIZACION_CONVERSION_CONFLICTO');
          }
        }

        this.log.log(`Venta ${idVenta} registrada por ${datos.total}`);
        return { id_venta: idVenta, existente: false };
      });
    } catch (error: any) {
      if (this.esViolacionUnica(error) && clave) {
        const existente = await this.buscarPorClaveIdempotencia(clave);
        if (existente) return { id_venta: existente, existente: true };
      }
      throw error;
    }
  }

  private async insertarCabecera(
    manager: Consultor,
    esquema: SnapshotEsquema,
    datos: DatosVenta,
    idCaja: number | null,
    clave: string | undefined,
  ): Promise<number> {
    const columnas: string[] = ['id_cliente', 'id_caja', 'subtotal', 'igv', 'total', 'origen'];
    const valores: unknown[] = [
      datos.id_cliente ?? null,
      idCaja,
      datos.subtotal,
      datos.igv,
      datos.total,
      datos.origen,
    ];
    if (esquema.tieneColumna('ventas', 'id_empresa')) {
      columnas.push('id_empresa');
      valores.push(datos.id_empresa ?? null);
    }
    if (esquema.tieneColumna('ventas', 'total_descuento')) {
      columnas.push('total_descuento');
      valores.push(datos.descuento);
    }
    if (clave) {
      columnas.push('clave_idempotencia');
      valores.push(clave);
    }
    const marcadores = valores.map((_, i) => `$${i + 1}`);
    const insertadas = await manager.query(
      `INSERT INTO ventas (${columnas.join(', ')}, fecha)
       VALUES (${marcadores.join(', ')}, NOW())
       RETURNING id_venta`,
      valores,
    );
    return Number(insertadas[0]?.id_venta);
  }

  /** Un solo INSERT para todas las líneas (antes, uno por línea). */
  private async insertarDetalle(manager: Consultor, idVenta: number, lineas: LineaVentaPersistida[]): Promise<void> {
    if (!lineas.length) return;
    await manager.query(
      `INSERT INTO detalle_venta
         (id_venta, id_producto, cantidad, precio, precio_lista_unitario,
          descuento_unitario_aplicado, descuento_total_linea, precio_unitario_final,
          subtotal, igv, total, id_regla_mayorista)
       SELECT $1, d.id_producto, d.cantidad, d.precio, d.precio_lista, d.descuento_unitario,
              d.descuento_linea, d.precio_final, d.subtotal, d.igv, d.total, d.id_regla
         FROM unnest(
                $2::int[], $3::numeric[], $4::numeric[], $5::numeric[], $6::numeric[],
                $7::numeric[], $8::numeric[], $9::numeric[], $10::numeric[], $11::numeric[], $12::bigint[]
              ) WITH ORDINALITY AS d(id_producto, cantidad, precio, precio_lista, descuento_unitario,
                                     descuento_linea, precio_final, subtotal, igv, total, id_regla, n)
        ORDER BY d.n`,
      [
        idVenta,
        lineas.map((l) => l.id_producto),
        lineas.map((l) => l.cantidad),
        lineas.map((l) => l.precio_unitario),
        lineas.map((l) => l.precio_lista_unitario),
        lineas.map((l) => l.descuento_unitario_aplicado),
        lineas.map((l) => l.descuento_total_linea),
        lineas.map((l) => l.precio_unitario_final),
        lineas.map((l) => l.subtotal),
        lineas.map((l) => l.igv),
        lineas.map((l) => l.total),
        lineas.map((l) => l.id_regla_mayorista ?? null),
      ],
    );
  }

  /** Un solo INSERT para todos los pagos; las columnas de cobro extendidas solo si existen. */
  private async insertarPagos(
    manager: Consultor,
    esquema: SnapshotEsquema,
    idVenta: number,
    pagos: PagoVentaPersistido[],
  ): Promise<void> {
    const conMonto = pagos.filter((p) => p.monto);
    if (!conMonto.length) return;

    const columnas: { nombre: string; tipo: string; valor: (p: PagoVentaPersistido) => unknown }[] = [
      { nombre: 'id_metodo', tipo: 'int', valor: (p) => p.id_metodo ?? null },
      { nombre: 'monto', tipo: 'numeric', valor: (p) => p.monto },
    ];
    const opcionales: { nombre: keyof PagoVentaPersistido; tipo: string }[] = [
      { nombre: 'referencia', tipo: 'text' },
      { nombre: 'monto_recibido', tipo: 'numeric' },
      { nombre: 'vuelto', tipo: 'numeric' },
      { nombre: 'id_cuenta_bancaria', tipo: 'int' },
      { nombre: 'voucher_pos', tipo: 'text' },
      { nombre: 'validacion', tipo: 'text' },
      { nombre: 'referencia_externa', tipo: 'text' },
    ];
    for (const o of opcionales) {
      if (esquema.tieneColumna('venta_pago', o.nombre)) {
        columnas.push({ nombre: o.nombre, tipo: o.tipo, valor: (p) => p[o.nombre] ?? null });
      }
    }

    const arreglos = columnas.map((c, i) => `$${i + 2}::${c.tipo}[]`);
    const alias = columnas.map((c) => c.nombre);
    await manager.query(
      `INSERT INTO venta_pago (id_venta, ${alias.join(', ')})
       SELECT $1, ${alias.map((a) => `p.${a}`).join(', ')}
         FROM unnest(${arreglos.join(', ')}) WITH ORDINALITY AS p(${alias.join(', ')}, n)
        ORDER BY p.n`,
      [idVenta, ...columnas.map((c) => conMonto.map((p) => c.valor(p)))],
    );
  }

  private esViolacionUnica(error: any): boolean {
    const codigo = String(error?.code ?? error?.driverError?.code ?? '');
    return codigo === '23505';
  }

  /** Bloquea y valida la cotización antes de tocar stock o crear la venta. */
  private async validarCotizacionParaVenta(
    manager: Consultor,
    idProforma: number,
    lineas: LineaVentaPersistida[],
  ): Promise<void> {
    const cotizaciones = await manager.query(
      `SELECT id_proforma, estado, id_venta
         FROM proformas
        WHERE id_proforma = $1
        FOR UPDATE`,
      [idProforma],
    );
    const cotizacion = cotizaciones[0];
    if (!cotizacion) throw new Error('COTIZACION_NO_ENCONTRADA');
    if (String(cotizacion.estado) === 'convertida' || cotizacion.id_venta) {
      throw new Error(`COTIZACION_YA_CONVERTIDA:${cotizacion.id_venta ?? ''}`);
    }
    if (String(cotizacion.estado) === 'anulada') throw new Error('COTIZACION_ANULADA');
    if (String(cotizacion.estado) !== 'aprobada') throw new Error('COTIZACION_NO_APROBADA');

    const items = await manager.query(
      `SELECT id_producto, cantidad, precio_unitario
         FROM proformas_items
        WHERE id_proforma = $1
        ORDER BY id_item`,
      [idProforma],
    );
    const cotizacionMap = this.agruparLineasCotizacion(items);
    const ventaMap = this.agruparLineasCotizacion(lineas);

    if (cotizacionMap.size !== ventaMap.size) {
      throw new Error('COTIZACION_ITEMS_CAMBIARON');
    }
    for (const [idProducto, esperado] of cotizacionMap) {
      const vendido = ventaMap.get(idProducto);
      if (!vendido || Number.isNaN(vendido.precio) || Number.isNaN(esperado.precio)
        || Math.abs(vendido.cantidad - esperado.cantidad) > 0.0001
        || Math.abs(vendido.precio - esperado.precio) > 0.005) {
        throw new Error('COTIZACION_ITEMS_CAMBIARON');
      }
    }
  }

  private agruparLineasCotizacion(
    lineas: Array<{ id_producto: number; cantidad: number; precio_unitario: number }>,
  ): Map<number, { cantidad: number; precio: number }> {
    const agrupadas = new Map<number, { cantidad: number; precio: number }>();
    for (const linea of lineas) {
      const idProducto = Number(linea.id_producto);
      const actual = agrupadas.get(idProducto);
      const cantidad = Number(linea.cantidad);
      const precio = Number(linea.precio_unitario);
      if (!actual) {
        agrupadas.set(idProducto, { cantidad, precio });
      } else {
        actual.cantidad += cantidad;
        if (Math.abs(actual.precio - precio) > 0.005) {
          actual.precio = Number.NaN;
        }
      }
    }
    return agrupadas;
  }

  /**
   * Rechequea cupo dentro de la TX (PostgreSQL FOR UPDATE) para evitar sobregiro
   * cuando dos cajas cobran crédito a la vez. Aritmética en céntimos.
   */
  private async assertCupoCreditoEnTx(
    manager: Consultor,
    credito: NonNullable<DatosVenta['credito']>,
  ): Promise<void> {
    const monto = Dinero.desdeNumeroRedondeado(Number(credito.monto));
    if (!monto.esPositivo()) return;

    const linea = await this.bloquearLineaCredito(manager, credito);
    if (!linea.activo) throw new Error('CREDITO_INACTIVO');

    const disponible = linea.limite.restar(linea.deuda);
    // Misma holgura de 5 céntimos que la validación previa de la venta.
    if (monto.centimos > disponible.centimos + 5) {
      throw new Error(`CREDITO_INSUFICIENTE:${disponible.aTexto()}:${linea.limite.aTexto()}:${linea.deuda.aTexto()}`);
    }
  }

  /**
   * Bloquea la fila del cliente o de la empresa (FOR UPDATE) y DESPUÉS lee su deuda en otra
   * consulta: en READ COMMITTED esa segunda lectura ve las cuentas que otra caja confirmó
   * mientras esperábamos el candado. Si la fila ya no existe (borrada a mitad de la venta)
   * lanza CREDITO_ENTIDAD con un mensaje claro, en vez de leer propiedades de undefined.
   */
  private async bloquearLineaCredito(
    manager: Consultor,
    credito: NonNullable<DatosVenta['credito']>,
  ): Promise<{ activo: boolean; limite: Dinero; deuda: Dinero }> {
    const tipo = credito.id_empresa ? 'empresa' : credito.id_cliente ? 'cliente' : null;
    if (!tipo) throw new Error('CREDITO_SIN_CLIENTE');
    const id = tipo === 'empresa' ? credito.id_empresa : credito.id_cliente;
    const sql = SQL_LINEA_CREDITO[tipo];

    const filas: { credito_activo: unknown; limite_credito: unknown }[] = await manager.query(sql.bloquear, [id]);
    const fila = filas[0];
    if (!fila) throw new Error(`CREDITO_ENTIDAD:${sql.noEncontrado}`);

    const deudas: { deuda: unknown }[] = await manager.query(sql.deuda, [id]);
    return {
      activo: fila.credito_activo === true || fila.credito_activo === 't',
      limite: Dinero.desdeBd(fila.limite_credito),
      deuda: Dinero.desdeBd(deudas[0]?.deuda),
    };
  }

  /**
   * Bloquea de una vez todas las filas de inventario de la venta, en orden fijo
   * (id_producto, id_almacen), reparte las cantidades (plan-salida-stock.ts) y aplica
   * los descuentos con un solo UPDATE. Devuelve de qué almacén salió cada unidad.
   */
  private async descontarStock(
    manager: Consultor,
    lineas: LineaVentaPersistida[],
    idAlmacenPreferido?: number,
  ): Promise<SalidaStock[]> {
    if (!lineas.length) return [];
    const exclusivo =
      idAlmacenPreferido != null
      && Number.isFinite(idAlmacenPreferido)
      && idAlmacenPreferido > 0;
    const ids = [...new Set(lineas.map((l) => Number(l.id_producto)))].sort((a, b) => a - b);

    const filas: any[] = await manager.query(
      `SELECT id_inventario, id_producto, id_almacen, stock
         FROM inventario
        WHERE id_producto = ANY($1::int[])
          ${exclusivo ? 'AND id_almacen = $2' : ''}
          AND stock > 0
        ORDER BY id_producto, id_almacen, id_inventario
          FOR UPDATE`,
      exclusivo ? [ids, idAlmacenPreferido] : [ids],
    );

    const plan = planificarSalidas(
      lineas.map((l) => ({ id_producto: Number(l.id_producto), cantidad: Number(l.cantidad) })),
      filas.map((f) => ({
        id_inventario: Number(f.id_inventario),
        id_producto: Number(f.id_producto),
        id_almacen: Number(f.id_almacen),
        stock: Number(f.stock),
      })),
      idAlmacenPreferido,
    );
    if (!plan.ok) {
      throw new Error(`STOCK_INSUFICIENTE:${plan.id_producto}:${plan.faltante}`);
    }

    if (plan.descuentos.length) {
      await manager.query(
        `UPDATE inventario AS i
            SET stock = i.stock - d.cantidad
           FROM unnest($1::int[], $2::numeric[]) AS d(id_inventario, cantidad)
          WHERE i.id_inventario = d.id_inventario`,
        [plan.descuentos.map((d) => d.id_inventario), plan.descuentos.map((d) => d.cantidad)],
      );
    }
    await this.registrarMovimientos(manager, plan.salidas, 'salida', 'Venta en mostrador');
    return plan.salidas;
  }

  /**
   * movimientos_inventario + kardex en dos INSERT (antes, 3 consultas por línea). La sucursal
   * sale del almacén con un JOIN, sin consultarla fila por fila.
   */
  private async registrarMovimientos(
    manager: Consultor,
    items: { id_producto: number; id_almacen: number; cantidad: number }[],
    tipo: 'entrada' | 'salida',
    descripcion: string,
  ): Promise<void> {
    if (!items.length) return;
    const productos = items.map((i) => i.id_producto);
    const cantidades = items.map((i) => i.cantidad);
    // Fragmentos fijos del código (no vienen del usuario): el tipo y a qué columna va la sucursal.
    const sql = SQL_MOVIMIENTO[tipo];

    await manager.query(
      `INSERT INTO movimientos_inventario
         (id_producto, tipo, cantidad, id_sucursal_origen, id_sucursal_destino, descripcion, fecha)
       SELECT m.id_producto, ${sql.tipo}, m.cantidad, ${sql.sucursales}, $4, NOW()
         FROM unnest($1::int[], $2::int[], $3::numeric[]) WITH ORDINALITY AS m(id_producto, id_almacen, cantidad, n)
         LEFT JOIN almacenes a ON a.id_almacen = m.id_almacen
        ORDER BY m.n`,
      [productos, items.map((i) => i.id_almacen), cantidades, descripcion],
    );

    await manager.query(
      `INSERT INTO kardex (id_producto, tipo_movimiento, cantidad, costo, fecha)
       SELECT m.id_producto, ${sql.tipo}, m.cantidad, COALESCE(p.precio_compra, 0), NOW()
         FROM unnest($1::int[], $2::numeric[]) WITH ORDINALITY AS m(id_producto, cantidad, n)
         JOIN productos p ON p.id_producto = m.id_producto
        ORDER BY m.n`,
      [productos, cantidades],
    );
  }

  /**
   * Caja abierta para la venta (Fase 7), en UNA consulta y con la misma prioridad de siempre:
   * 1) apertura del mismo usuario, 2) caja de la sucursal del almacén de despacho,
   * 3) cualquier caja abierta (legacy). Sin try/catch: dentro de la transacción un error
   * debe abortar la venta, no esconderse.
   */
  private async cajaAbierta(
    manager: Consultor,
    opts?: { idUsuario?: number; idAlmacen?: number },
  ): Promise<number | null> {
    const idUsuario =
      opts?.idUsuario != null && Number.isFinite(Number(opts.idUsuario)) && Number(opts.idUsuario) > 0
        ? Number(opts.idUsuario)
        : null;
    const idAlmacen =
      opts?.idAlmacen != null && Number.isFinite(Number(opts.idAlmacen)) && Number(opts.idAlmacen) > 0
        ? Number(opts.idAlmacen)
        : null;

    const filas = await manager.query(
      `SELECT a.id_caja
         FROM aperturas_caja a
         JOIN cajas c ON c.id_caja = a.id_caja
         LEFT JOIN almacenes al ON al.id_almacen = $2::int AND al.id_sucursal = c.id_sucursal
        WHERE NOT EXISTS (SELECT 1 FROM cierres_caja ci WHERE ci.id_apertura = a.id_apertura)
        ORDER BY COALESCE(a.id_usuario = $1::int, FALSE) DESC,
                 (al.id_almacen IS NOT NULL) DESC,
                 a.fecha DESC NULLS LAST,
                 a.id_apertura DESC
        LIMIT 1`,
      [idUsuario, idAlmacen],
    );
    return filas[0]?.id_caja != null ? Number(filas[0].id_caja) : null;
  }

  // ── Consultas ────────────────────────────────────────────────

  /** Cabecera, ítems y pagos en una sola consulta. */
  async obtener(idVenta: number): Promise<any | null> {
    const filas = await this.dataSource.query(
      `SELECT v.id_venta, v.fecha, v.subtotal, v.igv, v.total,
              COALESCE(v.origen, 'mostrador') AS origen,
              v.id_cliente,
              v.id_empresa,
              COALESCE(
                NULLIF(TRIM(CONCAT_WS(' ', c.nombre, c.apellido_paterno, c.apellido_materno)), ''),
                NULLIF(TRIM(COALESCE(e.razon_social, e.nombre_comercial, e.ruc)), ''),
                'CLIENTES VARIOS'
              ) AS cliente_denominacion,
              COALESCE((
                SELECT json_agg(json_build_object(
                         'id_producto', d.id_producto,
                         'cantidad', d.cantidad,
                         'precio', d.precio,
                         'descripcion', COALESCE(p.nombre, 'Producto')
                       ) ORDER BY d.id_detalle)
                  FROM detalle_venta d
                  LEFT JOIN productos p ON p.id_producto = d.id_producto
                 WHERE d.id_venta = v.id_venta
              ), '[]'::json) AS items,
              COALESCE((
                SELECT json_agg(json_build_object(
                         'id_metodo', vp.id_metodo,
                         'metodo', mp.nombre,
                         'monto', vp.monto
                       ) ORDER BY vp.id_metodo)
                  FROM venta_pago vp
                  LEFT JOIN metodos_pago mp ON mp.id_metodo = vp.id_metodo
                 WHERE vp.id_venta = v.id_venta
              ), '[]'::json) AS pagos
         FROM ventas v
         LEFT JOIN clientes c ON c.id_cliente = v.id_cliente
         LEFT JOIN empresas e ON e.id_empresa = v.id_empresa
        WHERE v.id_venta = $1`,
      [idVenta],
    );
    return filas[0] ?? null;
  }

  async listar(filtro: FiltroVentas): Promise<{ datos: any[]; total: number; pagina: number; por_pagina: number }> {
    const pagina = Math.max(1, Number(filtro.pagina) || 1);
    const porPagina = Math.min(100, Math.max(1, Number(filtro.por_pagina) || 20));

    const condiciones: string[] = ['1 = 1'];
    const parametros: any[] = [];

    if (filtro.texto?.trim()) {
      parametros.push(`%${filtro.texto.trim().toLowerCase().slice(0, LARGO_MAXIMO_BUSQUEDA)}%`);
      condiciones.push(
        `(LOWER(TRIM(CONCAT_WS(' ', c.nombre, c.apellido_paterno, c.apellido_materno))) LIKE $${parametros.length}
          OR LOWER(COALESCE(e.razon_social, '')) LIKE $${parametros.length}
          OR LOWER(COALESCE(e.nombre_comercial, '')) LIKE $${parametros.length}
          OR LOWER(COALESCE(e.ruc, '')) LIKE $${parametros.length}
          OR CAST(v.id_venta AS TEXT) LIKE $${parametros.length})`,
      );
    }
    // Días de Lima: las fechas se guardan en UTC sin zona (la BD está en Etc/UTC).
    if (filtro.desde) {
      parametros.push(filtro.desde);
      condiciones.push(`v.fecha >= ${sqlInicioDiaLima(`$${parametros.length}`)}`);
    }
    if (filtro.hasta) {
      parametros.push(filtro.hasta);
      condiciones.push(`v.fecha < ${sqlFinExclusivoDiaLima(`$${parametros.length}`)}`);
    }
    if (filtro.origen) {
      parametros.push(filtro.origen);
      condiciones.push(`COALESCE(v.origen, 'mostrador') = $${parametros.length}`);
    }

    const donde = condiciones.join(' AND ');
    const paramsDatos = [...parametros, porPagina, (pagina - 1) * porPagina];

    const [totales, datos] = await Promise.all([
      this.dataSource.query(
        `SELECT COUNT(*)::int AS total FROM ventas v
         LEFT JOIN clientes c ON c.id_cliente = v.id_cliente
         LEFT JOIN empresas e ON e.id_empresa = v.id_empresa
         WHERE ${donde}`,
        parametros,
      ),
      this.dataSource.query(
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
          LIMIT $${paramsDatos.length - 1} OFFSET $${paramsDatos.length}`,
        paramsDatos,
      ),
    ]);

    return { datos, total: totales[0]?.total ?? 0, pagina, por_pagina: porPagina };
  }

  /** Devuelve al inventario lo que salió por una venta anulada (mismo almacén) y cierra CxC. */
  async anularVentaCompleta(idVenta: number): Promise<{
    stock_devuelto: boolean;
    cxc_cerradas: number;
    ya_anulada: boolean;
  }> {
    await this.esquema.exigir('ventaEstado');
    const conStockSalida = await this.esquema.tiene('ventaStockSalida');
    const conCredito = await this.esquema.tiene('credito');

    return this.dataSource.transaction(async (manager) => {
      const cab = await manager.query(
        `SELECT id_venta, COALESCE(estado, 'activa') AS estado FROM ventas WHERE id_venta = $1 FOR UPDATE`,
        [idVenta],
      );
      if (!cab[0]) throw new Error('VENTA_NO_ENCONTRADA');
      if (String(cab[0].estado).toLowerCase() === 'anulada') {
        return { stock_devuelto: false, cxc_cerradas: 0, ya_anulada: true };
      }

      const salidas: { id_producto: number; id_almacen: number; cantidad: number }[] = conStockSalida
        ? (await manager.query(
            `SELECT id_producto, id_almacen, cantidad
               FROM venta_stock_salida WHERE id_venta = $1
              ORDER BY id_producto, id_almacen, id`,
            [idVenta],
          )).map((s: any) => ({
            id_producto: Number(s.id_producto),
            id_almacen: Number(s.id_almacen),
            cantidad: Number(s.cantidad),
          }))
        : [];

      const devueltas: { id_producto: number; id_almacen: number; cantidad: number }[] = [];
      if (salidas.length > 0) {
        for (const s of salidas) {
          await this.devolverAAlmacen(manager, s.id_producto, s.id_almacen, s.cantidad);
          devueltas.push(s);
        }
      } else {
        // Ventas anteriores a Fase 4: al almacén con más stock de cada producto.
        const lineas = await manager.query(
          `SELECT id_producto, cantidad FROM detalle_venta
            WHERE id_venta = $1 AND id_producto IS NOT NULL
            ORDER BY id_producto, id_detalle`,
          [idVenta],
        );
        for (const linea of lineas) {
          const existentes = await manager.query(
            `SELECT id_inventario, id_almacen FROM inventario
              WHERE id_producto = $1 ORDER BY stock DESC, id_almacen LIMIT 1 FOR UPDATE`,
            [linea.id_producto],
          );
          if (existentes[0]) {
            await manager.query('UPDATE inventario SET stock = stock + $1 WHERE id_inventario = $2', [
              Number(linea.cantidad),
              existentes[0].id_inventario,
            ]);
            devueltas.push({
              id_producto: Number(linea.id_producto),
              id_almacen: Number(existentes[0].id_almacen),
              cantidad: Number(linea.cantidad),
            });
          }
        }
      }
      await this.registrarMovimientos(manager, devueltas, 'entrada', 'Devolución por venta anulada');

      const cxc = conCredito
        ? filasDe(await manager.query(
            `UPDATE cuentas_por_cobrar
                SET saldo = 0, estado = 'anulado'
              WHERE id_venta = $1
                AND estado IN ('pendiente', 'parcial', 'vencido')
              RETURNING id_cxc`,
            [idVenta],
          ))
        : [];

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
    manager: Consultor,
    idProducto: number,
    idAlmacen: number,
    cantidad: number,
  ): Promise<void> {
    const filas = await manager.query(
      `SELECT id_inventario FROM inventario
        WHERE id_producto = $1 AND id_almacen = $2
        ORDER BY id_inventario
        LIMIT 1
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
  }

  async metodosPago(): Promise<{ id_metodo: number; nombre: string; tipo: string }[]> {
    try {
      return await this.dataSource.query(
        `SELECT id_metodo, nombre, COALESCE(tipo, '') AS tipo
           FROM metodos_pago
          WHERE COALESCE(activo, TRUE) = TRUE
          ORDER BY COALESCE(orden, id_metodo), id_metodo`,
      );
    } catch (error: any) {
      this.log.error(`No se pudieron leer los métodos de pago del POS: ${error?.message ?? error}`);
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
    } catch (error: any) {
      this.log.error(`No se pudieron leer los almacenes del POS: ${error?.message ?? error}`);
      return [];
    }
  }
}

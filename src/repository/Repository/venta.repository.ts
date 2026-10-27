import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { ProductoVentaResponse } from '../../models/model/venta/venta.response';
import { EsquemaCajaService, SnapshotEsquema } from '../../caja/esquema/esquema-caja.service';
import { planificarSalidas, SalidaStock } from '../../caja/ventas/plan-salida-stock';
import { Dinero } from '../../caja/dominio/dinero';
import { filasDe } from '../../caja/bd/resultado-consulta';
import { SQL_HOY_LIMA, sqlFinExclusivoDiaLima, sqlInicioDiaLima } from '../../util/fecha-lima';
import { TIPO_NOTA_CREDITO } from '../../util/fiscal/tipos-comprobante';
import type { EstadoSunat } from '../../sunat/nucleo/documento-fiscal.types';
import type { Paginado, VentaHistorialFila } from '../../models/model/venta/venta-documentos.response';
import {
  paginaDe,
  patronContiene,
  sqlEstadoVenta,
  sqlIsoLima,
  sqlJoinEmpresa,
  sqlPrincipalVigente,
} from './venta-documentos.repository';

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

/** Venta guardada con lo necesario para emitirle el comprobante después del cobro. */
export interface VentaParaComprobante {
  id_venta: number;
  /** 'activa' | 'anulada'. */
  estado: string;
  origen: string;
  total: number;
  id_cliente: number | null;
  id_empresa: number | null;
  lineas: {
    id_producto: number | null;
    descripcion: string;
    codigo: string;
    unidad_de_medida: string;
    codigo_sunat: string | null;
    cantidad: number;
    /** Precio unitario con IGV que se cobró (antes del descuento de la línea). */
    precio: number;
    precio_lista_unitario: number | null;
    /** Descuento de toda la línea, con IGV. Null en ventas anteriores a esa columna. */
    descuento_total_linea: number | null;
    subtotal: number | null;
    igv: number | null;
    total: number | null;
  }[];
  pagos: { id_metodo: number | null; monto: number; metodo: string; tipo: string }[];
  /** Cuenta por cobrar de la venta (si fue al crédito y no se anuló). */
  credito: { monto_total: number; saldo: number; fecha_vencimiento: string | null; estado: string } | null;
}

/** Filtro ya validado (ListarVentasRequest): desde/hasta son 'YYYY-MM-DD' (días de Lima). */
export interface FiltroVentas {
  /** Cliente (nombre o documento), número de venta o serie-número de cualquiera de sus comprobantes. */
  texto?: string;
  desde?: string;
  hasta?: string;
  origen?: string;
  /** 'activa' | 'anulada'. */
  estado?: string;
  /** 'si': con factura o boleta vigente; 'no': sin ninguna (o solo anuladas o con error). */
  tiene_comprobante?: string;
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

/** Cantidades de stock (NUMERIC(12,3)) en milésimas enteras: se suman y restan sin errores de coma flotante. */
function milesimas(valor: unknown): number {
  const numero = Number(valor ?? 0);
  return Number.isFinite(numero) ? Math.round(numero * 1000) : 0;
}

function desdeMilesimas(valor: number): number {
  return valor / 1000;
}

/** Suma por (producto, almacén) y ordena igual que se bloquea el inventario (id_producto, id_almacen). */
function agruparPorAlmacen(
  lineas: { id_producto: number; id_almacen: number; cantidad: number }[],
): { id_producto: number; id_almacen: number; cantidad: number }[] {
  const suma = new Map<string, { id_producto: number; id_almacen: number; cantidad: number }>();
  for (const linea of lineas) {
    if (!(linea.cantidad > 0)) continue;
    const clave = `${linea.id_producto}:${linea.id_almacen}`;
    const actual = suma.get(clave);
    if (actual) actual.cantidad = desdeMilesimas(milesimas(actual.cantidad) + milesimas(linea.cantidad));
    else suma.set(clave, { id_producto: linea.id_producto, id_almacen: linea.id_almacen, cantidad: linea.cantidad });
  }
  return [...suma.values()].sort((a, b) => a.id_producto - b.id_producto || a.id_almacen - b.id_almacen);
}

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

  /**
   * Trae los datos oficiales de los productos que se van a vender, con su código SUNAT
   * (catálogo 25). Se lee del registro como JSON para no fallar si falta la columna (fase 9).
   */
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
              ''                             AS imagen_url,
              NULLIF(TRIM(to_jsonb(p) ->> 'codigo_sunat'), '') AS codigo_sunat
         FROM productos p
         LEFT JOIN LATERAL (
                SELECT SUM(i.stock) AS stock FROM inventario i WHERE i.id_producto = p.id_producto
              ) inv ON TRUE
        WHERE p.id_producto = ANY($1::int[])`,
      [ids],
    );

    return new Map(
      filas.map((f: any) => [
        Number(f.id_producto),
        { ...this.mapProducto(f), codigo_sunat: f.codigo_sunat ? String(f.codigo_sunat) : null },
      ]),
    );
  }

  /**
   * Venta guardada tal como se cobró, para emitirle su comprobante después: cabecera, líneas
   * de detalle_venta (precio y descuento de ese momento, nunca los del catálogo actual), pagos
   * con su medio y la cuenta por cobrar si fue al crédito. null si la venta no existe.
   */
  async obtenerParaComprobante(idVenta: number): Promise<VentaParaComprobante | null> {
    const esquema = await this.esquema.snapshot();
    const conEstado = esquema.tieneColumna('ventas', 'estado');
    const conEmpresa = esquema.tieneColumna('ventas', 'id_empresa');

    const cabeceras = await this.dataSource.query(
      `SELECT v.id_venta, v.total, v.id_cliente,
              ${conEmpresa ? 'v.id_empresa' : 'NULL::int AS id_empresa'},
              COALESCE(v.origen, 'mostrador') AS origen,
              ${conEstado ? "COALESCE(v.estado, 'activa')" : "'activa'"} AS estado
         FROM ventas v
        WHERE v.id_venta = $1`,
      [idVenta],
    );
    const cabecera = cabeceras[0];
    if (!cabecera) return null;

    // Columnas de precios y descuentos como JSON: las ventas anteriores a esas columnas también se leen.
    const lineas = await this.dataSource.query(
      `SELECT d.id_producto,
              d.cantidad,
              d.precio,
              x.j ->> 'precio_lista_unitario'  AS precio_lista_unitario,
              x.j ->> 'descuento_total_linea'  AS descuento_total_linea,
              x.j ->> 'subtotal'               AS subtotal,
              x.j ->> 'igv'                    AS igv,
              x.j ->> 'total'                  AS total,
              COALESCE(p.nombre, 'Producto')   AS descripcion,
              COALESCE(NULLIF(p.sku, ''), NULLIF(p.codigo_barras, ''), d.id_producto::text, '') AS codigo,
              COALESCE(NULLIF(p.unidad_medida, ''), 'NIU') AS unidad_medida,
              NULLIF(TRIM(to_jsonb(p) ->> 'codigo_sunat'), '') AS codigo_sunat
         FROM detalle_venta d
        CROSS JOIN LATERAL (SELECT to_jsonb(d) AS j) x
         LEFT JOIN productos p ON p.id_producto = d.id_producto
        WHERE d.id_venta = $1
        ORDER BY d.id_detalle`,
      [idVenta],
    );

    const pagos = await this.dataSource.query(
      `SELECT vp.id_metodo, vp.monto, COALESCE(mp.nombre, '') AS metodo, COALESCE(mp.tipo, '') AS tipo
         FROM venta_pago vp
         LEFT JOIN metodos_pago mp ON mp.id_metodo = vp.id_metodo
        WHERE vp.id_venta = $1
        ORDER BY vp.id_metodo`,
      [idVenta],
    );

    let credito: VentaParaComprobante['credito'] = null;
    if (await this.esquema.tiene('credito')) {
      const cuentas = await this.dataSource.query(
        `SELECT monto_total, saldo, to_char(fecha_vencimiento, 'YYYY-MM-DD') AS fecha_vencimiento, estado
           FROM cuentas_por_cobrar
          WHERE id_venta = $1 AND COALESCE(estado, '') <> 'anulado'
          ORDER BY id_cxc DESC
          LIMIT 1`,
        [idVenta],
      );
      const cuenta = cuentas[0];
      if (cuenta) {
        credito = {
          monto_total: Number(cuenta.monto_total ?? 0),
          saldo: Number(cuenta.saldo ?? 0),
          fecha_vencimiento: cuenta.fecha_vencimiento ?? null,
          estado: String(cuenta.estado ?? ''),
        };
      }
    }

    const numero = (valor: unknown): number | null =>
      valor === null || valor === undefined || valor === '' || !Number.isFinite(Number(valor)) ? null : Number(valor);

    return {
      id_venta: Number(cabecera.id_venta),
      estado: String(cabecera.estado ?? 'activa'),
      origen: String(cabecera.origen ?? 'mostrador'),
      total: Number(cabecera.total ?? 0),
      id_cliente: cabecera.id_cliente != null ? Number(cabecera.id_cliente) : null,
      id_empresa: cabecera.id_empresa != null ? Number(cabecera.id_empresa) : null,
      lineas: lineas.map((l: any) => ({
        id_producto: l.id_producto != null ? Number(l.id_producto) : null,
        descripcion: String(l.descripcion ?? 'Producto'),
        codigo: String(l.codigo ?? ''),
        unidad_de_medida: String(l.unidad_medida ?? 'NIU'),
        codigo_sunat: l.codigo_sunat ? String(l.codigo_sunat) : null,
        cantidad: Number(l.cantidad ?? 0),
        precio: Number(l.precio ?? 0),
        precio_lista_unitario: numero(l.precio_lista_unitario),
        descuento_total_linea: numero(l.descuento_total_linea),
        subtotal: numero(l.subtotal),
        igv: numero(l.igv),
        total: numero(l.total),
      })),
      pagos: pagos.map((p: any) => ({
        id_metodo: p.id_metodo != null ? Number(p.id_metodo) : null,
        monto: Number(p.monto ?? 0),
        metodo: String(p.metodo ?? ''),
        tipo: String(p.tipo ?? ''),
      })),
      credito,
    };
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

  /**
   * Historial de ventas (GET /venta): cada fila con su comprobante principal VIGENTE (el mismo que cuenta para
   * D10: factura o boleta no anulada ni en error), los medios de pago y cuántas notas de crédito y guías tiene
   * (todas, en cualquier estado: las mismas que lista GET /venta/:id/documentos). El texto busca, sin comodines,
   * en el cliente (nombre, DNI, razón social, RUC), el número de venta y la serie-número de cualquiera de sus
   * comprobantes ('F001-00000012' o 'F001-12'). Sin comprobante vigente no van comprobante, id_comprobante,
   * serie ni número.
   */
  async listar(filtro: FiltroVentas): Promise<Paginado<VentaHistorialFila>> {
    const { pagina, porPagina } = paginaDe(filtro);
    const snapshot = await this.esquema.snapshot();
    const estado = sqlEstadoVenta(snapshot);

    const condiciones: string[] = ['1 = 1'];
    const parametros: unknown[] = [];

    const texto = filtro.texto?.trim().slice(0, LARGO_MAXIMO_BUSQUEDA);
    if (texto) {
      parametros.push(patronContiene(texto));
      const p = `$${parametros.length}`;
      condiciones.push(
        `(TRIM(CONCAT_WS(' ', c.nombre, c.apellido_paterno, c.apellido_materno)) ILIKE ${p} ESCAPE '\\'
          OR c.dni::text ILIKE ${p} ESCAPE '\\'
          OR LPAD(c.dni::text, 8, '0') ILIKE ${p} ESCAPE '\\'
          OR COALESCE(e.razon_social, '') ILIKE ${p} ESCAPE '\\'
          OR COALESCE(e.nombre_comercial, '') ILIKE ${p} ESCAPE '\\'
          OR COALESCE(e.ruc, '') ILIKE ${p} ESCAPE '\\'
          OR CAST(v.id_venta AS TEXT) ILIKE ${p} ESCAPE '\\'
          OR EXISTS (SELECT 1 FROM comprobantes s
                      WHERE s.id_venta = v.id_venta
                        AND ((s.serie || '-' || LPAD(s.numero::text, 8, '0')) ILIKE ${p} ESCAPE '\\'
                             OR (s.serie || '-' || s.numero::text) ILIKE ${p} ESCAPE '\\')))`,
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
    if (filtro.estado) {
      parametros.push(filtro.estado);
      condiciones.push(`${estado} = $${parametros.length}`);
    }
    if (filtro.tiene_comprobante === 'si' || filtro.tiene_comprobante === 'no') {
      const vigente = `EXISTS (SELECT 1 FROM comprobantes p WHERE p.id_venta = v.id_venta AND ${sqlPrincipalVigente('p')})`;
      condiciones.push(filtro.tiene_comprobante === 'si' ? vigente : `NOT ${vigente}`);
    }

    const donde = condiciones.join(' AND ');
    const tablas = `ventas v
           LEFT JOIN clientes c ON c.id_cliente = v.id_cliente
           ${sqlJoinEmpresa(snapshot)}`;
    const paramsDatos = [...parametros, porPagina, (pagina - 1) * porPagina];

    const [totales, filas] = await Promise.all([
      this.dataSource.query(`SELECT COUNT(*)::int AS total FROM ${tablas} WHERE ${donde}`, parametros),
      this.dataSource.query(
        `SELECT v.id_venta,
                ${sqlIsoLima('v.fecha')} AS fecha,
                COALESCE(v.total, 0)::text AS total,
                COALESCE(v.origen, 'mostrador') AS origen,
                v.id_cliente,
                ${snapshot.tieneColumna('ventas', 'id_empresa') ? 'v.id_empresa' : 'NULL::int AS id_empresa'},
                COALESCE(
                  NULLIF(TRIM(CONCAT_WS(' ', c.nombre, c.apellido_paterno, c.apellido_materno)), ''),
                  NULLIF(TRIM(COALESCE(e.razon_social, e.nombre_comercial, e.ruc)), ''),
                  'CLIENTES VARIOS'
                ) AS cliente_denominacion,
                (SELECT COUNT(*)::int FROM detalle_venta d WHERE d.id_venta = v.id_venta) AS cantidad_items,
                ${estado} AS estado,
                COALESCE((
                  SELECT string_agg(m.nombre, ', ' ORDER BY m.primero)
                    FROM (SELECT COALESCE(NULLIF(TRIM(mp.nombre), ''), 'Pago') AS nombre, MIN(p.id_metodo) AS primero
                            FROM venta_pago p
                            LEFT JOIN metodos_pago mp ON mp.id_metodo = p.id_metodo
                           WHERE p.id_venta = v.id_venta
                           GROUP BY 1) m
                ), '') AS metodos_pago,
                cp.id_comprobante, cp.serie, cp.numero, cp.id_tipo AS comprobante_tipo,
                cp.estado AS comprobante_estado, cp.estado_sunat AS comprobante_estado_sunat,
                (SELECT COUNT(*)::int FROM comprobantes n WHERE n.id_venta = v.id_venta AND n.id_tipo = ${TIPO_NOTA_CREDITO}) AS cantidad_notas,
                (SELECT COUNT(*)::int FROM guias_remision g WHERE g.id_venta = v.id_venta) AS cantidad_guias
           FROM ${tablas}
           LEFT JOIN LATERAL (
                  SELECT p.id_comprobante, p.serie, p.numero, p.id_tipo, p.estado, p.estado_sunat
                    FROM comprobantes p
                   WHERE p.id_venta = v.id_venta AND ${sqlPrincipalVigente('p')}
                   ORDER BY p.id_comprobante
                   LIMIT 1
                ) cp ON TRUE
          WHERE ${donde}
          ORDER BY v.fecha DESC NULLS LAST, v.id_venta DESC
          LIMIT $${paramsDatos.length - 1} OFFSET $${paramsDatos.length}`,
        paramsDatos,
      ),
    ]);

    return {
      datos: (filas as any[]).map((f) => this.filaHistorial(f)),
      total: Number((totales as any[])[0]?.total ?? 0),
      pagina,
      por_pagina: porPagina,
    };
  }

  /** Fila del historial con los tipos del contrato (VentaHistorialFila): números como número, ausentes sin clave. */
  private filaHistorial(f: any): VentaHistorialFila {
    const conComprobante = f.id_comprobante !== null && f.id_comprobante !== undefined;
    const serie = conComprobante ? String(f.serie ?? '') : '';
    const numero = conComprobante ? Number(f.numero) : 0;
    return {
      id_venta: Number(f.id_venta),
      fecha: String(f.fecha ?? ''),
      origen: String(f.origen ?? 'mostrador'),
      ...(f.id_cliente !== null && f.id_cliente !== undefined ? { id_cliente: Number(f.id_cliente) } : {}),
      ...(f.id_empresa !== null && f.id_empresa !== undefined ? { id_empresa: Number(f.id_empresa) } : {}),
      cliente_denominacion: String(f.cliente_denominacion ?? 'CLIENTES VARIOS'),
      total: Number(f.total ?? 0),
      cantidad_items: Number(f.cantidad_items ?? 0),
      estado: String(f.estado ?? 'activa'),
      metodos_pago: String(f.metodos_pago ?? ''),
      ...(conComprobante
        ? {
            comprobante: `${serie}-${String(numero).padStart(8, '0')}`,
            ...(f.comprobante_estado ? { comprobante_estado: String(f.comprobante_estado) } : {}),
            id_comprobante: Number(f.id_comprobante),
            serie,
            numero,
          }
        : {}),
      comprobante_tipo: conComprobante ? Number(f.comprobante_tipo) : null,
      comprobante_estado_sunat: conComprobante && f.comprobante_estado_sunat ? (String(f.comprobante_estado_sunat) as EstadoSunat) : null,
      cantidad_notas: Number(f.cantidad_notas ?? 0),
      cantidad_guias: Number(f.cantidad_guias ?? 0),
    };
  }

  /**
   * Anula la venta: devuelve a su almacén de salida lo que todavía no se devolvió (cantidad -
   * cantidad_devuelta; luego cantidad_devuelta = cantidad, así una nota de crédito previa no se
   * reingresa dos veces), cierra las cuentas por cobrar y marca la venta 'anulada'. Con `consultor`
   * corre dentro de la transacción de quien llama (los efectos de la nota que anula la venta, D8/D9).
   * Candados en orden fijo: venta → salidas de stock → inventario → cuentas por cobrar.
   */
  async anularVentaCompleta(
    idVenta: number,
    opciones: { consultor?: Consultor; descripcion?: string } = {},
  ): Promise<{
    stock_devuelto: boolean;
    cxc_cerradas: number;
    ya_anulada: boolean;
  }> {
    await this.esquema.exigir('ventaEstado');
    const conStockSalida = await this.esquema.tiene('ventaStockSalida');
    const conDevuelto = conStockSalida && (await this.esquema.tiene('ventaStockDevuelto'));
    const conCredito = await this.esquema.tiene('credito');

    const anular = async (manager: Consultor) => {
      const cab = await manager.query(
        `SELECT id_venta, COALESCE(estado, 'activa') AS estado FROM ventas WHERE id_venta = $1 FOR UPDATE`,
        [idVenta],
      );
      if (!cab[0]) throw new Error('VENTA_NO_ENCONTRADA');
      if (String(cab[0].estado).toLowerCase() === 'anulada') {
        return { stock_devuelto: false, cxc_cerradas: 0, ya_anulada: true };
      }

      const salidas: { id_producto: number; id_almacen: number; pendiente: number }[] = conStockSalida
        ? (await manager.query(
            `SELECT id_producto, id_almacen, cantidad${conDevuelto ? ', cantidad_devuelta' : ''}
               FROM venta_stock_salida WHERE id_venta = $1
              ORDER BY id_producto, id_almacen, id
                FOR UPDATE`,
            [idVenta],
          )).map((s: any) => ({
            id_producto: Number(s.id_producto),
            id_almacen: Number(s.id_almacen),
            pendiente: desdeMilesimas(milesimas(s.cantidad) - milesimas(s.cantidad_devuelta)),
          }))
        : [];

      const devueltas: { id_producto: number; id_almacen: number; cantidad: number }[] = [];
      if (salidas.length > 0) {
        for (const s of agruparPorAlmacen(salidas.map((x) => ({ ...x, cantidad: x.pendiente })))) {
          await this.devolverAAlmacen(manager, s.id_producto, s.id_almacen, s.cantidad);
          devueltas.push(s);
        }
        if (conDevuelto) {
          await manager.query(
            'UPDATE venta_stock_salida SET cantidad_devuelta = cantidad WHERE id_venta = $1 AND cantidad_devuelta < cantidad',
            [idVenta],
          );
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
      await this.registrarMovimientos(manager, devueltas, 'entrada', opciones.descripcion ?? 'Devolución por venta anulada');

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
        stock_devuelto: devueltas.length > 0,
        cxc_cerradas: (cxc ?? []).length,
        ya_anulada: false,
      };
    };

    return opciones.consultor ? anular(opciones.consultor) : this.dataSource.transaction(anular);
  }

  /**
   * Candado de la venta: el primero del orden fijo (venta → salidas de stock → inventario → cuentas
   * por cobrar) que comparten la anulación y los efectos de las notas de crédito. null si no existe.
   */
  async bloquearVenta(consultor: Consultor, idVenta: number): Promise<{ estado: string } | null> {
    const conEstado = await this.esquema.tiene('ventaEstado');
    const filas = await consultor.query(
      `SELECT ${conEstado ? "COALESCE(estado, 'activa')" : "'activa'"} AS estado FROM ventas WHERE id_venta = $1 FOR UPDATE`,
      [idVenta],
    );
    return filas[0] ? { estado: String(filas[0].estado) } : null;
  }

  /**
   * Devolución parcial por una nota de crédito aceptada (D8). Reparte lo acreditado de cada producto
   * entre las salidas de stock de la venta que aún no se devolvieron (orden fijo id_producto,
   * id_almacen, id; FOR UPDATE) y suma cantidad_devuelta, que nunca pasa de lo que salió. Con
   * `reingresar` esas unidades vuelven a su almacén (+ movimientos 'entrada' con la referencia de la
   * nota); sin él solo quedan marcadas como resueltas, para que una anulación posterior de la venta no
   * reingrese lo que el cliente devolvió y no volvió al almacén. Requiere fase14. Devuelve lo reingresado.
   */
  async devolverStockParcial(
    consultor: Consultor,
    idVenta: number,
    acreditado: { id_producto: number; cantidad: number }[],
    opciones: { reingresar: boolean; descripcion: string },
  ): Promise<{ id_producto: number; id_almacen: number; cantidad: number }[]> {
    const porProducto = new Map<number, number>();
    for (const linea of acreditado) {
      const cantidad = milesimas(linea.cantidad);
      if (cantidad > 0) porProducto.set(linea.id_producto, (porProducto.get(linea.id_producto) ?? 0) + cantidad);
    }
    if (!porProducto.size) return [];

    const salidas: { id: number; id_producto: number; id_almacen: number; libre: number }[] = (
      await consultor.query(
        `SELECT id, id_producto, id_almacen, cantidad, cantidad_devuelta
           FROM venta_stock_salida
          WHERE id_venta = $1 AND id_producto = ANY($2::int[])
          ORDER BY id_producto, id_almacen, id
            FOR UPDATE`,
        [idVenta, [...porProducto.keys()]],
      )
    ).map((s: any) => ({
      id: Number(s.id),
      id_producto: Number(s.id_producto),
      id_almacen: Number(s.id_almacen),
      libre: milesimas(s.cantidad) - milesimas(s.cantidad_devuelta),
    }));

    const marcadas: { id: number; id_producto: number; id_almacen: number; cantidad: number }[] = [];
    for (const salida of salidas) {
      const pendiente = porProducto.get(salida.id_producto) ?? 0;
      const devuelta = Math.min(pendiente, salida.libre);
      if (devuelta <= 0) continue;
      porProducto.set(salida.id_producto, pendiente - devuelta);
      marcadas.push({ id: salida.id, id_producto: salida.id_producto, id_almacen: salida.id_almacen, cantidad: desdeMilesimas(devuelta) });
    }
    if (!marcadas.length) return [];

    await consultor.query(
      `UPDATE venta_stock_salida AS s
          SET cantidad_devuelta = s.cantidad_devuelta + d.cantidad
         FROM unnest($1::int[], $2::numeric[]) AS d(id, cantidad)
        WHERE s.id = d.id`,
      [marcadas.map((m) => m.id), marcadas.map((m) => m.cantidad)],
    );
    if (!opciones.reingresar) return [];

    const reingresadas = agruparPorAlmacen(marcadas);
    for (const r of reingresadas) {
      await this.devolverAAlmacen(consultor, r.id_producto, r.id_almacen, r.cantidad);
    }
    await this.registrarMovimientos(consultor, reingresadas, 'entrada', opciones.descripcion);
    return reingresadas;
  }

  /**
   * Baja la deuda de la venta por una nota de crédito aceptada (D8): hasta `monto`, empezando por la
   * cuenta más antigua; la que llega a cero se cierra ('pagado' si tuvo abonos, 'anulado' si no). No
   * registra un abono: la nota no es un cobro y no debe aparecer en la caja. Devuelve cuánto bajó.
   */
  async ajustarCxcPorNota(
    consultor: Consultor,
    idVenta: number,
    monto: number,
  ): Promise<{ descontado: number; cerradas: number }> {
    let restante = Dinero.desdeNumeroRedondeado(monto);
    if (!restante.esPositivo() || !(await this.esquema.tiene('credito'))) return { descontado: 0, cerradas: 0 };

    const cuentas: { id_cxc: number; saldo: Dinero }[] = (
      await consultor.query(
        `SELECT id_cxc, saldo::text AS saldo
           FROM cuentas_por_cobrar
          WHERE id_venta = $1 AND estado IN ('pendiente', 'parcial', 'vencido') AND saldo > 0
          ORDER BY id_cxc
            FOR UPDATE`,
        [idVenta],
      )
    ).map((c: any) => ({ id_cxc: Number(c.id_cxc), saldo: Dinero.desdeBd(c.saldo) }));

    let descontado = Dinero.cero();
    let cerradas = 0;
    for (const cuenta of cuentas) {
      if (!restante.esPositivo()) break;
      const baja = restante.centimos < cuenta.saldo.centimos ? restante : cuenta.saldo;
      const nuevo = cuenta.saldo.restar(baja);
      await consultor.query(
        `UPDATE cuentas_por_cobrar c
            SET saldo = $2::numeric,
                estado = CASE
                  WHEN $2::numeric > 0 THEN c.estado
                  WHEN EXISTS (SELECT 1 FROM abonos_credito a WHERE a.id_cxc = c.id_cxc) THEN 'pagado'
                  ELSE 'anulado'
                END
          WHERE c.id_cxc = $1`,
        [cuenta.id_cxc, nuevo.aTexto()],
      );
      restante = restante.restar(baja);
      descontado = descontado.sumar(baja);
      if (nuevo.esCero()) cerradas += 1;
    }
    return { descontado: descontado.centimos / 100, cerradas };
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

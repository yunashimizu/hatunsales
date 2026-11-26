import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { filasDe } from '../caja/bd/resultado-consulta';

/** Fila cruda del historial de un cliente o empresa (Fase 3.2). */
export interface FilaUltimoProducto {
  id_producto: number;
  nombre: string;
  unidad_medida: string | null;
  precio: string | number | null;
  cantidad: string | number | null;
  fecha: Date | string;
  id_venta: number;
  precio_venta_actual: string | number | null;
  activo: boolean | null;
}

/** Fila cruda de los frecuentes del local (Fase 3.3). */
export interface FilaFrecuente {
  id_producto: number;
  nombre: string;
  precio_venta: string | number | null;
  descuento: string | number | null;
  unidad_medida: string | null;
  stock: string | number | null;
  ventas: string | number;
  cantidad: string | number;
}

/** Cuántas ventas recientes del cliente se miran para sacar sus últimos productos distintos. */
export const VENTAS_RECIENTES_MIRADAS = 60;

/**
 * Lecturas del punto de venta rápido (Fases 3.2 y 3.3). Solo SELECT, sin SQL nuevo:
 *  - historial por cliente: ventas por `ix_ventas_cliente` (fase15) o `idx_ventas_id_empresa`, y sus líneas
 *    por `ix_detalle_venta_venta` (fase15);
 *  - frecuentes: ventas de 30 días por `ix_ventas_fecha` y sus salidas de stock por
 *    `idx_venta_stock_salida_venta` (fase11).
 */
@Injectable()
export class PosRapidoRepository {
  constructor(@InjectDataSource('pgConnection') private readonly dataSource: DataSource) {}

  /**
   * Últimos productos distintos que compró el cliente (o la empresa), con el último precio unitario pagado
   * (después de descuentos), la cantidad y la fecha de esa compra. Ventas no anuladas si existe `estado`.
   */
  async ultimosProductos(
    por: 'cliente' | 'empresa',
    id: number,
    limite: number,
    conEstado: boolean,
  ): Promise<FilaUltimoProducto[]> {
    const columna = por === 'empresa' ? 'id_empresa' : 'id_cliente';
    const filtroEstado = conEstado ? `AND COALESCE(v.estado, 'activa') <> 'anulada'` : '';
    return filasDe<FilaUltimoProducto>(await this.dataSource.query(
      `WITH recientes AS (
         SELECT v.id_venta, v.fecha
           FROM ventas v
          WHERE v.${columna} = $1 ${filtroEstado}
          ORDER BY v.fecha DESC, v.id_venta DESC
          LIMIT ${VENTAS_RECIENTES_MIRADAS}
       ), por_producto AS (
         SELECT DISTINCT ON (d.id_producto)
                d.id_producto,
                COALESCE(d.precio_unitario_final, d.precio) AS precio,
                d.cantidad,
                r.fecha,
                r.id_venta
           FROM recientes r
           JOIN detalle_venta d ON d.id_venta = r.id_venta
          WHERE d.id_producto IS NOT NULL
          ORDER BY d.id_producto, r.fecha DESC, r.id_venta DESC, d.id_detalle DESC
       )
       SELECT pp.id_producto, COALESCE(p.nombre, '') AS nombre, p.unidad_medida, pp.precio, pp.cantidad,
              pp.fecha, pp.id_venta, p.precio_venta AS precio_venta_actual, p.estado AS activo
         FROM por_producto pp
         JOIN productos p ON p.id_producto = pp.id_producto
        ORDER BY pp.fecha DESC, pp.id_venta DESC, pp.id_producto
        LIMIT $2`,
      [id, limite],
    ));
  }

  /** Sucursal (local) de un almacén; undefined si el almacén no existe. */
  async sucursalDeAlmacen(idAlmacen: number): Promise<{ id_sucursal: number | null } | undefined> {
    const filas = filasDe<any>(await this.dataSource.query(
      'SELECT id_sucursal FROM almacenes WHERE id_almacen = $1',
      [idAlmacen],
    ));
    if (!filas.length) return undefined;
    return { id_sucursal: filas[0].id_sucursal == null ? null : Number(filas[0].id_sucursal) };
  }

  /**
   * Los más vendidos del LOCAL (almacenes de la misma sucursal) en los últimos `dias`, según las salidas de
   * stock de ventas no anuladas, ordenados por cuántas ventas los llevaron y luego por unidades. Solo
   * productos activos. Stock: el del almacén pedido. Sin costos ni montos.
   */
  async frecuentes(idAlmacen: number, idSucursal: number | null, dias: number, limite: number, conEstado: boolean, conDevueltos: boolean): Promise<FilaFrecuente[]> {
    const filtroEstado = conEstado ? `AND COALESCE(v.estado, 'activa') <> 'anulada'` : '';
    const neto = conDevueltos ? 'vss.cantidad - COALESCE(vss.cantidad_devuelta, 0)' : 'vss.cantidad';
    return filasDe<FilaFrecuente>(await this.dataSource.query(
      `WITH vendidos AS (
         SELECT vss.id_producto, COUNT(DISTINCT vss.id_venta) AS ventas, SUM(${neto}) AS cantidad
           FROM ventas v
           JOIN venta_stock_salida vss ON vss.id_venta = v.id_venta
           JOIN almacenes a ON a.id_almacen = vss.id_almacen
          WHERE v.fecha >= now() - make_interval(days => $3::int)
            ${filtroEstado}
            AND (a.id_almacen = $1 OR ($2::int IS NOT NULL AND a.id_sucursal = $2::int))
          GROUP BY vss.id_producto
       )
       SELECT p.id_producto, COALESCE(p.nombre, '') AS nombre, p.precio_venta, p.descuento, p.unidad_medida,
              COALESCE(i.stock, 0) AS stock, vd.ventas, vd.cantidad
         FROM vendidos vd
         JOIN productos p ON p.id_producto = vd.id_producto
         LEFT JOIN inventario i ON i.id_producto = p.id_producto AND i.id_almacen = $1
        WHERE COALESCE(p.estado, TRUE) AND vd.cantidad > 0
        ORDER BY vd.ventas DESC, vd.cantidad DESC, p.id_producto
        LIMIT $4`,
      [idAlmacen, idSucursal, dias, limite],
    ));
  }
}

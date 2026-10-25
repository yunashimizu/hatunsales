import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

/**
 * Convierte un pedido web en una venta del módulo administrativo.
 *
 * Se usa SQL directo a propósito: `ventas`, `detalle_venta` y `venta_pago` son
 * tablas del núcleo transaccional que no tienen entidad TypeORM, y no queremos
 * introducir una ahora para no alterar el comportamiento del admin.
 */
@Injectable()
export class VentaTiendaRepository {

  private readonly log = new Logger(VentaTiendaRepository.name);

  constructor(
    @InjectDataSource('pgConnection')
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Crea la venta con su detalle y su pago. Devuelve el id_venta.
   * Es idempotente: si el pedido ya tiene venta, devuelve la existente.
   *
   * La venta se queda con el stock que el pedido había reservado: se copia a
   * `venta_stock_salida` por almacén y el pedido deja de reservarlo. Así la
   * anulación de la venta (o una nota de crédito por devolución) lo repone en
   * el almacén del que salió, y una cancelación posterior del pedido no lo
   * devuelve otra vez.
   */
  async generarDesdePedido(idPedido: number): Promise<number | null> {
    return this.dataSource.transaction(async (manager) => {
      const pedidos = await manager.query(
        `SELECT id_pedido, id_cliente, id_venta, estado, stock_reservado, subtotal, igv, total, id_metodo_pago
           FROM pedidos WHERE id_pedido = $1 FOR UPDATE`,
        [idPedido],
      );

      const pedido = pedidos[0];
      if (!pedido) return null;
      if (pedido.id_venta) return Number(pedido.id_venta);

      // Un pedido cancelado (por ejemplo, mientras se confirmaba el pago) no se vende.
      if (pedido.estado === 'cancelado') {
        this.log.warn(`Pedido ${idPedido} cancelado: no se genera venta`);
        return null;
      }

      const idCaja = await this.cajaAbierta(manager);

      const ventas = await manager.query(
        `INSERT INTO ventas (id_cliente, id_caja, fecha, subtotal, igv, total, origen)
         VALUES ($1, $2, NOW(), $3, $4, $5, 'tienda')
         RETURNING id_venta`,
        [
          pedido.id_cliente,
          idCaja,
          Number(pedido.subtotal ?? 0),
          Number(pedido.igv ?? 0),
          Number(pedido.total ?? 0),
        ],
      );

      const idVenta = Number(ventas[0]?.id_venta);
      if (!idVenta) return null;

      // Un producto puede venir en varias líneas del pedido (una por almacén):
      // en la venta (y su comprobante) va una sola.
      await manager.query(
        `INSERT INTO detalle_venta (id_venta, id_producto, cantidad, precio)
         SELECT $1, pi.id_producto, SUM(pi.cantidad), pi.precio_unitario
           FROM pedido_items pi
          WHERE pi.id_pedido = $2 AND pi.id_producto IS NOT NULL
          GROUP BY pi.id_producto, pi.precio_unitario
          ORDER BY MIN(pi.id_pedido_item)`,
        [idVenta, idPedido],
      );

      if (pedido.id_metodo_pago) {
        await manager.query(
          `INSERT INTO venta_pago (id_venta, id_metodo, monto) VALUES ($1, $2, $3)`,
          [idVenta, pedido.id_metodo_pago, Number(pedido.total ?? 0)],
        );
      }

      const traspasaStock = pedido.stock_reservado === true && (await this.hayStockSalida(manager));
      if (traspasaStock) {
        await manager.query(
          `INSERT INTO venta_stock_salida (id_venta, id_producto, id_almacen, cantidad)
           SELECT $1, pi.id_producto, pi.id_almacen, SUM(pi.cantidad)
             FROM pedido_items pi
            WHERE pi.id_pedido = $2 AND pi.id_producto IS NOT NULL AND pi.id_almacen IS NOT NULL
            GROUP BY pi.id_producto, pi.id_almacen`,
          [idVenta, idPedido],
        );
      }

      await manager.query(
        traspasaStock
          ? 'UPDATE pedidos SET id_venta = $1, stock_reservado = FALSE, actualizado_en = NOW() WHERE id_pedido = $2'
          : 'UPDATE pedidos SET id_venta = $1, actualizado_en = NOW() WHERE id_pedido = $2',
        [idVenta, idPedido],
      );

      this.log.log(`Pedido ${idPedido} → venta ${idVenta}`);
      return idVenta;
    });
  }

  /** `venta_stock_salida` es de la fase 4; sin ella el pedido conserva su reserva como antes. */
  private async hayStockSalida(manager: { query: (sql: string, p?: any[]) => Promise<any> }): Promise<boolean> {
    const filas = await manager.query(`SELECT to_regclass('public.venta_stock_salida') IS NOT NULL AS existe`);
    return filas[0]?.existe === true;
  }

  /** Caja abierta más reciente, o null si la tienda opera sin caja física. */
  private async cajaAbierta(manager: { query: (sql: string, p?: any[]) => Promise<any> }): Promise<number | null> {
    try {
      const filas = await manager.query(
        `SELECT c.id_caja
           FROM cajas c
           JOIN aperturas_caja a ON a.id_caja = c.id_caja
          WHERE NOT EXISTS (
                  SELECT 1 FROM cierres_caja ci WHERE ci.id_apertura = a.id_apertura
                )
          ORDER BY a.fecha DESC
          LIMIT 1`,
      );
      return filas[0]?.id_caja ?? null;
    } catch {
      return null;
    }
  }
}

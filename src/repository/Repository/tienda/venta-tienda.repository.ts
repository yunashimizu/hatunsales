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
   */
  async generarDesdePedido(idPedido: number): Promise<number | null> {
    return this.dataSource.transaction(async (manager) => {
      const pedidos = await manager.query(
        `SELECT id_pedido, id_cliente, id_venta, subtotal, igv, total, id_metodo_pago
           FROM pedidos WHERE id_pedido = $1 FOR UPDATE`,
        [idPedido],
      );

      const pedido = pedidos[0];
      if (!pedido) return null;
      if (pedido.id_venta) return Number(pedido.id_venta);

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

      await manager.query(
        `INSERT INTO detalle_venta (id_venta, id_producto, cantidad, precio)
         SELECT $1, pi.id_producto, pi.cantidad, pi.precio_unitario
           FROM pedido_items pi
          WHERE pi.id_pedido = $2 AND pi.id_producto IS NOT NULL`,
        [idVenta, idPedido],
      );

      if (pedido.id_metodo_pago) {
        await manager.query(
          `INSERT INTO venta_pago (id_venta, id_metodo, monto) VALUES ($1, $2, $3)`,
          [idVenta, pedido.id_metodo_pago, Number(pedido.total ?? 0)],
        );
      }

      await manager.query('UPDATE pedidos SET id_venta = $1, actualizado_en = NOW() WHERE id_pedido = $2', [
        idVenta,
        idPedido,
      ]);

      this.log.log(`Pedido ${idPedido} → venta ${idVenta}`);
      return idVenta;
    });
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

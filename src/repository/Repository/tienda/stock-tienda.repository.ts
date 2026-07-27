import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

export interface LineaReserva {
  id_producto: number;
  cantidad: number;
}

export interface ReservaAplicada {
  id_producto: number;
  id_almacen: number;
  cantidad: number;
}

/**
 * Movimiento de stock del pedido web.
 *
 * Todo ocurre dentro de una transacción con `SELECT … FOR UPDATE`: mientras un
 * pedido descuenta, cualquier otro que toque las mismas filas espera. Así dos
 * clientes no pueden llevarse la misma última unidad.
 */
@Injectable()
export class StockTiendaRepository {

  constructor(
    @InjectDataSource('pgConnection')
    private readonly dataSource: DataSource,
  ) {}

  /** Lee una clave de la tabla `configuraciones`. */
  async configuracion(clave: string): Promise<string | null> {
    const filas = await this.dataSource.query(
      'SELECT valor FROM configuraciones WHERE clave = $1 LIMIT 1',
      [clave],
    );
    const valor = filas[0]?.valor;
    return valor === undefined || valor === null || valor === '' ? null : String(valor);
  }

  /**
   * Descuenta el stock de todas las líneas del pedido.
   * Devuelve de qué almacén salió cada una para poder revertirlo luego.
   * Si alguna línea no alcanza, se cae toda la transacción y no se descuenta nada.
   */
  async reservar(lineas: LineaReserva[], idAlmacenPreferido?: number): Promise<ReservaAplicada[]> {
    if (lineas.length === 0) return [];

    return this.dataSource.transaction(async (manager) => {
      const aplicadas: ReservaAplicada[] = [];

      for (const linea of lineas) {
        // Bloqueamos las filas de inventario del producto y priorizamos el
        // almacén configurado para la tienda; si no alcanza, seguimos con el
        // que tenga más stock.
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

          await manager.query(
            'UPDATE inventario SET stock = stock - $1 WHERE id_inventario = $2',
            [tomar, fila.id_inventario],
          );

          aplicadas.push({
            id_producto: linea.id_producto,
            id_almacen: Number(fila.id_almacen),
            cantidad: tomar,
          });

          pendiente -= tomar;
        }

        if (pendiente > 0) {
          throw new Error(`STOCK_INSUFICIENTE:${linea.id_producto}`);
        }
      }

      await this.registrarMovimientos(manager, aplicadas, 'salida', 'Reserva por pedido web');
      return aplicadas;
    });
  }

  /** Devuelve al inventario lo reservado por un pedido cancelado. */
  async devolver(idPedido: number): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const lineas = await manager.query(
        `SELECT id_producto, id_almacen, cantidad
           FROM pedido_items
          WHERE id_pedido = $1 AND id_producto IS NOT NULL AND id_almacen IS NOT NULL`,
        [idPedido],
      );

      for (const linea of lineas) {
        const existe = await manager.query(
          'SELECT id_inventario FROM inventario WHERE id_producto = $1 AND id_almacen = $2 LIMIT 1',
          [linea.id_producto, linea.id_almacen],
        );

        if (existe.length > 0) {
          await manager.query(
            'UPDATE inventario SET stock = stock + $1 WHERE id_inventario = $2',
            [Number(linea.cantidad), existe[0].id_inventario],
          );
        } else {
          // El almacén pudo darse de baja; recreamos la fila para no perder unidades.
          await manager.query(
            'INSERT INTO inventario (id_producto, id_almacen, stock, stock_minimo) VALUES ($1, $2, $3, 0)',
            [linea.id_producto, linea.id_almacen, Number(linea.cantidad)],
          );
        }
      }

      const aplicadas: ReservaAplicada[] = lineas.map((l: any) => ({
        id_producto: Number(l.id_producto),
        id_almacen: Number(l.id_almacen),
        cantidad: Number(l.cantidad),
      }));

      await this.registrarMovimientos(manager, aplicadas, 'entrada', 'Devolución por pedido cancelado');
    });
  }

  /** Deja rastro en kardex y movimientos_inventario, igual que el admin. */
  private async registrarMovimientos(
    manager: { query: (sql: string, params?: any[]) => Promise<any> },
    lineas: ReservaAplicada[],
    tipo: 'entrada' | 'salida',
    descripcion: string,
  ): Promise<void> {
    for (const linea of lineas) {
      const sucursal = await manager.query(
        'SELECT id_sucursal FROM almacenes WHERE id_almacen = $1 LIMIT 1',
        [linea.id_almacen],
      );
      const idSucursal = sucursal[0]?.id_sucursal ?? null;

      await manager.query(
        `INSERT INTO movimientos_inventario
           (id_producto, tipo, cantidad, id_sucursal_origen, id_sucursal_destino, descripcion, fecha)
         VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
        [
          linea.id_producto,
          tipo,
          linea.cantidad,
          tipo === 'salida' ? idSucursal : null,
          tipo === 'entrada' ? idSucursal : null,
          descripcion,
        ],
      );

      await manager.query(
        `INSERT INTO kardex (id_producto, tipo_movimiento, cantidad, costo, fecha)
         SELECT $1, $2, $3, COALESCE(p.precio_compra, 0), NOW()
           FROM productos p WHERE p.id_producto = $1`,
        [linea.id_producto, tipo, linea.cantidad],
      );
    }
  }
}

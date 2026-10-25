import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { ConfiguracionRepository } from '../configuracion.repository';
import { planificarSalidas } from '../../../caja/ventas/plan-salida-stock';

export interface LineaReserva {
  id_producto: number;
  cantidad: number;
}

export interface ReservaAplicada {
  id_producto: number;
  id_almacen: number;
  cantidad: number;
}

export type ModoStockTienda = 'exclusivo' | 'spillover';

export interface PoliticaStockTienda {
  /** exclusivo = solo tienda_id_almacen; spillover = puede derramar a otros. */
  modo: ModoStockTienda;
  /** Almacén de despacho web, si está configurado. */
  idAlmacen?: number;
  /** true cuando se descuenta solo de idAlmacen (sin derrame). */
  exclusivo: boolean;
}

/**
 * Movimiento de stock del pedido web.
 *
 * Todo ocurre dentro de una transacción con `SELECT … FOR UPDATE`: mientras un
 * pedido descuenta, cualquier otro que toque las mismas filas espera. Así dos
 * clientes no pueden llevarse la misma última unidad.
 *
 * Fase 6 (D2): por defecto exclusivo si hay `tienda_id_almacen` (como el POS).
 * `tienda_stock_modo=spillover` restaura el derrame legacy.
 */
@Injectable()
export class StockTiendaRepository {

  constructor(
    @InjectDataSource('pgConnection')
    private readonly dataSource: DataSource,
    private readonly config: ConfiguracionRepository,
  ) {}

  /** Lee una clave de la tabla `configuraciones` (con la caché de ConfiguracionRepository). */
  async configuracion(clave: string): Promise<string | null> {
    return this.config.obtener(clave);
  }

  /**
   * Política de stock web: exclusivo (default) o spillover. La piden cada página
   * del catálogo y del carrito, así que sale de la caché de configuración (60 s,
   * se invalida al guardar desde el panel): un cambio de almacén web tarda como
   * mucho eso en verse, igual que en el POS.
   */
  async politicaStock(): Promise<PoliticaStockTienda> {
    const [modoGuardado, configurado] = await Promise.all([
      this.configuracion('tienda_stock_modo'),
      this.configuracion('tienda_id_almacen'),
    ]);
    const modo: ModoStockTienda = (modoGuardado ?? 'exclusivo').toLowerCase() === 'spillover' ? 'spillover' : 'exclusivo';
    const idAlmacen = configurado ? Number(configurado) : NaN;
    const almacenOk = Number.isFinite(idAlmacen) && idAlmacen > 0 ? idAlmacen : undefined;
    const exclusivo = modo === 'exclusivo' && almacenOk != null;
    return { modo, idAlmacen: almacenOk, exclusivo };
  }

  /**
   * Descuenta el stock de todas las líneas del pedido.
   * Devuelve de qué almacén salió cada una para poder revertirlo luego.
   * Si alguna línea no alcanza, se cae toda la transacción y no se descuenta nada.
   *
   * Con almacén preferido y modo exclusivo: SOLO ese almacén (sin derrame).
   * Sin almacén o modo spillover: preferido primero, luego el de más stock.
   * `managerExterno`: participa de una TX externa (checkout atómico Fase 8).
   *
   * Bloquea todas las filas en UNA consulta y en el mismo orden fijo que el POS
   * (id_producto, id_almacen): antes se bloqueaba línea por línea ordenando por stock,
   * y dos checkouts simultáneos podían tomar las mismas filas en orden distinto
   * (deadlock). El reparto se decide después, en memoria (plan-salida-stock.ts).
   */
  async reservar(
    lineas: LineaReserva[],
    idAlmacenPreferido?: number,
    modo: ModoStockTienda = 'exclusivo',
    managerExterno?: EntityManager,
  ): Promise<ReservaAplicada[]> {
    if (lineas.length === 0) return [];

    const conAlmacen =
      idAlmacenPreferido != null
      && Number.isFinite(idAlmacenPreferido)
      && idAlmacenPreferido > 0;
    const exclusivo = modo !== 'spillover' && conAlmacen;
    const ids = [...new Set(lineas.map((l) => Number(l.id_producto)))].sort((a, b) => a - b);

    const ejecutar = async (manager: EntityManager) => {
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
        conAlmacen ? idAlmacenPreferido : undefined,
        { derrame: !exclusivo },
      );
      if (!plan.ok) {
        throw new Error(`STOCK_INSUFICIENTE:${plan.id_producto}`);
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

      const aplicadas: ReservaAplicada[] = plan.salidas.map((s) => ({
        id_producto: s.id_producto,
        id_almacen: s.id_almacen,
        cantidad: s.cantidad,
      }));
      await this.registrarMovimientos(manager, aplicadas, 'salida', 'Reserva por pedido web');
      return aplicadas;
    };

    if (managerExterno) return ejecutar(managerExterno);
    return this.dataSource.transaction(ejecutar);
  }

  /**
   * Devuelve al inventario lo reservado por un pedido cancelado: cada tramo del
   * pedido (una línea por producto y almacén) vuelve al almacén del que salió.
   * `managerExterno`: la cancelación pasa el suyo para que el cambio de estado y
   * la devolución sean todo o nada.
   * Repone en el orden fijo (id_producto, id_almacen) de `reservar` y del POS para no
   * cruzar candados con un checkout simultáneo.
   */
  async devolver(idPedido: number, managerExterno?: EntityManager): Promise<void> {
    const ejecutar = async (manager: EntityManager) => {
      const lineas = await manager.query(
        `SELECT id_producto, id_almacen, cantidad
           FROM pedido_items
          WHERE id_pedido = $1 AND id_producto IS NOT NULL AND id_almacen IS NOT NULL
          ORDER BY id_producto, id_almacen`,
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
    };

    if (managerExterno) return ejecutar(managerExterno);
    return this.dataSource.transaction(ejecutar);
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

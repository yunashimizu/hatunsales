import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Pedido } from '../../../models/DBModel/tienda/pedido.entity';
import { PedidoItem } from '../../../models/DBModel/tienda/pedido-item.entity';
import { PedidoEstado } from '../../../models/DBModel/tienda/pedido-estado.entity';
import { PedidoPago } from '../../../models/DBModel/tienda/pedido-pago.entity';
import { MetodoPago } from '../../../models/DBModel/tienda/metodo-pago.entity';

@Injectable()
export class PedidoRepository {

  constructor(
    @InjectRepository(Pedido, 'pgConnection')
    private readonly pedidoRepo: Repository<Pedido>,

    @InjectRepository(PedidoItem, 'pgConnection')
    private readonly itemRepo: Repository<PedidoItem>,

    @InjectRepository(PedidoEstado, 'pgConnection')
    private readonly estadoRepo: Repository<PedidoEstado>,

    @InjectRepository(PedidoPago, 'pgConnection')
    private readonly pagoRepo: Repository<PedidoPago>,
  ) {}

  private readonly relaciones = [
    'items',
    'items.producto',
    'historial',
    'direccion',
    'metodo_envio',
    'metodo_pago',
    'cliente',
  ];

  async crear(data: Partial<Pedido>): Promise<Pedido> {
    return this.pedidoRepo.save(this.pedidoRepo.create(data));
  }

  async guardarItems(items: Partial<PedidoItem>[]): Promise<PedidoItem[]> {
    return this.itemRepo.save(items.map((item) => this.itemRepo.create(item)));
  }

  async registrarEstado(idPedido: number, estado: string, comentario?: string): Promise<PedidoEstado> {
    return this.estadoRepo.save(
      this.estadoRepo.create({
        pedido: { id_pedido: idPedido } as Pedido,
        estado,
        comentario,
      }),
    );
  }

  async registrarPago(datos: Partial<PedidoPago> & { idPedido: number; idMetodo?: number }): Promise<PedidoPago> {
    const { idPedido, idMetodo, ...resto } = datos;

    return this.pagoRepo.save(
      this.pagoRepo.create({
        ...resto,
        pedido: { id_pedido: idPedido } as Pedido,
        metodo: idMetodo ? ({ id_metodo: idMetodo } as MetodoPago) : undefined,
        actualizado_en: new Date(),
      }),
    );
  }

  /** Pago ya registrado con la misma clave, para no cobrar dos veces. */
  async buscarPagoPorClave(idPedido: number, clave: string): Promise<PedidoPago | null> {
    return this.pagoRepo.findOne({
      where: { pedido: { id_pedido: idPedido }, clave_idempotencia: clave },
      relations: ['pedido'],
    });
  }

  async buscarPagoPorReferenciaExterna(proveedor: string, referencia: string): Promise<PedidoPago | null> {
    return this.pagoRepo.findOne({
      where: { proveedor, referencia_externa: referencia },
      relations: ['pedido'],
    });
  }

  /** Pedido creado en un intento anterior con la misma clave de idempotencia. */
  async buscarPorClaveIdempotencia(idCliente: number, clave: string): Promise<Pedido | null> {
    return this.pedidoRepo.findOne({
      where: { cliente: { id_cliente: idCliente }, clave_idempotencia: clave },
      relations: this.relaciones,
    });
  }

  async marcarStockReservado(idPedido: number, reservado: boolean, idAlmacen?: number): Promise<void> {
    await this.pedidoRepo.update(idPedido, {
      stock_reservado: reservado,
      ...(idAlmacen ? { id_almacen: idAlmacen } : {}),
      actualizado_en: new Date(),
    });
  }

  /** Asigna a cada línea el almacén del que salió su stock. */
  async asignarAlmacenAItems(idPedido: number, porProducto: Map<number, number>): Promise<void> {
    for (const [idProducto, idAlmacen] of porProducto) {
      await this.itemRepo
        .createQueryBuilder()
        .update()
        .set({ id_almacen: idAlmacen })
        .where('id_pedido = :idPedido AND id_producto = :idProducto', { idPedido, idProducto })
        .execute();
    }
  }

  async vincularComprobante(idPedido: number, idComprobante: number): Promise<void> {
    await this.pedidoRepo.update(idPedido, { id_comprobante: idComprobante, actualizado_en: new Date() });
  }

  /** Bitácora cruda de lo que envía la pasarela; sirve para conciliar. */
  async registrarEventoPasarela(evento: {
    proveedor: string;
    tipo?: string;
    referencia?: string;
    id_pedido?: number;
    payload?: any;
    procesado?: boolean;
    error?: string;
  }): Promise<void> {
    await this.pedidoRepo.manager.query(
      `INSERT INTO pasarela_eventos (proveedor, tipo, referencia, id_pedido, payload, procesado, error)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT DO NOTHING`,
      [
        evento.proveedor,
        evento.tipo ?? null,
        evento.referencia ?? null,
        evento.id_pedido ?? null,
        evento.payload ? JSON.stringify(evento.payload) : null,
        evento.procesado ?? false,
        evento.error ?? null,
      ],
    );
  }

  async marcarEventoProcesado(proveedor: string, referencia?: string): Promise<void> {
    if (!referencia) return;
    await this.pedidoRepo.manager.query(
      'UPDATE pasarela_eventos SET procesado = TRUE WHERE proveedor = $1 AND referencia = $2',
      [proveedor, referencia],
    );
  }

  async listarPorCliente(idCliente: number): Promise<Pedido[]> {
    return this.pedidoRepo.find({
      where: { cliente: { id_cliente: idCliente } },
      relations: this.relaciones,
      order: { creado_en: 'DESC' },
    });
  }

  async obtenerPorId(idPedido: number): Promise<Pedido | null> {
    return this.pedidoRepo.findOne({
      where: { id_pedido: idPedido },
      relations: this.relaciones,
    });
  }

  async obtenerPorCodigo(codigo: string): Promise<Pedido | null> {
    return this.pedidoRepo.findOne({
      where: { codigo },
      relations: this.relaciones,
    });
  }

  async listarTodos(estado?: string): Promise<Pedido[]> {
    return this.pedidoRepo.find({
      where: estado ? { estado } : {},
      relations: this.relaciones,
      order: { creado_en: 'DESC' },
    });
  }

  async cambiarEstado(idPedido: number, estado: string): Promise<void> {
    await this.pedidoRepo.update(idPedido, { estado, actualizado_en: new Date() });
  }

  async contarDelDia(): Promise<number> {
    const rows = await this.pedidoRepo.manager.query(
      `SELECT COUNT(*)::INTEGER AS total FROM pedidos WHERE DATE(creado_en) = CURRENT_DATE`,
    );
    return Number(rows[0]?.total ?? 0);
  }
}

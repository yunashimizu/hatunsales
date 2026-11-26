import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { Pedido } from '../../../models/DBModel/tienda/pedido.entity';
import { PedidoItem } from '../../../models/DBModel/tienda/pedido-item.entity';
import { PedidoEstado } from '../../../models/DBModel/tienda/pedido-estado.entity';
import { PedidoPago } from '../../../models/DBModel/tienda/pedido-pago.entity';
import { MetodoPago } from '../../../models/DBModel/tienda/metodo-pago.entity';
import { filasDe } from '../../../caja/bd/resultado-consulta';

/** Cobro a registrar en `pedido_pagos`. */
export type DatosPago = Partial<PedidoPago> & { idPedido: number; idMetodo?: number };

/** Lo que queda del pedido justo después de cambiarle el estado (leído con la fila bloqueada). */
export interface PedidoTransicionado {
  id_pedido: number;
  stock_reservado: boolean;
  id_venta: number | null;
  /** Cupón del pedido (Fase 8.2: la cancelación devuelve su uso). */
  id_cupon: number | null;
}

/**
 * Fase 8.2: un pedido con un cobro en curso (pago manual pendiente de confirmar) o ya aprobado no se vence.
 * Va dentro del UPDATE condicional: un pago que entra entre la búsqueda y la cancelación la frena.
 */
const SIN_PAGO_EN_CURSO = `AND NOT EXISTS (
            SELECT 1 FROM pedido_pagos pp
             WHERE pp.id_pedido = p.id_pedido
               AND pp.estado IN ('pendiente', 'aprobado')
          )`;

/** Fase 8.2: con qué plazo vence un pedido sin pagar. */
export type ClaseVencimiento = 'pasarela' | 'transferencia';

/** Una venta generada desde el pedido sigue vigente mientras no esté anulada. */
const SIN_VENTA_VIGENTE = `AND NOT EXISTS (
            SELECT 1 FROM ventas v
             WHERE v.id_venta = p.id_venta
               AND COALESCE(v.estado, 'activa') <> 'anulada'
          )`;

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

  private pedidos(manager?: EntityManager): Repository<Pedido> {
    return manager ? manager.getRepository(Pedido) : this.pedidoRepo;
  }

  private items(manager?: EntityManager): Repository<PedidoItem> {
    return manager ? manager.getRepository(PedidoItem) : this.itemRepo;
  }

  private estados(manager?: EntityManager): Repository<PedidoEstado> {
    return manager ? manager.getRepository(PedidoEstado) : this.estadoRepo;
  }

  async crear(data: Partial<Pedido>, manager?: EntityManager): Promise<Pedido> {
    const repo = this.pedidos(manager);
    return repo.save(repo.create(data));
  }

  /** Código definitivo del pedido, que se arma con su id una vez insertado. */
  async asignarCodigo(idPedido: number, codigo: string, manager?: EntityManager): Promise<void> {
    await (manager ?? this.pedidoRepo.manager).query(
      'UPDATE pedidos SET codigo = $2 WHERE id_pedido = $1',
      [idPedido, codigo],
    );
  }

  async guardarItems(items: Partial<PedidoItem>[], manager?: EntityManager): Promise<PedidoItem[]> {
    const repo = this.items(manager);
    return repo.save(items.map((item) => repo.create(item)));
  }

  async registrarEstado(
    idPedido: number,
    estado: string,
    comentario?: string,
    manager?: EntityManager,
  ): Promise<PedidoEstado> {
    const repo = this.estados(manager);
    return repo.save(
      repo.create({
        pedido: { id_pedido: idPedido } as Pedido,
        estado,
        comentario,
      }),
    );
  }

  /**
   * Cambia el estado solo si el pedido sigue en uno de `desde` y deja el rastro
   * en el historial. Es un UPDATE condicional: si otro proceso (webhook,
   * confirmación, cancelación) lo movió antes, devuelve null y no toca nada.
   * Con `sinVentaVigente` tampoco cambia si el pedido tiene una venta sin anular.
   */
  async transicionarEstado(
    idPedido: number,
    desde: readonly string[],
    hacia: string,
    comentario?: string,
    manager?: EntityManager,
    opciones: { sinVentaVigente?: boolean; sinPagoEnCurso?: boolean } = {},
  ): Promise<PedidoTransicionado | null> {
    const ejecutar = async (m: EntityManager): Promise<PedidoTransicionado | null> => {
      const [fila] = filasDe<any>(await m.query(
        `UPDATE pedidos p
            SET estado = $2, actualizado_en = NOW()
          WHERE p.id_pedido = $1
            AND p.estado = ANY($3::text[])
          ${opciones.sinVentaVigente ? SIN_VENTA_VIGENTE : ''}
          ${opciones.sinPagoEnCurso ? SIN_PAGO_EN_CURSO : ''}
          RETURNING p.id_pedido, p.stock_reservado, p.id_venta, p.id_cupon`,
        [idPedido, hacia, [...desde]],
      ));
      if (!fila) return null;

      await this.registrarEstado(idPedido, hacia, comentario, m);
      return {
        id_pedido: Number(fila.id_pedido),
        stock_reservado: fila.stock_reservado === true,
        id_venta: fila.id_venta === null || fila.id_venta === undefined ? null : Number(fila.id_venta),
        id_cupon: fila.id_cupon === null || fila.id_cupon === undefined ? null : Number(fila.id_cupon),
      };
    };

    return manager ? ejecutar(manager) : this.pedidoRepo.manager.transaction(ejecutar);
  }

  /**
   * 'pendiente' → 'pagado' junto con el cobro que lo respalda, todo o nada.
   * Devuelve false si el pedido ya no estaba pendiente (cancelado o pagado por
   * otra vía): en ese caso no se registra nada.
   */
  async confirmarPago(idPedido: number, comentario: string, pago?: DatosPago): Promise<boolean> {
    return this.pedidoRepo.manager.transaction(async (manager) => {
      const cambiado = await this.transicionarEstado(idPedido, ['pendiente'], 'pagado', comentario, manager);
      if (!cambiado) return false;
      if (pago) await this.registrarPago(pago, manager);
      return true;
    });
  }

  async registrarPago(datos: DatosPago, manager?: EntityManager): Promise<PedidoPago> {
    const repo = manager ? manager.getRepository(PedidoPago) : this.pagoRepo;
    const { idPedido, idMetodo, ...resto } = datos;

    return repo.save(
      repo.create({
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

  async marcarStockReservado(
    idPedido: number,
    reservado: boolean,
    idAlmacen?: number,
    manager?: EntityManager,
  ): Promise<void> {
    await this.pedidos(manager).update(idPedido, {
      stock_reservado: reservado,
      ...(idAlmacen ? { id_almacen: idAlmacen } : {}),
      actualizado_en: new Date(),
    });
  }

  /**
   * Fase 8.2: pedidos web pendientes que llevan más de `horas` sin pagarse, sin venta y sin un cobro en curso
   * o aprobado. `clase` según el medio de pago del pedido: `pasarela` (tarjeta, pasarela) o `transferencia`
   * (transferencia, billetera, sin medio y cualquier otro). El pago contra entrega (`efectivo`) y el crédito
   * nunca vencen: se cobran después, a propósito. Corre con un candado consultivo de transacción: con varias
   * réplicas solo una busca en cada vuelta (las demás reciben []).
   */
  async pedidosVencidos(horas: { pasarela: number; transferencia: number }, limite: number): Promise<{ id_pedido: number; clase: ClaseVencimiento; horas: number }[]> {
    const pasarela = Math.max(0, Math.trunc(horas.pasarela) || 0);
    const transferencia = Math.max(0, Math.trunc(horas.transferencia) || 0);
    if (!pasarela && !transferencia) return [];
    return this.pedidoRepo.manager.transaction(async (manager) => {
      const candado = filasDe<{ ok: unknown }>(await manager.query('SELECT pg_try_advisory_xact_lock(hashtext($1)) AS ok', ['tienda:vencimiento-pedidos']));
      if (!(candado[0]?.ok === true || candado[0]?.ok === 't')) return [];
      // Horas en 0 = esa clase no vence (la condición queda falsa con NULL).
      const filas = filasDe<any>(await manager.query(
        `SELECT q.id_pedido, q.clase
           FROM (
             SELECT p.id_pedido, p.creado_en,
                    CASE WHEN LOWER(COALESCE(mp.tipo, '')) IN ('tarjeta', 'pasarela') THEN 'pasarela'
                         WHEN LOWER(COALESCE(mp.tipo, '')) IN ('efectivo', 'credito') THEN NULL
                         ELSE 'transferencia' END AS clase
               FROM pedidos p
               LEFT JOIN metodos_pago mp ON mp.id_metodo = p.id_metodo_pago
              WHERE p.estado = 'pendiente'
                AND p.id_venta IS NULL
                ${SIN_PAGO_EN_CURSO}
           ) q
          WHERE (q.clase = 'pasarela' AND $1::int > 0 AND q.creado_en < clock_timestamp()::timestamp - make_interval(hours => $1::int))
             OR (q.clase = 'transferencia' AND $2::int > 0 AND q.creado_en < clock_timestamp()::timestamp - make_interval(hours => $2::int))
          ORDER BY q.creado_en ASC, q.id_pedido ASC
          LIMIT $3`,
        [pasarela, transferencia, Math.max(1, Math.trunc(limite))],
      ));
      return filas.map((f) => ({
        id_pedido: Number(f.id_pedido),
        clase: f.clase as ClaseVencimiento,
        horas: f.clase === 'pasarela' ? pasarela : transferencia,
      }));
    });
  }

  /** Estado de la venta generada desde el pedido ('activa', 'anulada'…), o null si no existe. */
  async estadoVenta(idVenta: number): Promise<string | null> {
    const filas = await this.pedidoRepo.manager.query(
      `SELECT COALESCE(estado, 'activa') AS estado FROM ventas WHERE id_venta = $1`,
      [idVenta],
    );
    return filas[0]?.estado ?? null;
  }

  async vincularComprobante(idPedido: number, idComprobante: number): Promise<void> {
    await this.pedidoRepo.update(idPedido, { id_comprobante: idComprobante, actualizado_en: new Date() });
  }

  /**
   * Bitácora cruda de lo que envía la pasarela; sirve para conciliar.
   * Devuelve el id del evento, o undefined si era un reenvío ya guardado.
   */
  async registrarEventoPasarela(evento: {
    proveedor: string;
    tipo?: string;
    referencia?: string;
    id_pedido?: number;
    payload?: any;
    procesado?: boolean;
    error?: string;
  }): Promise<number | undefined> {
    const filas = filasDe<{ id_evento: number }>(await this.pedidoRepo.manager.query(
      `INSERT INTO pasarela_eventos (proveedor, tipo, referencia, id_pedido, payload, procesado, error)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT DO NOTHING
       RETURNING id_evento`,
      [
        evento.proveedor,
        evento.tipo ?? null,
        evento.referencia ?? null,
        evento.id_pedido ?? null,
        evento.payload ? JSON.stringify(evento.payload) : null,
        evento.procesado ?? false,
        evento.error ?? null,
      ],
    ));
    const id = Number(filas[0]?.id_evento);
    return Number.isInteger(id) && id > 0 ? id : undefined;
  }

  /**
   * Anota cómo terminó un evento: aplicado, o por qué no se aplicó. Un reenvío
   * que no generó fila propia solo puede marcar como procesado el original
   * (nunca le pisa el motivo con el de un reintento).
   */
  async cerrarEventoPasarela(
    evento: { idEvento?: number; proveedor: string; referencia?: string },
    resultado: { procesado: boolean; error?: string },
  ): Promise<void> {
    if (evento.idEvento) {
      await this.pedidoRepo.manager.query(
        'UPDATE pasarela_eventos SET procesado = $2, error = $3 WHERE id_evento = $1',
        [evento.idEvento, resultado.procesado, resultado.error ?? null],
      );
      return;
    }

    if (!resultado.procesado || !evento.referencia) return;
    await this.pedidoRepo.manager.query(
      'UPDATE pasarela_eventos SET procesado = TRUE WHERE proveedor = $1 AND referencia = $2',
      [evento.proveedor, evento.referencia],
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

  /**
   * Pedidos web por preparar (pendientes de pago y pagados) en una sola consulta.
   * Misma consulta que `ReportesRepository.contarPedidosWeb` (resumen diario); se
   * mantiene duplicada a propósito para no reorganizar el resumen diario.
   */
  async contarPorPreparar(): Promise<{ pendientes: number; pagados: number }> {
    const filas = filasDe<{ estado: string; total: number | string }>(await this.pedidoRepo.manager.query(
      `SELECT estado, COUNT(*)::int AS total
         FROM pedidos
        WHERE estado IN ('pendiente', 'pagado')
        GROUP BY estado`,
    ));
    const de = (estado: string) => Number(filas.find((f) => f.estado === estado)?.total ?? 0);
    return { pendientes: de('pendiente'), pagados: de('pagado') };
  }
}

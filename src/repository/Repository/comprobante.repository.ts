import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource, Brackets } from 'typeorm';
import { Comprobante } from '../../models/DBModel/c-electronico/comprobante.entity';
import { ComprobanteItem } from '../../models/DBModel/c-electronico/comprobante-item.entity';
import { CrudRepository } from '../Irepository/GenericIRepository/crud.Irepository';

export interface FiltroComprobantes {
  texto?: string;
  id_tipo?: number;
  estado?: string;
  desde?: string;
  hasta?: string;
  pagina?: number;
  por_pagina?: number;
}

@Injectable()
export class ComprobanteRepository extends CrudRepository<Comprobante> {

  constructor(
    @InjectRepository(Comprobante, 'pgConnection')
    private readonly comprobanteRepo: Repository<Comprobante>,

    @InjectRepository(ComprobanteItem, 'pgConnection')
    private readonly itemRepo: Repository<ComprobanteItem>,
  ) {
    super(comprobanteRepo);
  }

  private get dataSource(): DataSource {
    return this.comprobanteRepo.manager.connection;
  }

  // ── Consultas ────────────────────────────────────────────────

  buscarPorSerieNumero(serie: string, numero: number): Promise<Comprobante | null> {
    return this.comprobanteRepo.findOne({
      where: { serie, numero },
      relations: ['items', 'cliente', 'tipo', 'moneda'],
    });
  }

  buscarPorId(id_comprobante: number): Promise<Comprobante | null> {
    return this.comprobanteRepo.findOne({
      where: { id_comprobante },
      relations: ['items', 'cliente', 'tipo', 'moneda'],
    });
  }

  async buscarUltimoNumeroPorSerie(serie: string): Promise<number> {
    const fila = await this.comprobanteRepo
      .createQueryBuilder('c')
      .select('COALESCE(MAX(c.numero), 0)', 'ultimo')
      .where('c.serie = :serie', { serie })
      .getRawOne();
    return Number(fila?.ultimo ?? 0);
  }

  listarPorVenta(id_venta: number): Promise<Comprobante[]> {
    return this.comprobanteRepo.find({
      where: { id_venta },
      relations: ['items', 'cliente', 'tipo', 'moneda'],
      order: { creado_en: 'DESC' },
    });
  }

  listarPorCliente(id_cliente: number): Promise<Comprobante[]> {
    return this.comprobanteRepo
      .createQueryBuilder('c')
      .leftJoinAndSelect('c.items', 'items')
      .leftJoinAndSelect('c.tipo', 'tipo')
      .leftJoinAndSelect('c.moneda', 'moneda')
      .where('c.id_cliente = :id_cliente', { id_cliente })
      .orderBy('c.creado_en', 'DESC')
      .getMany();
  }

  /**
   * Listado paginado para la pantalla de documentos. Reemplaza al recorrido que
   * pedía los comprobantes cliente por cliente.
   */
  async listar(filtro: FiltroComprobantes): Promise<{ datos: Comprobante[]; total: number; pagina: number; por_pagina: number }> {
    const pagina = Math.max(1, Number(filtro.pagina) || 1);
    const porPagina = Math.min(100, Math.max(1, Number(filtro.por_pagina) || 20));

    const query = this.comprobanteRepo
      .createQueryBuilder('c')
      .leftJoinAndSelect('c.tipo', 'tipo')
      .leftJoinAndSelect('c.moneda', 'moneda')
      .leftJoinAndSelect('c.cliente', 'cliente');

    if (filtro.id_tipo) {
      query.andWhere('c.id_tipo = :idTipo', { idTipo: filtro.id_tipo });
    }

    if (filtro.estado) {
      if (filtro.estado === 'anulado') query.andWhere('c.anulado = true');
      else query.andWhere('c.estado = :estado AND c.anulado = false', { estado: filtro.estado });
    }

    if (filtro.desde) query.andWhere('c.creado_en >= :desde', { desde: filtro.desde });
    if (filtro.hasta) query.andWhere('c.creado_en <= :hasta', { hasta: `${filtro.hasta} 23:59:59` });

    const texto = filtro.texto?.trim();
    if (texto) {
      query.andWhere(
        new Brackets((qb) => {
          qb.where('LOWER(c.cliente_denominacion) LIKE :patron', { patron: `%${texto.toLowerCase()}%` })
            .orWhere('c.cliente_numero_doc LIKE :patron', { patron: `%${texto}%` })
            .orWhere("UPPER(c.serie || '-' || LPAD(c.numero::text, 8, '0')) LIKE :serie", {
              serie: `%${texto.toUpperCase()}%`,
            });
        }),
      );
    }

    const [datos, total] = await query
      .orderBy('c.creado_en', 'DESC')
      .skip((pagina - 1) * porPagina)
      .take(porPagina)
      .getManyAndCount();

    return { datos, total, pagina, por_pagina: porPagina };
  }

  // ── Escritura ────────────────────────────────────────────────

  /**
   * Reserva el correlativo y deja el comprobante en estado pendiente antes de
   * salir a la red.
   *
   * Se hace así para que un fallo a mitad del envío deje rastro: si NUBEFACT
   * aceptó el documento pero la respuesta nunca llegó, la fila queda pendiente
   * y se puede reconsultar, en vez de perder el número y emitir otro encima.
   *
   * El bloqueo de aviso serializa a los cajeros que emiten en la misma serie al
   * mismo tiempo, que es lo que produce números duplicados.
   */
  async reservarCorrelativo(
    datos: Partial<Comprobante>,
    items: Partial<ComprobanteItem>[],
    numeroSolicitado?: number,
  ): Promise<Comprobante> {
    return this.dataSource.transaction(async (manager) => {
      const serie = datos.serie as string;

      await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`comprobante:${serie}`]);

      // Tras borrar duplicados a mano la secuencia del PK puede quedar atrás
      // del MAX(id) y el siguiente INSERT choca con comprobantes_pkey.
      await manager.query(`
        DO $seq$
        DECLARE
          seq_comp text := pg_get_serial_sequence('comprobantes', 'id_comprobante');
          seq_item text := pg_get_serial_sequence('comprobante_items', 'id_item');
          max_comp bigint;
          max_item bigint;
        BEGIN
          IF seq_comp IS NOT NULL THEN
            SELECT COALESCE(MAX(id_comprobante), 1) INTO max_comp FROM comprobantes;
            PERFORM setval(seq_comp, max_comp, true);
          END IF;
          IF seq_item IS NOT NULL THEN
            SELECT COALESCE(MAX(id_item), 1) INTO max_item FROM comprobante_items;
            PERFORM setval(seq_item, max_item, true);
          END IF;
        END
        $seq$;
      `);

      let numero = numeroSolicitado;

      if (numero && numero > 0) {
        const ocupado = await manager.findOne(Comprobante, { where: { serie, numero } });
        if (ocupado) {
          throw new Error(`El número ${serie}-${String(numero).padStart(8, '0')} ya fue emitido`);
        }
      } else {
        const fila = await manager
          .createQueryBuilder(Comprobante, 'c')
          .select('COALESCE(MAX(c.numero), 0)', 'ultimo')
          .where('c.serie = :serie', { serie })
          .getRawOne();
        numero = Number(fila?.ultimo ?? 0) + 1;
      }

      const comprobante = await manager.save(
        Comprobante,
        manager.create(Comprobante, { ...datos, numero, estado: 'pendiente' }),
      );

      if (items.length) {
        await manager.save(
          ComprobanteItem,
          items.map((i) => manager.create(ComprobanteItem, { ...i, comprobante })),
        );
      }

      return comprobante;
    });
  }

  async actualizarRespuesta(id: number, data: Partial<Comprobante>): Promise<void> {
    await this.comprobanteRepo.update(id, data);
  }

  async marcarError(id: number, mensaje: string): Promise<void> {
    await this.comprobanteRepo.update(id, {
      estado: 'error',
      error_mensaje: mensaje.slice(0, 1000),
      aceptada_sunat: false,
    });
  }

  async eliminar(id: number): Promise<void> {
    await this.itemRepo.delete({ comprobante: { id_comprobante: id } as any });
    await this.comprobanteRepo.delete(id);
  }

  /** Comprobante emitido para una venta, si existe, sin traer relaciones. */
  async existePorVenta(id_venta: number): Promise<boolean> {
    const cuenta = await this.comprobanteRepo.count({ where: { id_venta, anulado: false } });
    return cuenta > 0;
  }
}

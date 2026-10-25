import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource, Brackets, EntityManager } from 'typeorm';
import { Comprobante } from '../../models/DBModel/c-electronico/comprobante.entity';
import { sqlFinExclusivoDiaLima, sqlInicioDiaLima } from '../../util/fecha-lima';
import { TIPO_BOLETA, TIPO_FACTURA } from '../../util/fiscal/tipos-comprobante';

export interface FiltroComprobantes {
  texto?: string;
  id_tipo?: number;
  estado?: string;
  estado_sunat?: string;
  ambiente?: string;
  /** yyyy-mm-dd (día de Lima), ya validado por la capa de negocio. */
  desde?: string;
  hasta?: string;
  pagina?: number;
  por_pagina?: number;
}

/** Conexión de una transacción abierta (EntityManager o QueryRunner): solo query() con parámetros $n. */
type Consultor = Pick<EntityManager, 'query'>;

/**
 * El número candidato ya no es el siguiente libre de la serie (otro cajero lo usó entre la
 * preparación y la reserva). El motor vuelve a preparar el documento con `siguiente`.
 */
export class NumeroOcupadoError extends Error {
  constructor(
    readonly serie: string,
    readonly numero: number,
    readonly siguiente: number,
  ) {
    super(`El número ${serie}-${String(numero).padStart(8, '0')} ya no está libre; el siguiente es ${siguiente}.`);
    this.name = 'NumeroOcupadoError';
  }
}

/** Datos de la nota que se guardan junto a la cabecera (enlace con el comprobante que modifica). */
export interface DatosNotaNueva {
  doc_modificado_tipo: string;
  doc_modificado_serie: string;
  doc_modificado_numero: number;
  id_comprobante_modificado: number;
  nota_motivo: string;
  nota_sustento: string;
  /** Solo se guardan si existen las columnas de fase14. */
  efecto_nota: string;
  reingresar_stock: boolean;
}

/** Cabecera de un comprobante nuevo de emisión directa (siempre nace pendiente y sin enviar). */
export interface FilaComprobanteNueva {
  id_venta: number | null;
  id_cliente: number | null;
  id_tipo: number;
  id_moneda: number;
  serie: string;
  numero: number;
  cliente_tipo_doc: number;
  cliente_numero_doc: string;
  cliente_denominacion: string;
  cliente_direccion: string | null;
  cliente_email: string | null;
  /** dd-mm-yyyy, como lo guarda el resto del sistema. */
  fecha_de_emision: string;
  fecha_de_vencimiento: string;
  porcentaje_igv: number;
  total_gravada: number;
  total_exonerada: number;
  total_inafecta: number;
  total_descuento: number;
  total_igv: number;
  total: number;
  importe_en_letras: string;
  observaciones: string;
  enviar_cliente: boolean;
  ambiente_fiscal: 'beta' | 'produccion';
  id_usuario: number | null;
  nota?: DatosNotaNueva;
}

export interface FilaItemNueva {
  id_producto: number | null;
  unidad_de_medida: string;
  codigo: string;
  codigo_producto_sunat: string | null;
  descripcion: string;
  cantidad: number;
  valor_unitario: number;
  precio_unitario: number;
  descuento: number;
  subtotal: number;
  tipo_de_igv: number;
  igv: number;
  total: number;
  /** Solo notas de crédito: ítem del comprobante origen (se guarda si existe la columna de fase14). */
  id_item_origen?: number | null;
}

export interface ComprobanteVigenteVenta {
  id_comprobante: number;
  serie: string;
  numero: number;
  estado: string | null;
}

/** Columnas de fase 9 / 12 que la entidad no mapea, más el emisor con el que se firmó (del envío). */
export interface DatosFiscalesComprobante {
  forma_pago: string | null;
  cuotas: unknown;
  fecha_limite_envio: string | null;
  hora_emision: string | null;
  doc_modificado_tipo: string | null;
  doc_modificado_serie: string | null;
  doc_modificado_numero: number | null;
  id_comprobante_modificado: number | null;
  nota_motivo: string | null;
  nota_sustento: string | null;
  emisor_envio: Record<string, unknown> | null;
  hora_envio: string | null;
}

export interface DatosListadoComprobante {
  fecha_limite_envio: string | null;
  doc_modificado_tipo: string | null;
  doc_modificado_serie: string | null;
  doc_modificado_numero: number | null;
  id_comprobante_modificado: number | null;
  /** Acción que indicó SUNAT en el último envío (REINTENTAR, RECUPERAR_CDR…). */
  envio_accion: string | null;
  /** El último envío no está bloqueado por otro proceso (su plazo de bloqueo venció o no tiene). */
  envio_libre: boolean | null;
}

export interface NotaEnlazada {
  id_comprobante: number;
  id_tipo: number;
  serie: string;
  numero: number;
  total: number;
  estado: string | null;
  estado_sunat: string | null;
  anulado: boolean;
  aceptada_sunat: boolean;
  motivo: string | null;
}

export interface GuiaEnlazada {
  id_guia: number;
  serie: string | null;
  numero: number | null;
  estado: string | null;
  fecha_emision: string | null;
}

/** Columnas que la entidad no mapea y que el código usa solo si existen (fase 9, 12 y 14). */
const COLUMNAS_OPCIONALES: Readonly<Record<string, readonly string[]>> = {
  comprobantes: [
    'hora_emision', 'forma_pago', 'cuotas', 'fecha_limite_envio', 'doc_modificado_tipo', 'doc_modificado_serie',
    'doc_modificado_numero', 'id_comprobante_modificado', 'nota_motivo', 'nota_sustento', 'efecto_nota',
    'reingresar_stock', 'efectos_aplicados',
  ],
  comprobante_items: ['id_item_origen'],
  fiscal_envios: ['respuesta_json', 'bloqueado_hasta'],
};

/** Enlace de una nota con su origen (fase 9): sin estas columnas la nota no se puede guardar. */
export const COLUMNAS_NOTA: readonly string[] = [
  'comprobantes.doc_modificado_tipo',
  'comprobantes.doc_modificado_serie',
  'comprobantes.doc_modificado_numero',
  'comprobantes.id_comprobante_modificado',
  'comprobantes.nota_motivo',
  'comprobantes.nota_sustento',
];

const COLUMNAS_EFECTOS_NOTA: readonly string[] = [
  'comprobantes.efecto_nota',
  'comprobantes.reingresar_stock',
  'comprobantes.efectos_aplicados',
];

/** Si falta alguna columna opcional, el catálogo se relee como máximo cada minuto (detecta el script recién aplicado). */
const RELECTURA_ESQUEMA_MS = 60_000;

const PATRON_UNICO_SERIE_NUMERO = /uq_comprobantes_serie_numero/i;

function esViolacionUnicaSerieNumero(error: unknown): boolean {
  const e = error as { code?: string; constraint?: string; driverError?: { code?: string; constraint?: string } };
  const codigo = String(e?.code ?? e?.driverError?.code ?? '');
  const restriccion = String(e?.constraint ?? e?.driverError?.constraint ?? '');
  return codigo === '23505' && PATRON_UNICO_SERIE_NUMERO.test(restriccion);
}

/** correlativo_inicial válido: entero ≥ 1 (cualquier otra cosa vuelve a 1). */
function pisoValido(piso: unknown): number {
  const numero = Number(piso);
  return Number.isSafeInteger(numero) && numero >= 1 ? numero : 1;
}

function numeroONulo(valor: unknown): number | null {
  if (valor === null || valor === undefined || valor === '') return null;
  const numero = Number(valor);
  return Number.isFinite(numero) ? numero : null;
}

function textoONulo(valor: unknown): string | null {
  return valor === null || valor === undefined ? null : String(valor);
}

/** Comodines de ILIKE escritos por el usuario: se buscan literalmente. */
function escaparComodines(texto: string): string {
  return texto.replace(/[\\%_]/g, (caracter) => `\\${caracter}`);
}

@Injectable()
export class ComprobanteRepository {

  private esquema: { columnas: ReadonlySet<string>; leidoEn: number; completo: boolean } | null = null;

  constructor(
    @InjectRepository(Comprobante, 'pgConnection')
    private readonly comprobanteRepo: Repository<Comprobante>,
  ) {}

  private get dataSource(): DataSource {
    return this.comprobanteRepo.manager.connection;
  }

  // ── Consultas ────────────────────────────────────────────────

  buscarPorSerieNumero(serie: string, numero: number): Promise<Comprobante | null> {
    return this.comprobanteRepo.findOne({
      where: { serie, numero },
      relations: ['items', 'cliente', 'tipo', 'moneda'],
      order: { items: { id_item: 'ASC' } },
    });
  }

  buscarPorId(id_comprobante: number): Promise<Comprobante | null> {
    return this.comprobanteRepo.findOne({
      where: { id_comprobante },
      relations: ['items', 'cliente', 'tipo', 'moneda'],
      order: { items: { id_item: 'ASC' } },
    });
  }

  /**
   * Comprobantes de la venta con el principal vigente primero (factura o boleta no anulada ni
   * en error), luego los demás principales y al final las notas; dentro de cada grupo, el más reciente.
   */
  async listarPorVenta(id_venta: number): Promise<Comprobante[]> {
    const lista = await this.comprobanteRepo.find({
      where: { id_venta },
      relations: ['items', 'cliente', 'tipo', 'moneda'],
      order: { creado_en: 'DESC' },
    });
    const grupo = (c: Comprobante): number => {
      const principal = c.tipo?.id_tipo === TIPO_FACTURA || c.tipo?.id_tipo === TIPO_BOLETA;
      if (!principal) return 2;
      return !c.anulado && c.estado !== 'error' ? 0 : 1;
    };
    return lista
      .map((c, orden) => ({ c, orden }))
      .sort((a, b) => grupo(a.c) - grupo(b.c) || a.orden - b.orden)
      .map(({ c }) => c);
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

    if (filtro.estado_sunat) query.andWhere('c.estado_sunat = :estadoSunat', { estadoSunat: filtro.estado_sunat });
    if (filtro.ambiente) query.andWhere('c.ambiente_fiscal = :ambiente', { ambiente: filtro.ambiente });

    // Días de Lima: creado_en guarda la hora UTC (la BD está en Etc/UTC).
    if (filtro.desde) query.andWhere(`c.creado_en >= ${sqlInicioDiaLima(':desde')}`, { desde: filtro.desde });
    if (filtro.hasta) query.andWhere(`c.creado_en < ${sqlFinExclusivoDiaLima(':hasta')}`, { hasta: filtro.hasta });

    const texto = filtro.texto?.trim().slice(0, 100);
    if (texto) {
      const patron = `%${escaparComodines(texto)}%`;
      query.andWhere(
        new Brackets((qb) => {
          qb.where(`c.cliente_denominacion ILIKE :patron ESCAPE '\\'`, { patron })
            .orWhere(`c.cliente_numero_doc ILIKE :patron ESCAPE '\\'`, { patron })
            .orWhere(`(c.serie || '-' || LPAD(c.numero::text, 8, '0')) ILIKE :patron ESCAPE '\\'`, { patron });
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

  /**
   * Lo que el listado necesita y la entidad no mapea, para una página de comprobantes en una
   * sola consulta: plazo de envío, enlace de las notas y estado del último envío a SUNAT.
   */
  async datosListado(ids: number[]): Promise<Map<number, DatosListadoComprobante>> {
    const unicos = [...new Set(ids.filter((id) => Number.isInteger(id) && id > 0))];
    if (!unicos.length) return new Map();
    const conEnvio = await this.tieneColumnas('fiscal_envios.respuesta_json', 'fiscal_envios.bloqueado_hasta');

    const filas: any[] = await this.dataSource.query(
      `SELECT c.id_comprobante,
              x.j ->> 'fecha_limite_envio'        AS fecha_limite_envio,
              x.j ->> 'doc_modificado_tipo'       AS doc_modificado_tipo,
              x.j ->> 'doc_modificado_serie'      AS doc_modificado_serie,
              x.j ->> 'doc_modificado_numero'     AS doc_modificado_numero,
              x.j ->> 'id_comprobante_modificado' AS id_comprobante_modificado,
              ${conEnvio
                ? `e.respuesta_json #>> '{clasificacion,accion}' AS envio_accion,
                   CASE WHEN e.id_envio IS NULL THEN NULL
                        ELSE (e.bloqueado_hasta IS NULL OR e.bloqueado_hasta < NOW()) END AS envio_libre`
                : 'NULL::text AS envio_accion, NULL::boolean AS envio_libre'}
         FROM comprobantes c
        CROSS JOIN LATERAL (SELECT to_jsonb(c) AS j) x
        ${conEnvio ? 'LEFT JOIN fiscal_envios e ON e.id_envio = c.id_envio_ultimo' : ''}
        WHERE c.id_comprobante = ANY($1::int[])`,
      [unicos],
    );

    return new Map(
      filas.map((f) => [
        Number(f.id_comprobante),
        {
          fecha_limite_envio: textoONulo(f.fecha_limite_envio),
          doc_modificado_tipo: textoONulo(f.doc_modificado_tipo),
          doc_modificado_serie: textoONulo(f.doc_modificado_serie),
          doc_modificado_numero: numeroONulo(f.doc_modificado_numero),
          id_comprobante_modificado: numeroONulo(f.id_comprobante_modificado),
          envio_accion: textoONulo(f.envio_accion),
          envio_libre: f.envio_libre === null || f.envio_libre === undefined ? null : f.envio_libre === true || f.envio_libre === 't',
        },
      ]),
    );
  }

  /** Datos fiscales del comprobante que no están en la entidad, y el emisor con el que se firmó. */
  async datosFiscales(id_comprobante: number): Promise<DatosFiscalesComprobante | null> {
    const conEnvio = await this.tieneColumnas('fiscal_envios.respuesta_json');
    const filas: any[] = await this.dataSource.query(
      `SELECT x.j ->> 'forma_pago'                AS forma_pago,
              x.j -> 'cuotas'                     AS cuotas,
              x.j ->> 'fecha_limite_envio'        AS fecha_limite_envio,
              x.j ->> 'hora_emision'              AS hora_emision,
              x.j ->> 'doc_modificado_tipo'       AS doc_modificado_tipo,
              x.j ->> 'doc_modificado_serie'      AS doc_modificado_serie,
              x.j ->> 'doc_modificado_numero'     AS doc_modificado_numero,
              x.j ->> 'id_comprobante_modificado' AS id_comprobante_modificado,
              x.j ->> 'nota_motivo'               AS nota_motivo,
              x.j ->> 'nota_sustento'             AS nota_sustento,
              ${conEnvio
                ? `e.respuesta_json #> '{documento,emisor}' AS emisor_envio,
                   e.respuesta_json #>> '{documento,horaEmision}' AS hora_envio`
                : 'NULL::jsonb AS emisor_envio, NULL::text AS hora_envio'}
         FROM comprobantes c
        CROSS JOIN LATERAL (SELECT to_jsonb(c) AS j) x
        ${conEnvio ? 'LEFT JOIN fiscal_envios e ON e.id_envio = c.id_envio_ultimo' : ''}
        WHERE c.id_comprobante = $1`,
      [id_comprobante],
    );
    const f = filas[0];
    if (!f) return null;
    return {
      forma_pago: textoONulo(f.forma_pago),
      cuotas: f.cuotas ?? null,
      fecha_limite_envio: textoONulo(f.fecha_limite_envio),
      hora_emision: textoONulo(f.hora_emision),
      doc_modificado_tipo: textoONulo(f.doc_modificado_tipo),
      doc_modificado_serie: textoONulo(f.doc_modificado_serie),
      doc_modificado_numero: numeroONulo(f.doc_modificado_numero),
      id_comprobante_modificado: numeroONulo(f.id_comprobante_modificado),
      nota_motivo: textoONulo(f.nota_motivo),
      nota_sustento: textoONulo(f.nota_sustento),
      emisor_envio: f.emisor_envio && typeof f.emisor_envio === 'object' ? f.emisor_envio : null,
      hora_envio: textoONulo(f.hora_envio),
    };
  }

  /** Notas (crédito o débito) que modifican al comprobante. Sin la columna de fase 9 no hay ninguna. */
  async notasDe(id_comprobante: number): Promise<NotaEnlazada[]> {
    if (!(await this.tieneColumnas('comprobantes.id_comprobante_modificado'))) return [];
    const filas: any[] = await this.dataSource.query(
      `SELECT c.id_comprobante, c.id_tipo, c.serie, c.numero, c.total, c.estado, c.estado_sunat,
              COALESCE(c.anulado, FALSE) AS anulado, COALESCE(c.aceptada_sunat, FALSE) AS aceptada_sunat,
              to_jsonb(c) ->> 'nota_motivo' AS motivo
         FROM comprobantes c
        WHERE c.id_comprobante_modificado = $1
        ORDER BY c.id_comprobante`,
      [id_comprobante],
    );
    return filas.map((f) => ({
      id_comprobante: Number(f.id_comprobante),
      id_tipo: Number(f.id_tipo),
      serie: String(f.serie ?? ''),
      numero: Number(f.numero),
      total: Number(f.total ?? 0),
      estado: textoONulo(f.estado),
      estado_sunat: textoONulo(f.estado_sunat),
      anulado: f.anulado === true || f.anulado === 't',
      aceptada_sunat: f.aceptada_sunat === true || f.aceptada_sunat === 't',
      motivo: textoONulo(f.motivo),
    }));
  }

  /** Guías de remisión que llevan a este comprobante como documento relacionado. */
  async guiasDe(id_comprobante: number): Promise<GuiaEnlazada[]> {
    const filas: any[] = await this.dataSource.query(
      `SELECT g.id_guia, g.serie, g.numero, g.estado, to_char(g.fecha_emision, 'YYYY-MM-DD') AS fecha_emision
         FROM guias_remision g
        WHERE g.id_comprobante = $1
        ORDER BY g.id_guia`,
      [id_comprobante],
    );
    return filas.map((f) => ({
      id_guia: Number(f.id_guia),
      serie: textoONulo(f.serie),
      numero: numeroONulo(f.numero),
      estado: textoONulo(f.estado),
      fecha_emision: textoONulo(f.fecha_emision),
    }));
  }

  /** CPE que requieren atención (pendiente o error, no anulados). */
  async contarAtencion(): Promise<{ pendientes: number; errores: number; total: number }> {
    const filas = await this.dataSource.query(
      `SELECT
          COUNT(*) FILTER (WHERE estado = 'pendiente')::int AS pendientes,
          COUNT(*) FILTER (WHERE estado = 'error')::int AS errores,
          COUNT(*)::int AS total
         FROM comprobantes
        WHERE COALESCE(anulado, FALSE) = FALSE
          AND estado IN ('pendiente', 'error')`,
    );
    return {
      pendientes: Number(filas[0]?.pendientes ?? 0),
      errores: Number(filas[0]?.errores ?? 0),
      total: Number(filas[0]?.total ?? 0),
    };
  }

  // ── Emisión: una sola transacción por comprobante (PLAN V3, D3) ──

  /** Abre la transacción en la que el motor reserva el número, guarda el comprobante y registra su envío. */
  transaccion<T>(trabajo: (consultor: EntityManager) => Promise<T>): Promise<T> {
    return this.dataSource.transaction(trabajo);
  }

  /** Candado de la transacción (se libera solo al COMMIT o ROLLBACK). */
  async bloquear(consultor: Consultor, clave: string): Promise<void> {
    await consultor.query('SELECT pg_advisory_xact_lock(hashtext($1))', [clave]);
  }

  /** Factura o boleta vigente de la venta (no anulada ni en error), si existe. */
  async principalVigenteDeVenta(
    id_venta: number,
    consultor: Consultor = this.dataSource,
  ): Promise<ComprobanteVigenteVenta | null> {
    const filas: any[] = await consultor.query(
      `SELECT id_comprobante, serie, numero, estado
         FROM comprobantes
        WHERE id_venta = $1
          AND id_tipo = ANY($2::int[])
          AND COALESCE(anulado, FALSE) = FALSE
          AND COALESCE(estado, '') <> 'error'
        ORDER BY id_comprobante
        LIMIT 1`,
      [id_venta, [TIPO_FACTURA, TIPO_BOLETA]],
    );
    const f = filas[0];
    return f
      ? { id_comprobante: Number(f.id_comprobante), serie: String(f.serie), numero: Number(f.numero), estado: textoONulo(f.estado) }
      : null;
  }

  /**
   * Siguiente número de la serie: el mayor entre MAX(número) + 1 y el primer número libre que
   * fijó el administrador (correlativo_inicial, por si la serie se usó fuera de este sistema).
   */
  async siguienteNumero(serie: string, piso: number = 1, consultor: Consultor = this.dataSource): Promise<number> {
    const filas: any[] = await consultor.query(
      'SELECT COALESCE(MAX(numero), 0) AS ultimo FROM comprobantes WHERE serie = $1',
      [serie],
    );
    return Math.max(Number(filas[0]?.ultimo ?? 0) + 1, pisoValido(piso));
  }

  /**
   * Dentro de la transacción del motor: candado de la serie, vuelve a leer el siguiente número y,
   * si el candidato sigue libre, inserta la cabecera (pendiente, sin enviar) y sus ítems. El
   * candidato puede ser MAYOR que el siguiente cuando se saltó un número que SUNAT ya tiene sin
   * fila aquí (p. ej. una prueba del panel); nunca menor. Si otro cajero se adelantó lanza
   * NumeroOcupadoError (también ante el índice único uq_comprobantes_serie_numero) y la
   * transacción se revierte sin dejar nada.
   * La secuencia del id ya no se resincroniza aquí: lo hace una vez sql/fase12.
   */
  async reservarCorrelativo(
    consultor: Consultor,
    fila: FilaComprobanteNueva,
    items: FilaItemNueva[],
    piso: number = 1,
  ): Promise<number> {
    await this.bloquear(consultor, `comprobante:${fila.serie}`);
    const siguiente = await this.siguienteNumero(fila.serie, piso, consultor);
    if (fila.numero < siguiente) throw new NumeroOcupadoError(fila.serie, fila.numero, siguiente);

    const columnas = await this.columnas(consultor);
    try {
      const idComprobante = await this.insertarCabecera(consultor, fila, columnas);
      await this.insertarItems(consultor, idComprobante, items, columnas);
      return idComprobante;
    } catch (error) {
      if (esViolacionUnicaSerieNumero(error)) throw new NumeroOcupadoError(fila.serie, fila.numero, fila.numero + 1);
      throw error;
    }
  }

  /** true si existen todas las columnas pedidas ('tabla.columna'). */
  async tieneColumnas(...nombres: string[]): Promise<boolean> {
    const columnas = await this.columnas();
    return nombres.every((nombre) => columnas.has(nombre));
  }

  private async insertarCabecera(
    consultor: Consultor,
    fila: FilaComprobanteNueva,
    columnas: ReadonlySet<string>,
  ): Promise<number> {
    const pares: [string, unknown][] = [
      ['id_venta', fila.id_venta],
      ['id_cliente', fila.id_cliente],
      ['id_tipo', fila.id_tipo],
      ['id_moneda', fila.id_moneda],
      ['serie', fila.serie],
      ['numero', fila.numero],
      ['sunat_transaction', 1],
      ['cliente_tipo_doc', fila.cliente_tipo_doc],
      ['cliente_numero_doc', fila.cliente_numero_doc],
      ['cliente_denominacion', fila.cliente_denominacion],
      ['cliente_direccion', fila.cliente_direccion],
      ['cliente_email', fila.cliente_email],
      ['fecha_de_emision', fila.fecha_de_emision],
      ['fecha_de_vencimiento', fila.fecha_de_vencimiento],
      ['porcentaje_igv', fila.porcentaje_igv],
      ['total_gravada', fila.total_gravada],
      ['total_exonerada', fila.total_exonerada],
      ['total_inafecta', fila.total_inafecta],
      ['total_descuento', fila.total_descuento],
      ['total_igv', fila.total_igv],
      ['total', fila.total],
      ['importe_en_letras', fila.importe_en_letras],
      ['observaciones', fila.observaciones],
      ['enviar_sunat', true],
      ['enviar_cliente', fila.enviar_cliente],
      ['anulado', false],
      ['estado', 'pendiente'],
      ['proveedor_fiscal', 'sunat_directo'],
      ['ambiente_fiscal', fila.ambiente_fiscal],
      ['estado_sunat', 'NO_ENVIADO'],
      ['id_usuario', fila.id_usuario],
    ];

    if (fila.nota) {
      const faltan = COLUMNAS_NOTA.filter((columna) => !columnas.has(columna));
      if (faltan.length) {
        throw new Error(`Faltan columnas de sql/fase9_sunat_directo.sql para guardar la nota: ${faltan.join(', ')}`);
      }
      pares.push(
        ['doc_modificado_tipo', fila.nota.doc_modificado_tipo],
        ['doc_modificado_serie', fila.nota.doc_modificado_serie],
        ['doc_modificado_numero', fila.nota.doc_modificado_numero],
        ['id_comprobante_modificado', fila.nota.id_comprobante_modificado],
        ['nota_motivo', fila.nota.nota_motivo],
        ['nota_sustento', fila.nota.nota_sustento],
      );
      // Los efectos (stock, CxC) los aplica el negocio de notas cuando SUNAT acepta; sin fase14 no se registran.
      if (COLUMNAS_EFECTOS_NOTA.every((columna) => columnas.has(columna))) {
        pares.push(
          ['efecto_nota', fila.nota.efecto_nota],
          ['reingresar_stock', fila.nota.reingresar_stock],
          ['efectos_aplicados', false],
        );
      }
    }

    const nombres = pares.map(([nombre]) => nombre);
    const valores = pares.map(([, valor]) => valor);
    const filas: any[] = await consultor.query(
      `INSERT INTO comprobantes (${nombres.join(', ')}, creado_en)
       VALUES (${valores.map((_, i) => `$${i + 1}`).join(', ')}, NOW())
       RETURNING id_comprobante`,
      valores,
    );
    const id = Number(filas[0]?.id_comprobante);
    if (!Number.isInteger(id) || id <= 0) {
      throw new Error('La base de datos no devolvió el id del comprobante recién guardado.');
    }
    return id;
  }

  /** Un solo INSERT para todas las líneas, en el orden del comprobante. */
  private async insertarItems(
    consultor: Consultor,
    idComprobante: number,
    items: FilaItemNueva[],
    columnas: ReadonlySet<string>,
  ): Promise<void> {
    if (!items.length) return;
    const conOrigen = columnas.has('comprobante_items.id_item_origen') && items.some((i) => i.id_item_origen != null);

    const arreglos: { nombre: string; tipo: string; valores: unknown[] }[] = [
      { nombre: 'id_producto', tipo: 'int', valores: items.map((i) => i.id_producto ?? null) },
      { nombre: 'unidad_de_medida', tipo: 'text', valores: items.map((i) => i.unidad_de_medida) },
      { nombre: 'codigo', tipo: 'text', valores: items.map((i) => i.codigo) },
      { nombre: 'codigo_producto_sunat', tipo: 'text', valores: items.map((i) => i.codigo_producto_sunat || null) },
      { nombre: 'descripcion', tipo: 'text', valores: items.map((i) => i.descripcion) },
      { nombre: 'cantidad', tipo: 'numeric', valores: items.map((i) => i.cantidad) },
      { nombre: 'valor_unitario', tipo: 'numeric', valores: items.map((i) => i.valor_unitario) },
      { nombre: 'precio_unitario', tipo: 'numeric', valores: items.map((i) => i.precio_unitario) },
      { nombre: 'descuento', tipo: 'numeric', valores: items.map((i) => i.descuento) },
      { nombre: 'subtotal', tipo: 'numeric', valores: items.map((i) => i.subtotal) },
      { nombre: 'tipo_de_igv', tipo: 'int', valores: items.map((i) => i.tipo_de_igv) },
      { nombre: 'igv', tipo: 'numeric', valores: items.map((i) => i.igv) },
      { nombre: 'total', tipo: 'numeric', valores: items.map((i) => i.total) },
    ];
    if (conOrigen) {
      arreglos.push({ nombre: 'id_item_origen', tipo: 'int', valores: items.map((i) => i.id_item_origen ?? null) });
    }

    const nombres = arreglos.map((a) => a.nombre);
    await consultor.query(
      `INSERT INTO comprobante_items (id_comprobante, ${nombres.join(', ')})
       SELECT $1, ${nombres.map((n) => `i.${n}`).join(', ')}
         FROM unnest(${arreglos.map((a, i) => `$${i + 2}::${a.tipo}[]`).join(', ')})
              WITH ORDINALITY AS i(${nombres.join(', ')}, n)
        ORDER BY i.n`,
      [idComprobante, ...arreglos.map((a) => a.valores)],
    );
  }

  /** Columnas opcionales presentes ('tabla.columna'), leídas una vez del catálogo. */
  private async columnas(consultor: Consultor = this.dataSource): Promise<ReadonlySet<string>> {
    const actual = this.esquema;
    if (actual && (actual.completo || Date.now() - actual.leidoEn < RELECTURA_ESQUEMA_MS)) return actual.columnas;

    const filas: any[] = await consultor.query(
      `SELECT table_name || '.' || column_name AS columna
         FROM information_schema.columns
        WHERE table_schema = ANY (current_schemas(false))
          AND table_name = ANY ($1::text[])`,
      [Object.keys(COLUMNAS_OPCIONALES)],
    );
    const columnas = new Set<string>(filas.map((f) => String(f.columna)));
    const completo = Object.entries(COLUMNAS_OPCIONALES).every(([tabla, lista]) =>
      lista.every((columna) => columnas.has(`${tabla}.${columna}`)),
    );
    this.esquema = { columnas, leidoEn: Date.now(), completo };
    return columnas;
  }
}

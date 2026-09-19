import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { Proforma } from '../../models/DBModel/proforma.entity';
import { CrudRepository } from '../Irepository/GenericIRepository/crud.Irepository';

/** Ítem ya validado y con precios del catálogo, listo para guardar. */
export interface NuevoItemProforma {
  id_producto: number;
  cantidad: number;
  precio_unitario: number;
  subtotal: number;
  descripcion_snapshot: string | null;
  sku_snapshot: string | null;
}

/** Cabecera de una proforma nueva. El número y el código los asigna el repositorio. */
export interface NuevaProforma {
  id_empresa: number | null;
  id_cliente: number | null;
  estado: string;
  observaciones: string | null;
  valida_hasta: string | null;
  id_almacen: number | null;
  cliente_nombre_snapshot: string | null;
  telefono_envio: string | null;
  total_gravada: number;
  total_igv: number;
  total: number;
  porcentaje_igv: number;
  items: NuevoItemProforma[];
}

/** Serie fija de las proformas: COT-000001, COT-000002… */
export const SERIE_PROFORMA = 'COT';

/**
 * Números mayores o iguales a este son heredados (se guardaban timestamps como
 * número). No cuentan para la numeración correlativa.
 */
export const LIMITE_NUMERO_HEREDADO = 1_000_000;

export function codigoProforma(numero: number): string {
  return `${SERIE_PROFORMA}-${String(numero).padStart(6, '0')}`;
}

/**
 * Deja una secuencia serial apuntando por encima del MAX(id) de su tabla.
 * Solo la adelanta: nunca la retrocede, porque retrocederla podría repetir un
 * id que otra transacción ya tomó y aún no confirma. Con la tabla vacía la deja
 * lista para entregar 1 (setval(…, 1, false)) si nunca se usó.
 */
function sqlRealinearSecuencia(tabla: string, columna: string): string {
  return `
DO $$
DECLARE
  v_seq       text;
  v_max       bigint;
  v_ultimo    bigint;
  v_llamada   boolean;
  v_siguiente bigint;
BEGIN
  v_seq := pg_get_serial_sequence('${tabla}', '${columna}');
  IF v_seq IS NULL THEN
    SELECT substring(column_default FROM 'nextval\\(''([^'']+)''')
      INTO v_seq
      FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = '${tabla}'
       AND column_name = '${columna}';
  END IF;
  IF v_seq IS NULL THEN
    RAISE WARNING '${tabla}.${columna} no usa secuencia; no hay nada que realinear';
    RETURN;
  END IF;

  SELECT MAX(${columna}) INTO v_max FROM ${tabla};
  EXECUTE format('SELECT last_value, is_called FROM %s', v_seq) INTO v_ultimo, v_llamada;
  v_siguiente := CASE WHEN v_llamada THEN v_ultimo + 1 ELSE v_ultimo END;

  IF v_max IS NULL THEN
    IF NOT v_llamada THEN
      PERFORM setval(v_seq, 1, false);
    END IF;
  ELSIF v_siguiente <= v_max THEN
    PERFORM setval(v_seq, v_max, true);
    RAISE NOTICE 'Secuencia % adelantada a %', v_seq, v_max;
  END IF;
END $$;`;
}

/** Proformas sin código (heredadas): numero = id, serie COT, código COT-00000N. */
const SQL_BACKFILL_CODIGOS = `
DO $$
DECLARE
  r        record;
  v_codigo text;
BEGIN
  FOR r IN SELECT id_proforma FROM proformas WHERE codigo IS NULL ORDER BY id_proforma LOOP
    v_codigo := '${SERIE_PROFORMA}-' || CASE
      WHEN length(r.id_proforma::text) >= 6 THEN r.id_proforma::text
      ELSE lpad(r.id_proforma::text, 6, '0')
    END;
    IF EXISTS (SELECT 1 FROM proformas WHERE codigo = v_codigo) THEN
      RAISE WARNING 'Proforma %: el código % ya existe; se deja sin código', r.id_proforma, v_codigo;
      CONTINUE;
    END IF;
    BEGIN
      UPDATE proformas
         SET numero = r.id_proforma,
             serie  = '${SERIE_PROFORMA}',
             codigo = v_codigo
       WHERE id_proforma = r.id_proforma
         AND codigo IS NULL;
    EXCEPTION WHEN unique_violation THEN
      RAISE WARNING 'Proforma %: el código % ya existe; se deja sin código', r.id_proforma, v_codigo;
    END;
  END LOOP;
END $$;`;

/** Numeración correlativa sin carreras: la secuencia la reparte, no MAX()+1. */
const SQL_SECUENCIA_NUMERO = `
CREATE SEQUENCE IF NOT EXISTS proformas_numero_seq;

DO $$
DECLARE
  v_max       bigint;
  v_ultimo    bigint;
  v_llamada   boolean;
  v_siguiente bigint;
BEGIN
  SELECT MAX(numero) INTO v_max
    FROM proformas
   WHERE numero > 0 AND numero < ${LIMITE_NUMERO_HEREDADO};
  SELECT last_value, is_called INTO v_ultimo, v_llamada FROM proformas_numero_seq;
  v_siguiente := CASE WHEN v_llamada THEN v_ultimo + 1 ELSE v_ultimo END;
  IF v_max IS NOT NULL AND v_siguiente <= v_max THEN
    PERFORM setval('proformas_numero_seq', v_max, true);
  END IF;
END $$;`;

/**
 * FK de ítems → proforma. Se crea NOT VALID para que ítems huérfanos antiguos
 * no impidan crearla (igual protege todo lo nuevo) y luego se intenta validar.
 */
const SQL_FK_ITEMS = `
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid  = 'proformas_items'::regclass
       AND confrelid = 'proformas'::regclass
       AND contype   = 'f'
  ) THEN
    ALTER TABLE proformas_items
      ADD CONSTRAINT fk_proformas_items_proforma
      FOREIGN KEY (id_proforma) REFERENCES proformas (id_proforma)
      ON DELETE CASCADE
      NOT VALID;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid  = 'proformas_items'::regclass
       AND conname   = 'fk_proformas_items_proforma'
       AND NOT convalidated
  ) THEN
    BEGIN
      ALTER TABLE proformas_items VALIDATE CONSTRAINT fk_proformas_items_proforma;
    EXCEPTION WHEN foreign_key_violation THEN
      RAISE WARNING 'Hay ítems de proforma huérfanos; la FK queda NOT VALID (protege solo filas nuevas)';
    END;
  END IF;
END $$;`;

const PASOS_COLUMNAS = [
  `ALTER TABLE proformas ALTER COLUMN id_cliente DROP NOT NULL`,
  `ALTER TABLE proformas ALTER COLUMN id_empresa DROP NOT NULL`,
  `ALTER TABLE proformas ADD COLUMN IF NOT EXISTS codigo VARCHAR(32)`,
  `ALTER TABLE proformas ADD COLUMN IF NOT EXISTS estado VARCHAR(20) DEFAULT 'borrador'`,
  `ALTER TABLE proformas ADD COLUMN IF NOT EXISTS observaciones TEXT`,
  `ALTER TABLE proformas ADD COLUMN IF NOT EXISTS valida_hasta DATE`,
  `ALTER TABLE proformas ADD COLUMN IF NOT EXISTS id_almacen INTEGER`,
  `ALTER TABLE proformas ADD COLUMN IF NOT EXISTS cliente_nombre_snapshot VARCHAR(250)`,
  `ALTER TABLE proformas ADD COLUMN IF NOT EXISTS telefono_envio VARCHAR(32)`,
  `ALTER TABLE proformas ADD COLUMN IF NOT EXISTS id_venta INTEGER`,
  `ALTER TABLE proformas ADD COLUMN IF NOT EXISTS enviada_wa_en TIMESTAMPTZ`,
  `ALTER TABLE proformas ADD COLUMN IF NOT EXISTS porcentaje_igv NUMERIC DEFAULT 18`,
  `ALTER TABLE proformas_items ADD COLUMN IF NOT EXISTS descripcion_snapshot VARCHAR(250)`,
  `ALTER TABLE proformas_items ADD COLUMN IF NOT EXISTS sku_snapshot VARCHAR(80)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_proformas_codigo ON proformas (codigo) WHERE codigo IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_proformas_estado ON proformas (estado)`,
];

/** Pasos sin los cuales guardar proformas puede fallar: si fallan, se reintenta. */
type PasoSchema = { nombre: string; sql: string; critico: boolean };

const PASOS_SCHEMA: PasoSchema[] = [
  ...PASOS_COLUMNAS.map((sql) => ({ nombre: 'columnas', sql, critico: false })),
  // a. Secuencias de las PK alineadas (evita "duplicate key proformas_items_pkey").
  { nombre: 'secuencia id_proforma', sql: sqlRealinearSecuencia('proformas', 'id_proforma'), critico: true },
  { nombre: 'secuencia id_item', sql: sqlRealinearSecuencia('proformas_items', 'id_item'), critico: true },
  // c. Backfill ANTES de alinear la numeración.
  { nombre: 'backfill de códigos', sql: SQL_BACKFILL_CODIGOS, critico: false },
  // b. Numeración COT-000001 por secuencia.
  { nombre: 'secuencia de numeración', sql: SQL_SECUENCIA_NUMERO, critico: true },
  // d. FK e índice de ítems.
  { nombre: 'FK de ítems', sql: SQL_FK_ITEMS, critico: false },
  {
    nombre: 'índice de ítems',
    sql: `CREATE INDEX IF NOT EXISTS idx_proformas_items_id_proforma ON proformas_items (id_proforma)`,
    critico: false,
  },
];

/** Tras un fallo del esquema, no se reintenta antes de este lapso. */
const ESPERA_REINTENTO_SCHEMA_MS = 60_000;
/** Reintentos si el código generado choca con uno existente. */
const MAX_REINTENTOS_CODIGO = 3;
const ITEMS_POR_INSERT = 100;

export function codigoErrorBd(error: any): string {
  return String(error?.code ?? error?.driverError?.code ?? '');
}

function restriccionBd(error: any): string {
  return String(error?.constraint ?? error?.driverError?.constraint ?? '');
}

function detalleBd(error: any): string {
  return String(error?.detail ?? error?.driverError?.detail ?? '');
}

/** Choque con el índice único del código (otro guardado tomó el mismo número). */
function esChoqueDeCodigo(error: any): boolean {
  if (codigoErrorBd(error) !== '23505') return false;
  return restriccionBd(error) === 'uq_proformas_codigo' || /\(codigo\)/i.test(detalleBd(error));
}

/** Choque con una PK serial: la secuencia quedó atrasada (p. ej. tras un restore). */
function esChoqueDePk(error: any): boolean {
  if (codigoErrorBd(error) !== '23505') return false;
  const restriccion = restriccionBd(error);
  return (
    /_pkey$/i.test(restriccion) ||
    /\((id_proforma|id_item)\)=/i.test(detalleBd(error))
  );
}

@Injectable()
export class ProformaRepository extends CrudRepository<Proforma> implements OnModuleInit {
  private readonly log = new Logger(ProformaRepository.name);
  private schemaPromesa: Promise<void> | null = null;
  private schemaReintentoDesde = 0;

  constructor(
    @InjectRepository(Proforma, 'pgConnection')
    private readonly proformaRepo: Repository<Proforma>,
  ) {
    super(proformaRepo);
  }

  async onModuleInit(): Promise<void> {
    // asegurarSchema nunca lanza: el arranque de la API no depende de esto.
    await this.asegurarSchema();
  }

  /**
   * Repara y completa el esquema de proformas. Es idempotente, se ejecuta una
   * sola vez aunque lleguen varias peticiones a la vez y nunca lanza: cada paso
   * que falla se registra como advertencia. Si falla un paso crítico se vuelve
   * a intentar en una llamada posterior (como mucho una vez por minuto).
   */
  asegurarSchema(): Promise<void> {
    if (!this.schemaPromesa) {
      if (Date.now() < this.schemaReintentoDesde) return Promise.resolve();
      this.schemaPromesa = this.aplicarSchema()
        .then((criticosFallidos) => {
          if (criticosFallidos > 0) {
            this.schemaPromesa = null;
            this.schemaReintentoDesde = Date.now() + ESPERA_REINTENTO_SCHEMA_MS;
          }
        })
        .catch((error: any) => {
          this.log.warn(`No se pudo revisar el esquema de proformas: ${error?.message ?? error}`);
          this.schemaPromesa = null;
          this.schemaReintentoDesde = Date.now() + ESPERA_REINTENTO_SCHEMA_MS;
        });
    }
    return this.schemaPromesa;
  }

  /** Devuelve cuántos pasos críticos fallaron. */
  private async aplicarSchema(): Promise<number> {
    const runner = this.proformaRepo.manager.connection.createQueryRunner();
    let criticosFallidos = 0;
    let bloqueado = false;
    try {
      await runner.connect();
      // Que un bloqueo largo no cuelgue el arranque.
      await runner.query(`SET lock_timeout = '5s'`).catch(() => undefined);
      await runner.query(`SET statement_timeout = '60s'`).catch(() => undefined);
      // Si hay varias instancias arrancando a la vez, una sola repara el esquema.
      await runner.query(`SELECT pg_advisory_lock(hashtext('hatunsales_proformas_schema'))`)
        .then(() => (bloqueado = true))
        .catch(() => undefined);

      for (const paso of PASOS_SCHEMA) {
        try {
          await runner.query(paso.sql);
        } catch (error: any) {
          if (paso.critico) criticosFallidos += 1;
          this.log.warn(`Esquema de proformas (${paso.nombre}): ${error?.message ?? error}`);
        }
      }

      const sinCodigo = await runner
        .query(`SELECT id_proforma FROM proformas WHERE codigo IS NULL ORDER BY id_proforma LIMIT 20`)
        .catch(() => []);
      if (sinCodigo.length) {
        this.log.warn(
          `Proformas que siguen sin código (su código correlativo ya estaba en uso): ${sinCodigo
            .map((f: any) => f.id_proforma)
            .join(', ')}`,
        );
      }
    } finally {
      if (bloqueado) {
        await runner
          .query(`SELECT pg_advisory_unlock(hashtext('hatunsales_proformas_schema'))`)
          .catch(() => undefined);
      }
      await runner.query(`RESET lock_timeout`).catch(() => undefined);
      await runner.query(`RESET statement_timeout`).catch(() => undefined);
      await runner.release().catch(() => undefined);
    }
    return criticosFallidos;
  }

  /** Realinea las secuencias de las PK (tras un choque de clave duplicada). */
  async realinearSecuencias(): Promise<void> {
    const q = this.proformaRepo.manager;
    await q.query(sqlRealinearSecuencia('proformas', 'id_proforma'));
    await q.query(sqlRealinearSecuencia('proformas_items', 'id_item'));
  }

  private async realinearNumeracion(): Promise<void> {
    await this.proformaRepo.manager.query(SQL_SECUENCIA_NUMERO);
  }

  async getAll(): Promise<Proforma[]> {
    await this.asegurarSchema();
    return this.proformaRepo.find({
      relations: ['cliente', 'empresa', 'items', 'items.producto'],
      order: { id_proforma: 'DESC', items: { id_item: 'ASC' } },
      take: 200,
    });
  }

  async getById(id: number): Promise<Proforma | null> {
    await this.asegurarSchema();
    return this.proformaRepo.findOne({
      where: { id_proforma: id },
      relations: ['cliente', 'empresa', 'items', 'items.producto'],
      order: { items: { id_item: 'ASC' } },
    });
  }

  /** Nombre de los almacenes indicados, en una sola consulta. Nunca lanza. */
  async nombresAlmacenes(ids: Array<number | null | undefined>): Promise<Map<number, string>> {
    const unicos = [...new Set(ids.filter((id): id is number => Number.isInteger(id) && Number(id) > 0))];
    const mapa = new Map<number, string>();
    if (!unicos.length) return mapa;
    try {
      const filas = await this.proformaRepo.manager.query(
        `SELECT id_almacen, nombre FROM almacenes WHERE id_almacen = ANY($1::int[])`,
        [unicos],
      );
      for (const f of filas) {
        const nombre = String(f.nombre ?? '').trim();
        if (nombre) mapa.set(Number(f.id_almacen), nombre);
      }
    } catch (error: any) {
      this.log.warn(`No se pudo leer el nombre de los almacenes: ${error?.message ?? error}`);
    }
    return mapa;
  }

  /**
   * Siguiente número correlativo (COT-000001…). Usa la secuencia, así dos
   * guardados simultáneos nunca reciben el mismo número.
   */
  async siguienteNumero(): Promise<number> {
    await this.asegurarSchema();
    try {
      return await this.nextvalNumero();
    } catch (error: any) {
      // 42P01: la secuencia no existe (el esquema no se pudo reparar al arrancar).
      if (codigoErrorBd(error) !== '42P01') throw error;
      this.log.warn('La secuencia proformas_numero_seq no existía; se crea ahora.');
      await this.realinearNumeracion();
      return this.nextvalNumero();
    }
  }

  private async nextvalNumero(): Promise<number> {
    const filas = await this.proformaRepo.manager.query(
      `SELECT nextval('proformas_numero_seq')::bigint AS n`,
    );
    const numero = Number(filas?.[0]?.n);
    if (!Number.isSafeInteger(numero) || numero <= 0) {
      throw new Error(`La secuencia de proformas devolvió un número inválido: ${filas?.[0]?.n}`);
    }
    return numero;
  }

  /**
   * Guarda cabecera e ítems en una sola transacción (todo o nada), asignando
   * número y código. Si el código choca con uno existente toma otro número; si
   * choca una PK serial realinea las secuencias y reintenta una sola vez.
   */
  async crearConItems(datos: NuevaProforma): Promise<Proforma> {
    await this.asegurarSchema();

    let pkRealineada = false;
    let numeracionRealineada = false;
    let choquesDeCodigo = 0;

    for (;;) {
      const numero = await this.siguienteNumero();
      const codigo = codigoProforma(numero);
      try {
        const id = await this.proformaRepo.manager.transaction((manager) =>
          this.insertarProforma(manager, datos, numero, codigo),
        );
        const guardada = await this.getById(id);
        if (!guardada) throw new Error(`La proforma ${id} no se encontró después de guardarla`);
        return guardada;
      } catch (error: any) {
        if (esChoqueDeCodigo(error) && choquesDeCodigo < MAX_REINTENTOS_CODIGO) {
          choquesDeCodigo += 1;
          this.log.warn(`El código ${codigo} ya existía; se asigna el siguiente número.`);
          if (!numeracionRealineada) {
            numeracionRealineada = true;
            await this.realinearNumeracion().catch((e: any) =>
              this.log.warn(`No se pudo realinear la numeración: ${e?.message ?? e}`),
            );
          }
          continue;
        }
        if (esChoqueDePk(error) && !pkRealineada) {
          pkRealineada = true;
          this.log.warn(
            `Clave duplicada al guardar la proforma (${restriccionBd(error) || detalleBd(error)}); ` +
              'se realinean las secuencias y se reintenta.',
          );
          await this.realinearSecuencias();
          continue;
        }
        throw error;
      }
    }
  }

  private async insertarProforma(
    manager: EntityManager,
    datos: NuevaProforma,
    numero: number,
    codigo: string,
  ): Promise<number> {
    const cabecera = await manager.query(
      `INSERT INTO proformas
         (id_empresa, id_cliente, serie, numero, codigo, estado, observaciones, valida_hasta,
          id_almacen, cliente_nombre_snapshot, telefono_envio,
          total_gravada, total_igv, total, porcentaje_igv)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       RETURNING id_proforma`,
      [
        datos.id_empresa,
        datos.id_cliente,
        SERIE_PROFORMA,
        numero,
        codigo,
        datos.estado,
        datos.observaciones,
        datos.valida_hasta,
        datos.id_almacen,
        datos.cliente_nombre_snapshot,
        datos.telefono_envio,
        datos.total_gravada,
        datos.total_igv,
        datos.total,
        datos.porcentaje_igv,
      ],
    );
    const idProforma = Number(cabecera?.[0]?.id_proforma);
    if (!idProforma) throw new Error('La base de datos no devolvió el id de la proforma');

    for (let inicio = 0; inicio < datos.items.length; inicio += ITEMS_POR_INSERT) {
      const lote = datos.items.slice(inicio, inicio + ITEMS_POR_INSERT);
      const parametros: unknown[] = [];
      const filas = lote.map((item) => {
        const base = parametros.length;
        parametros.push(
          idProforma,
          item.id_producto,
          item.cantidad,
          item.precio_unitario,
          item.subtotal,
          item.descripcion_snapshot,
          item.sku_snapshot,
        );
        return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7})`;
      });
      await manager.query(
        `INSERT INTO proformas_items
           (id_proforma, id_producto, cantidad, precio_unitario, subtotal, descripcion_snapshot, sku_snapshot)
         VALUES ${filas.join(', ')}`,
        parametros,
      );
    }
    return idProforma;
  }

  async actualizar(id: number, data: Partial<Proforma>): Promise<Proforma | null> {
    await this.asegurarSchema();
    await this.proformaRepo.update(id, data as any);
    return this.getById(id);
  }
}

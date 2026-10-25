import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { filasDe } from '../../caja/bd/resultado-consulta';

export interface LineaRecepcionInput {
  id_producto: number;
  cantidad_ok: number;
  cantidad_observada: number;
  nota?: string;
  motivo_observacion?: string;
  /** Si viene, actualiza productos.precio_compra tras confirmar. */
  precio_compra?: number | null;
}

/** Cabecera y líneas de una recepción nueva. */
export interface NuevaRecepcion {
  id_proveedor: number;
  id_almacen: number;
  nro_guia: string;
  nro_documento: string;
  observaciones: string;
  id_usuario?: number;
  items: LineaRecepcionInput[];
}

export interface ObservacionCreada {
  id_observacion: number;
  id_producto: number;
  id_item: number;
}

export interface RecepcionRegistrada {
  id_recepcion: number;
  observaciones: ObservacionCreada[];
  /** true si la clave de idempotencia ya tenía una recepción: no se volvió a registrar nada. */
  repetida: boolean;
}

export type ResultadoRevision =
  | { resultado: 'revisada'; observacion: any }
  | { resultado: 'no_existe' }
  | { resultado: 'ya_revisada'; estado: string };

/** Releer el catálogo cada minuto mientras falte la columna (detecta fase16 sin reiniciar). */
const RELECTURA_ESQUEMA_MS = 60_000;

@Injectable()
export class RecepcionRepository {
  private readonly logger = new Logger(RecepcionRepository.name);
  private schemaListo = false;
  private claveIdempotencia: { existe: boolean; leidoEn: number } | null = null;
  private avisoSinClave = false;

  constructor(
    @InjectDataSource('pgConnection')
    private readonly dataSource: DataSource,
  ) {}

  async asegurarSchema(): Promise<void> {
    if (this.schemaListo) return;
    await this.dataSource.query(`
      CREATE TABLE IF NOT EXISTS recepciones (
        id_recepcion      SERIAL PRIMARY KEY,
        id_proveedor      INTEGER NOT NULL REFERENCES proveedores(id_proveedor),
        id_almacen        INTEGER NOT NULL REFERENCES almacenes(id_almacen),
        nro_guia          VARCHAR(80) NOT NULL DEFAULT '',
        nro_documento     VARCHAR(80) NOT NULL DEFAULT '',
        observaciones     TEXT NOT NULL DEFAULT '',
        estado            VARCHAR(20) NOT NULL DEFAULT 'confirmada',
        id_usuario        INTEGER NULL,
        creado_en         TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS recepcion_items (
        id_item              SERIAL PRIMARY KEY,
        id_recepcion         INTEGER NOT NULL REFERENCES recepciones(id_recepcion) ON DELETE CASCADE,
        id_producto          INTEGER NOT NULL REFERENCES productos(id_producto),
        cantidad_ok          NUMERIC(12,3) NOT NULL DEFAULT 0,
        cantidad_observada   NUMERIC(12,3) NOT NULL DEFAULT 0,
        nota                 TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS recepcion_observaciones (
        id_observacion       SERIAL PRIMARY KEY,
        id_recepcion         INTEGER NOT NULL REFERENCES recepciones(id_recepcion) ON DELETE CASCADE,
        id_item              INTEGER NULL REFERENCES recepcion_items(id_item) ON DELETE SET NULL,
        id_producto          INTEGER NOT NULL REFERENCES productos(id_producto),
        id_almacen           INTEGER NOT NULL REFERENCES almacenes(id_almacen),
        id_proveedor         INTEGER NOT NULL REFERENCES proveedores(id_proveedor),
        nro_guia             VARCHAR(80) NOT NULL DEFAULT '',
        cantidad             NUMERIC(12,3) NOT NULL DEFAULT 0,
        motivo               TEXT NOT NULL DEFAULT '',
        estado               VARCHAR(20) NOT NULL DEFAULT 'pendiente',
        id_usuario_crea      INTEGER NULL,
        id_usuario_revision  INTEGER NULL,
        comentario_revision  TEXT NOT NULL DEFAULT '',
        creado_en            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        revisado_en          TIMESTAMPTZ NULL
      );
      CREATE TABLE IF NOT EXISTS recepcion_adjuntos (
        id_adjunto       SERIAL PRIMARY KEY,
        id_observacion   INTEGER NOT NULL REFERENCES recepcion_observaciones(id_observacion) ON DELETE CASCADE,
        url              TEXT NOT NULL,
        mime             VARCHAR(80) NOT NULL DEFAULT '',
        creado_en        TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_recepciones_proveedor ON recepciones(id_proveedor);
      CREATE INDEX IF NOT EXISTS idx_recepcion_obs_estado ON recepcion_observaciones(estado);
    `);
    this.schemaListo = true;
  }

  async listarProveedores(): Promise<any[]> {
    return this.dataSource.query(
      `SELECT p.id_proveedor, COALESCE(p.nombre,'') AS nombre, COALESCE(p.ruc,'') AS ruc,
              COALESCE(p.telefono,'') AS telefono, COALESCE(p.email,'') AS email,
              COALESCE(p.direccion,'') AS direccion
         FROM proveedores p
        ORDER BY p.nombre ASC NULLS LAST, p.id_proveedor DESC`,
    );
  }

  async crearProveedor(data: {
    nombre: string; ruc?: string; telefono?: string; email?: string; direccion?: string;
  }) {
    const filas = await this.dataSource.query(
      `INSERT INTO proveedores (nombre, ruc, telefono, email, direccion)
       VALUES ($1,$2,$3,$4,$5)
       RETURNING id_proveedor, nombre, ruc, telefono, email, direccion`,
      [
        data.nombre,
        data.ruc?.trim() || null,
        data.telefono?.trim() || null,
        data.email?.trim() || null,
        data.direccion?.trim() || null,
      ],
    );
    return filas[0];
  }

  async actualizarProveedor(id: number, data: {
    nombre: string; ruc?: string; telefono?: string; email?: string; direccion?: string;
  }) {
    const filas = await this.dataSource.query(
      `UPDATE proveedores
          SET nombre = $2, ruc = $3, telefono = $4, email = $5, direccion = $6
        WHERE id_proveedor = $1
        RETURNING id_proveedor, nombre, ruc, telefono, email, direccion`,
      [
        id,
        data.nombre,
        data.ruc?.trim() || null,
        data.telefono?.trim() || null,
        data.email?.trim() || null,
        data.direccion?.trim() || null,
      ],
    );
    // UPDATE devuelve [filas, afectadas]: filas[0] era el arreglo, nunca la fila.
    return filasDe(filas)[0] ?? null;
  }

  async eliminarProveedor(id: number): Promise<boolean> {
    const uso = await this.dataSource.query(
      `SELECT COUNT(*)::int AS n FROM recepciones WHERE id_proveedor = $1`,
      [id],
    );
    if (Number(uso[0]?.n ?? 0) > 0) {
      throw new Error('PROVEEDOR_EN_USO');
    }
    const r = await this.dataSource.query(
      `DELETE FROM proveedores WHERE id_proveedor = $1 RETURNING id_proveedor`,
      [id],
    );
    return filasDe(r).length > 0;
  }

  /** Ids de la lista que existen en productos, en una sola consulta. */
  async productosExistentes(ids: number[]): Promise<Set<number>> {
    const unicos = [...new Set(ids)];
    if (!unicos.length) return new Set();
    const filas = await this.dataSource.query(
      `SELECT id_producto FROM productos WHERE id_producto = ANY($1::int[])`,
      [unicos],
    );
    return new Set(filas.map((f: any) => Number(f.id_producto)));
  }

  /**
   * ¿Existe recepciones.clave_idempotencia (sql/fase16_correcciones_operacion.sql)? Sin la
   * columna la recepción se registra igual, solo que un reintento podría duplicarla.
   */
  async admiteClaveIdempotencia(): Promise<boolean> {
    const cache = this.claveIdempotencia;
    if (cache && (cache.existe || Date.now() - cache.leidoEn < RELECTURA_ESQUEMA_MS)) return cache.existe;
    const filas = await this.dataSource.query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'recepciones' AND column_name = 'clave_idempotencia'`,
    );
    const existe = filas.length > 0;
    if (!existe && !this.avisoSinClave) {
      this.avisoSinClave = true;
      this.logger.warn(
        'Falta recepciones.clave_idempotencia: aplique sql/fase16_correcciones_operacion.sql para que un reintento no duplique la recepción.',
      );
    }
    this.claveIdempotencia = { existe, leidoEn: Date.now() };
    return existe;
  }

  /** Recepción ya registrada con esa clave y sus observaciones (para responder un reintento). */
  async buscarPorClave(clave: string, manager?: EntityManager): Promise<RecepcionRegistrada | null> {
    const q = manager ?? this.dataSource;
    const cab = await q.query(
      `SELECT id_recepcion FROM recepciones WHERE clave_idempotencia = $1 LIMIT 1`,
      [clave],
    );
    if (!cab[0]) return null;
    const idRecepcion = Number(cab[0].id_recepcion);
    const obs = await q.query(
      `SELECT id_observacion, id_producto, id_item
         FROM recepcion_observaciones
        WHERE id_recepcion = $1
        ORDER BY id_observacion`,
      [idRecepcion],
    );
    return {
      id_recepcion: idRecepcion,
      observaciones: obs.map((o: any) => ({
        id_observacion: Number(o.id_observacion),
        id_producto: Number(o.id_producto),
        id_item: Number(o.id_item),
      })),
      repetida: true,
    };
  }

  /**
   * Registra la recepción completa en UNA transacción: cabecera, líneas, observaciones y
   * lo que haga `aplicarStock` (sumar lo OK al inventario, precio de compra) con el mismo
   * manager. Si algo falla no queda nada a medias: ni recepción sin stock ni stock sin
   * recepción.
   *
   * Con `clave` (y la columna de fase16) un reintento de la misma confirmación devuelve
   * la recepción ya registrada sin volver a sumar stock. El candado consultivo por clave
   * ordena dos envíos simultáneos; el índice único es la última defensa.
   */
  async registrarRecepcion(
    params: NuevaRecepcion & { clave?: string | null },
    aplicarStock: (manager: EntityManager, creada: { id_recepcion: number }) => Promise<void>,
  ): Promise<RecepcionRegistrada> {
    await this.asegurarSchema();
    const clave = params.clave && (await this.admiteClaveIdempotencia()) ? params.clave : null;

    try {
      return await this.dataSource.transaction(async (manager): Promise<RecepcionRegistrada> => {
        if (clave) {
          await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`recepcion:${clave}`]);
          const previa = await this.buscarPorClave(clave, manager);
          if (previa) return previa;
        }
        const creada = await this.insertarRecepcion(manager, params, clave);
        await aplicarStock(manager, { id_recepcion: creada.id_recepcion });
        return creada;
      });
    } catch (error: any) {
      // Otro proceso registró la misma clave entre medias (sin pasar por el candado).
      if (clave && String(error?.code ?? error?.driverError?.code ?? '') === '23505') {
        const previa = await this.buscarPorClave(clave);
        if (previa) return previa;
      }
      throw error;
    }
  }

  private async insertarRecepcion(
    manager: EntityManager,
    params: NuevaRecepcion,
    clave: string | null,
  ): Promise<RecepcionRegistrada> {
    const columnas = ['id_proveedor', 'id_almacen', 'nro_guia', 'nro_documento', 'observaciones', 'estado', 'id_usuario'];
    const valores: unknown[] = [
      params.id_proveedor,
      params.id_almacen,
      params.nro_guia,
      params.nro_documento,
      params.observaciones,
      'confirmada',
      params.id_usuario ?? null,
    ];
    if (clave) {
      columnas.push('clave_idempotencia');
      valores.push(clave);
    }
    const cab = await manager.query(
      `INSERT INTO recepciones (${columnas.join(', ')})
       VALUES (${valores.map((_, i) => `$${i + 1}`).join(', ')})
       RETURNING id_recepcion`,
      valores,
    );
    const idRecepcion = Number(cab[0].id_recepcion);
    const observacionesCreadas: ObservacionCreada[] = [];

    for (const item of params.items) {
      const filasItem = await manager.query(
        `INSERT INTO recepcion_items
           (id_recepcion, id_producto, cantidad_ok, cantidad_observada, nota)
         VALUES ($1,$2,$3,$4,$5)
         RETURNING id_item`,
        [
          idRecepcion,
          item.id_producto,
          item.cantidad_ok || 0,
          item.cantidad_observada || 0,
          item.nota?.trim() || '',
        ],
      );
      const idItem = Number(filasItem[0].id_item);

      if (Number(item.cantidad_observada) > 0) {
        const obs = await manager.query(
          `INSERT INTO recepcion_observaciones
             (id_recepcion, id_item, id_producto, id_almacen, id_proveedor, nro_guia,
              cantidad, motivo, estado, id_usuario_crea)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pendiente',$9)
           RETURNING id_observacion`,
          [
            idRecepcion,
            idItem,
            item.id_producto,
            params.id_almacen,
            params.id_proveedor,
            params.nro_guia,
            item.cantidad_observada,
            (item.motivo_observacion || item.nota || 'Producto en observación').trim(),
            params.id_usuario ?? null,
          ],
        );
        observacionesCreadas.push({
          id_observacion: Number(obs[0].id_observacion),
          id_producto: item.id_producto,
          id_item: idItem,
        });
      }
    }

    return { id_recepcion: idRecepcion, observaciones: observacionesCreadas, repetida: false };
  }

  /** Precio de compra de la recepción, dentro de su transacción. */
  async actualizarPrecioCompra(manager: EntityManager, idProducto: number, precio: number): Promise<void> {
    await manager.query('UPDATE productos SET precio_compra = $2 WHERE id_producto = $1', [idProducto, precio]);
  }

  async listarRecepciones(limite = 50, idProveedor?: number) {
    await this.asegurarSchema();
    const params: any[] = [limite];
    let filtro = '';
    if (idProveedor) {
      params.push(idProveedor);
      filtro = `WHERE r.id_proveedor = $${params.length}`;
    }
    return this.dataSource.query(
      `SELECT r.id_recepcion, r.nro_guia, r.nro_documento, r.estado, r.creado_en,
              r.id_almacen, COALESCE(a.nombre,'') AS almacen,
              r.id_proveedor, COALESCE(p.nombre,'') AS proveedor, COALESCE(p.ruc,'') AS ruc,
              (SELECT COUNT(*)::int FROM recepcion_items i WHERE i.id_recepcion = r.id_recepcion) AS lineas,
              (SELECT COALESCE(SUM(i.cantidad_ok),0)::float FROM recepcion_items i WHERE i.id_recepcion = r.id_recepcion) AS unidades_ok,
              (SELECT COALESCE(SUM(i.cantidad_observada),0)::float FROM recepcion_items i WHERE i.id_recepcion = r.id_recepcion) AS unidades_obs
         FROM recepciones r
         LEFT JOIN proveedores p ON p.id_proveedor = r.id_proveedor
         LEFT JOIN almacenes a ON a.id_almacen = r.id_almacen
         ${filtro}
        ORDER BY r.creado_en DESC
        LIMIT $1`,
      params,
    );
  }

  async detalleRecepcion(id: number) {
    await this.asegurarSchema();
    const cab = await this.dataSource.query(
      `SELECT r.*, COALESCE(p.nombre,'') AS proveedor, COALESCE(a.nombre,'') AS almacen
         FROM recepciones r
         LEFT JOIN proveedores p ON p.id_proveedor = r.id_proveedor
         LEFT JOIN almacenes a ON a.id_almacen = r.id_almacen
        WHERE r.id_recepcion = $1`,
      [id],
    );
    if (!cab[0]) return null;
    const items = await this.dataSource.query(
      `SELECT i.*, COALESCE(pr.nombre,'') AS producto, COALESCE(pr.sku,'') AS sku,
              COALESCE(pr.codigo_barras,'') AS codigo_barras
         FROM recepcion_items i
         JOIN productos pr ON pr.id_producto = i.id_producto
        WHERE i.id_recepcion = $1
        ORDER BY i.id_item`,
      [id],
    );
    return { ...cab[0], items };
  }

  async listarObservaciones(estado?: string) {
    await this.asegurarSchema();
    const params: any[] = [];
    let filtro = '';
    if (estado) {
      params.push(estado);
      filtro = `WHERE o.estado = $${params.length}`;
    }
    return this.dataSource.query(
      `SELECT o.id_observacion, o.id_recepcion, o.id_producto, o.id_almacen, o.id_proveedor,
              o.nro_guia, o.cantidad, o.motivo, o.estado, o.creado_en, o.revisado_en,
              o.comentario_revision,
              COALESCE(pr.nombre,'') AS producto, COALESCE(pr.sku,'') AS sku,
              COALESCE(pr.codigo_barras,'') AS codigo_barras,
              COALESCE(pv.nombre,'') AS proveedor,
              COALESCE(a.nombre,'') AS almacen,
              COALESCE((
                SELECT json_agg(json_build_object('id_adjunto', ad.id_adjunto, 'url', ad.url, 'mime', ad.mime))
                  FROM recepcion_adjuntos ad WHERE ad.id_observacion = o.id_observacion
              ), '[]'::json) AS adjuntos
         FROM recepcion_observaciones o
         JOIN productos pr ON pr.id_producto = o.id_producto
         JOIN proveedores pv ON pv.id_proveedor = o.id_proveedor
         JOIN almacenes a ON a.id_almacen = o.id_almacen
         ${filtro}
        ORDER BY
          CASE WHEN o.estado = 'pendiente' THEN 0 ELSE 1 END,
          o.creado_en DESC`,
      params,
    );
  }

  async buscarObservacion(id: number) {
    await this.asegurarSchema();
    const filas = await this.dataSource.query(
      `SELECT * FROM recepcion_observaciones WHERE id_observacion = $1`,
      [id],
    );
    return filas[0] ?? null;
  }

  /**
   * Aprueba o rechaza una observación pendiente en UNA transacción. El UPDATE condicional
   * (estado = 'pendiente') va primero: toma el candado de la fila, así una segunda revisión
   * simultánea (doble clic, otro usuario) espera y luego no encuentra nada que cambiar.
   * `alRevisar` (sumar el stock al aprobar) corre con el mismo manager: si falla, la
   * observación sigue pendiente y no entra stock.
   */
  async revisarObservacion(
    id: number,
    estado: 'aprobado' | 'rechazado',
    idUsuario: number | undefined,
    comentario: string | undefined,
    alRevisar?: (manager: EntityManager, observacion: any) => Promise<void>,
  ): Promise<ResultadoRevision> {
    await this.asegurarSchema();
    return this.dataSource.transaction(async (manager): Promise<ResultadoRevision> => {
      const actualizadas = filasDe(
        await manager.query(
          `UPDATE recepcion_observaciones
              SET estado = $2,
                  id_usuario_revision = $3,
                  comentario_revision = $4,
                  revisado_en = NOW()
            WHERE id_observacion = $1 AND estado = 'pendiente'
            RETURNING *`,
          [id, estado, idUsuario ?? null, comentario?.trim() || ''],
        ),
      );
      const observacion = actualizadas[0];
      if (!observacion) {
        const actual = await manager.query(
          `SELECT estado FROM recepcion_observaciones WHERE id_observacion = $1`,
          [id],
        );
        return actual[0]
          ? { resultado: 'ya_revisada', estado: String(actual[0].estado) }
          : { resultado: 'no_existe' };
      }
      if (alRevisar) await alRevisar(manager, observacion);
      return { resultado: 'revisada', observacion };
    });
  }

  async agregarAdjunto(idObservacion: number, url: string, mime: string) {
    await this.asegurarSchema();
    const filas = await this.dataSource.query(
      `INSERT INTO recepcion_adjuntos (id_observacion, url, mime)
       VALUES ($1,$2,$3)
       RETURNING id_adjunto, id_observacion, url, mime, creado_en`,
      [idObservacion, url, mime || ''],
    );
    return filas[0];
  }
}

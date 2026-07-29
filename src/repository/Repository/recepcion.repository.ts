import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

export interface LineaRecepcionInput {
  id_producto: number;
  cantidad_ok: number;
  cantidad_observada: number;
  nota?: string;
  motivo_observacion?: string;
}

@Injectable()
export class RecepcionRepository {
  private readonly logger = new Logger(RecepcionRepository.name);
  private schemaListo = false;

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
    return filas[0] ?? null;
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
    return !!r[0];
  }

  async crearRecepcion(params: {
    id_proveedor: number;
    id_almacen: number;
    nro_guia: string;
    nro_documento: string;
    observaciones: string;
    id_usuario?: number;
    items: LineaRecepcionInput[];
  }) {
    await this.asegurarSchema();
    return this.dataSource.transaction(async (manager) => {
      const cab = await manager.query(
        `INSERT INTO recepciones
           (id_proveedor, id_almacen, nro_guia, nro_documento, observaciones, estado, id_usuario)
         VALUES ($1,$2,$3,$4,$5,'confirmada',$6)
         RETURNING id_recepcion`,
        [
          params.id_proveedor,
          params.id_almacen,
          params.nro_guia,
          params.nro_documento,
          params.observaciones,
          params.id_usuario ?? null,
        ],
      );
      const idRecepcion = Number(cab[0].id_recepcion);
      const observacionesCreadas: { id_observacion: number; id_producto: number; id_item: number }[] = [];

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

      return { id_recepcion: idRecepcion, observaciones: observacionesCreadas };
    });
  }

  async listarRecepciones(limite = 50) {
    await this.asegurarSchema();
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
        ORDER BY r.creado_en DESC
        LIMIT $1`,
      [limite],
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

  async marcarObservacion(
    id: number,
    estado: 'aprobado' | 'rechazado',
    idUsuario?: number,
    comentario?: string,
  ) {
    await this.asegurarSchema();
    const filas = await this.dataSource.query(
      `UPDATE recepcion_observaciones
          SET estado = $2,
              id_usuario_revision = $3,
              comentario_revision = $4,
              revisado_en = NOW()
        WHERE id_observacion = $1 AND estado = 'pendiente'
        RETURNING *`,
      [id, estado, idUsuario ?? null, comentario?.trim() || ''],
    );
    return filas[0] ?? null;
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

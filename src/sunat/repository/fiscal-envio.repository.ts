import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

export interface FiscalEnvioRow {
  id_envio?: number;
  id_comprobante?: number;
  id_guia?: number;
  tipo_documento?: string;
  ambiente?: string;
  proveedor?: string;
  operacion?: string;
  intento?: number;
  estado?: string;
  nombre_archivo?: string;
  sunat_ticket?: string;
  codigo_sunat?: string;
  mensaje_sunat?: string;
  observaciones?: string;
  respuesta_json?: Record<string, any>;
  fecha_envio?: Date;
  fecha_respuesta?: Date;
  ultimo_error?: string;
  creado_en?: Date;
  actualizado_en?: Date;
}

export interface FiscalArtifactRow {
  id_artifact?: number;
  id_envio: number;
  tipo_artifacto: string;
  storage_key: string;
  mime?: string;
  hash?: string;
  size?: number;
  creado_en?: Date;
}

@Injectable()
export class FiscalEnvioRepository {
  constructor(
    @InjectDataSource('pgConnection')
    private readonly dataSource: DataSource,
  ) {}

  async registrar(row: FiscalEnvioRow): Promise<FiscalEnvioRow> {
    const registro = {
      id_comprobante: row.id_comprobante ?? null,
      id_guia: row.id_guia ?? null,
      tipo_documento: row.tipo_documento ?? null,
      ambiente: row.ambiente ?? 'beta',
      proveedor: row.proveedor ?? 'none',
      operacion: row.operacion ?? 'emitir',
      intento: Number(row.intento ?? 0),
      estado: row.estado ?? 'PENDIENTE',
      nombre_archivo: row.nombre_archivo ?? null,
      sunat_ticket: row.sunat_ticket ?? null,
      codigo_sunat: row.codigo_sunat ?? null,
      mensaje_sunat: row.mensaje_sunat ?? null,
      observaciones: row.observaciones ?? null,
      respuesta_json: row.respuesta_json ?? null,
      fecha_envio: row.fecha_envio ?? null,
      fecha_respuesta: row.fecha_respuesta ?? null,
      ultimo_error: row.ultimo_error ?? null,
    };

    const result = await this.dataSource.query(
      `INSERT INTO fiscal_envios (
        id_comprobante, id_guia, tipo_documento, ambiente, proveedor, operacion,
        intento, estado, nombre_archivo, sunat_ticket, codigo_sunat, mensaje_sunat,
        observaciones, respuesta_json, fecha_envio, fecha_respuesta, ultimo_error
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17
      ) RETURNING *`,
      [
        registro.id_comprobante,
        registro.id_guia,
        registro.tipo_documento,
        registro.ambiente,
        registro.proveedor,
        registro.operacion,
        registro.intento,
        registro.estado,
        registro.nombre_archivo,
        registro.sunat_ticket,
        registro.codigo_sunat,
        registro.mensaje_sunat,
        registro.observaciones,
        registro.respuesta_json ? JSON.stringify(registro.respuesta_json) : null,
        registro.fecha_envio,
        registro.fecha_respuesta,
        registro.ultimo_error,
      ],
    );

    return result[0] as FiscalEnvioRow;
  }

  async buscarPorComprobante(idComprobante: number): Promise<FiscalEnvioRow[]> {
    const rows = await this.dataSource.query(
      'SELECT * FROM fiscal_envios WHERE id_comprobante = $1 ORDER BY creado_en DESC',
      [Number(idComprobante)],
    );
    return rows as FiscalEnvioRow[];
  }

  async buscarPorGuia(idGuia: number): Promise<FiscalEnvioRow[]> {
    const rows = await this.dataSource.query(
      'SELECT * FROM fiscal_envios WHERE id_guia = $1 ORDER BY creado_en DESC',
      [Number(idGuia)],
    );
    return rows as FiscalEnvioRow[];
  }

  async actualizarEstado(idEnvio: number, estado: string, extras: Partial<FiscalEnvioRow> = {}): Promise<FiscalEnvioRow | null> {
    const values: any[] = [estado, new Date()];
    const updates: string[] = ['estado = $1', 'actualizado_en = $2'];

    if (extras.ultimo_error !== undefined) {
      values.push(extras.ultimo_error ?? null);
      updates.push(`ultimo_error = $${values.length}`);
    }
    if (extras.mensaje_sunat !== undefined) {
      values.push(extras.mensaje_sunat ?? null);
      updates.push(`mensaje_sunat = $${values.length}`);
    }
    if (extras.codigo_sunat !== undefined) {
      values.push(extras.codigo_sunat ?? null);
      updates.push(`codigo_sunat = $${values.length}`);
    }
    if (extras.sunat_ticket !== undefined) {
      values.push(extras.sunat_ticket ?? null);
      updates.push(`sunat_ticket = $${values.length}`);
    }
    if (extras.observaciones !== undefined) {
      values.push(extras.observaciones ?? null);
      updates.push(`observaciones = $${values.length}`);
    }
    if (extras.respuesta_json !== undefined) {
      values.push(extras.respuesta_json ? JSON.stringify(extras.respuesta_json) : null);
      updates.push(`respuesta_json = $${values.length}`);
    }
    if (extras.fecha_respuesta !== undefined) {
      values.push(extras.fecha_respuesta ?? null);
      updates.push(`fecha_respuesta = $${values.length}`);
    }
    if (extras.intento !== undefined) {
      values.push(Number(extras.intento ?? 0));
      updates.push(`intento = $${values.length}`);
    }

    values.push(Number(idEnvio));
    const row = await this.dataSource.query(
      `UPDATE fiscal_envios SET ${updates.join(', ')} WHERE id_envio = $${values.length} RETURNING *`,
      values,
    );

    return row[0] as FiscalEnvioRow | undefined ?? null;
  }

  async guardarArtefacto(artifact: FiscalArtifactRow): Promise<FiscalArtifactRow> {
    const result = await this.dataSource.query(
      `INSERT INTO fiscal_artifacts (
        id_envio, tipo_artifacto, storage_key, mime, hash, size
      ) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [
        Number(artifact.id_envio),
        artifact.tipo_artifacto,
        artifact.storage_key,
        artifact.mime ?? null,
        artifact.hash ?? null,
        artifact.size ?? null,
      ],
    );

    return result[0] as FiscalArtifactRow;
  }
}

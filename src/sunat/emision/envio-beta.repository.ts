import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { createHash } from 'crypto';
import { DataSource, EntityManager } from 'typeorm';
import type {
  ClasificacionRespuesta,
  DocumentoCpe,
  RespuestaSunat,
} from '../nucleo/documento-fiscal.types';
import type { EnvioCpePreparado } from '../nucleo/preparador-envio-cpe';
import type {
  ArchivoEnvioBeta,
  EnvioBetaVista,
  TipoArchivoBeta,
} from './emision-beta.types';

/** Guarda bytes reales en PostgreSQL: ningún artefacto depende del disco efímero de Railway. */
@Injectable()
export class EnvioBetaRepository {
  constructor(
    @InjectDataSource('pgConnection') private readonly bd: DataSource,
  ) {}

  async registrarPreparado(
    doc: DocumentoCpe,
    preparado: EnvioCpePreparado,
    idUsuario: number | null,
  ): Promise<number> {
    return this.bd.transaction(async (tx) => {
      const filas: Array<{ id_envio: number }> = await tx.query(
        `INSERT INTO fiscal_envios
           (tipo_documento, ambiente, proveedor, operacion, intento, estado, nombre_archivo,
            identificador, id_usuario, fecha_envio, bloqueado_hasta, respuesta_json)
         VALUES ($1, 'beta', 'sunat_directo', 'emitir', 1, 'ENVIANDO', $2, $3, $4, NOW(), NOW()+INTERVAL '60 seconds', $5::jsonb)
         RETURNING id_envio`,
        [
          doc.tipo,
          preparado.zip.nombreZip,
          preparado.nombreBase,
          idUsuario,
          JSON.stringify({
            documento: doc,
            digest: preparado.digestValue,
            cadena_qr: preparado.cadenaQr,
            advertencias: preparado.advertencias,
          }),
        ],
      );
      const id = Number(filas[0].id_envio);
      await this.guardarArchivo(
        tx,
        id,
        'xml_original',
        `${preparado.nombreBase}-original.xml`,
        'application/xml',
        Buffer.from(preparado.xmlSinFirmar, 'utf8'),
      );
      await this.guardarArchivo(
        tx,
        id,
        'xml_firmado',
        `${preparado.nombreBase}.xml`,
        'application/xml',
        Buffer.from(preparado.xmlFirmado, 'utf8'),
      );
      await this.guardarArchivo(
        tx,
        id,
        'zip',
        preparado.zip.nombreZip,
        'application/zip',
        preparado.zip.zip,
      );
      return id;
    });
  }

  async completar(
    id: number,
    nombreBase: string,
    respuesta: RespuestaSunat,
    decision: ClasificacionRespuesta,
  ): Promise<void> {
    await this.bd.transaction(async (tx) => {
      const { cdrZip, cdrXml, ...resumen } = respuesta;
      const filas = await tx.query(
        `UPDATE fiscal_envios
            SET estado=$2::varchar, codigo_sunat=$3, mensaje_sunat=$4::text, observaciones=$5,
                respuesta_json=COALESCE(respuesta_json, '{}'::jsonb) || $6::jsonb,
                tiempo_ms=$7, fecha_respuesta=NOW(), actualizado_en=NOW(), bloqueado_hasta=NULL,
                ultimo_error=CASE WHEN $2::varchar IN ('ACEPTADO','ACEPTADO_OBS') THEN NULL ELSE $4::text END
          WHERE id_envio=$1 AND ambiente='beta' RETURNING id_envio`,
        [
          id,
          decision.estado,
          respuesta.codigo,
          respuesta.descripcion,
          JSON.stringify(respuesta.observaciones),
          JSON.stringify({ respuesta: resumen, clasificacion: decision }),
          respuesta.tiempoMs,
        ],
      );
      if (!filas.length)
        throw new Error(
          'No se encontró el envío BETA para guardar la respuesta.',
        );
      if (cdrXml)
        await this.guardarArchivo(
          tx,
          id,
          'cdr_xml',
          `R-${nombreBase}.xml`,
          'application/xml',
          Buffer.from(cdrXml, 'utf8'),
        );
      if (cdrZip)
        await this.guardarArchivo(
          tx,
          id,
          'cdr_zip',
          `R-${nombreBase}.zip`,
          'application/zip',
          cdrZip,
        );
    });
  }

  listar(): Promise<EnvioBetaVista[]> {
    return this.bd.query(
      `SELECT e.id_envio, e.tipo_documento, e.nombre_archivo, e.estado, e.codigo_sunat,
              e.mensaje_sunat, e.creado_en,
              COALESCE((SELECT json_agg(a.tipo_artifacto ORDER BY a.id_artifact)
                          FROM fiscal_artifacts a WHERE a.id_envio=e.id_envio AND a.contenido IS NOT NULL), '[]'::json) AS archivos
         FROM fiscal_envios e WHERE e.ambiente='beta' AND e.proveedor='sunat_directo'
         ORDER BY e.id_envio DESC LIMIT 30`,
    );
  }

  /** Reserva un reenvío manual BETA y recupera el ZIP original, sin regenerar ni volver a firmar. */
  async tomarReenvio(
    id: number,
  ): Promise<{
    id_envio: number;
    nombre_archivo: string;
    respuesta_json: {
      documento: DocumentoCpe;
      digest: string;
      cadena_qr: string;
    };
    zip: Buffer;
  } | null> {
    const filas = await this.bd.query(
      `WITH tomado AS (
         UPDATE fiscal_envios SET estado='ENVIANDO', intento=intento+1,
                bloqueado_hasta=NOW()+INTERVAL '60 seconds', fecha_envio=NOW(), actualizado_en=NOW()
          WHERE id_envio=$1 AND ambiente='beta' AND proveedor='sunat_directo'
            AND estado IN ('ENVIANDO','PENDIENTE_REENVIO')
            AND (bloqueado_hasta IS NULL OR bloqueado_hasta<NOW())
            AND (estado<>'ENVIANDO' OR fecha_envio<NOW()-INTERVAL '45 seconds')
            AND EXISTS (SELECT 1 FROM fiscal_artifacts WHERE id_envio=$1 AND tipo_artifacto='zip' AND contenido IS NOT NULL)
          RETURNING id_envio, nombre_archivo, respuesta_json
       ) SELECT t.*, a.contenido AS zip FROM tomado t
         JOIN LATERAL (SELECT contenido FROM fiscal_artifacts WHERE id_envio=t.id_envio AND tipo_artifacto='zip'
                       ORDER BY id_artifact DESC LIMIT 1) a ON TRUE`,
      [id],
    );
    return filas[0] ?? null;
  }

  async archivo(
    id: number,
    tipo: TipoArchivoBeta,
  ): Promise<ArchivoEnvioBeta | null> {
    const filas = await this.bd.query(
      `SELECT a.nombre, a.mime, a.contenido FROM fiscal_artifacts a
         JOIN fiscal_envios e ON e.id_envio=a.id_envio
        WHERE e.id_envio=$1 AND e.ambiente='beta' AND a.tipo_artifacto=$2
          AND a.contenido IS NOT NULL ORDER BY a.id_artifact DESC LIMIT 1`,
      [id, tipo],
    );
    const fila = filas[0];
    return fila
      ? {
          tipo,
          nombre: fila.nombre,
          mime: fila.mime,
          contenido: fila.contenido,
        }
      : null;
  }

  private async guardarArchivo(
    tx: EntityManager,
    id: number,
    tipo: TipoArchivoBeta,
    nombre: string,
    mime: string,
    contenido: Buffer,
  ): Promise<void> {
    await tx.query(
      `INSERT INTO fiscal_artifacts (id_envio, tipo_artifacto, storage_key, nombre, mime, hash, size, contenido)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        id,
        tipo,
        `bd:beta:${id}:${tipo}`,
        nombre,
        mime,
        createHash('sha256').update(contenido).digest('hex'),
        contenido.length,
        contenido,
      ],
    );
  }
}

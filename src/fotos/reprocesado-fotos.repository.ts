import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { filasDe } from '../sunat/config/transacciones-fiscales';

/**
 * Consultas de las fotos ya subidas (doc/PLAN_MEJORA_AUTOMATICA_DE_FOTOS.md §9). `conTabla` dice si se
 * corrió sql/fase23: sin ella no se nombra productos_imagenes_mejora (la consulta fallaría entera) y
 * todas las fotos cuentan como pendientes. Revisar solo usa SELECT.
 */

export interface TotalesFotos {
  fotos: number;
  pendientes: number;
  mejoradas: number;
  sin_cambios: number;
  original_elegido: number;
  omitidas: number;
  error: number;
  /** Lado mayor de la original menor que 900 px. */
  chicas: number;
  bytes_originales: number;
  bytes_mejoradas: number;
}

/** Una foto publicada, con lo justo para leerla, mejorarla y decir de qué producto es. */
export interface FotoPorRevisar {
  id_imagen: number;
  id_producto: number;
  producto: string | null;
  url: string;
  thumb_url: string | null;
  mime: string | null;
  size: number | null;
  width: number | null;
  height: number | null;
  clave_almacen: string | null;
  proveedor: string | null;
}

const numero = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const CON_ARCHIVO = `pi.url IS NOT NULL AND pi.url <> ''`;

@Injectable()
export class ReprocesadoFotosRepository {
  constructor(@InjectDataSource('pgConnection') private readonly bd: DataSource) {}

  async totales(conTabla: boolean): Promise<TotalesFotos> {
    const sql = conTabla
      ? `SELECT COUNT(*) AS fotos,
                COUNT(*) FILTER (WHERE m.id_imagen IS NULL) AS pendientes,
                COUNT(*) FILTER (WHERE m.estado = 'mejorada') AS mejoradas,
                COUNT(*) FILTER (WHERE m.estado = 'sin_cambios') AS sin_cambios,
                COUNT(*) FILTER (WHERE m.estado = 'original_elegido') AS original_elegido,
                COUNT(*) FILTER (WHERE m.estado = 'omitida') AS omitidas,
                COUNT(*) FILTER (WHERE m.estado = 'error') AS error,
                COUNT(*) FILTER (WHERE GREATEST(COALESCE(m.ancho_original, pi.width), COALESCE(m.alto_original, pi.height)) < 900) AS chicas,
                COALESCE(SUM(m.size_original), 0) AS bytes_originales,
                COALESCE(SUM(m.size_mejorada), 0) AS bytes_mejoradas
           FROM productos_imagenes pi
           LEFT JOIN productos_imagenes_mejora m ON m.id_imagen = pi.id_imagen
          WHERE ${CON_ARCHIVO}`
      : `SELECT COUNT(*) AS fotos,
                COUNT(*) AS pendientes,
                COUNT(*) FILTER (WHERE GREATEST(pi.width, pi.height) < 900) AS chicas
           FROM productos_imagenes pi
          WHERE ${CON_ARCHIVO}`;
    const f = filasDe<Record<string, unknown>>(await this.bd.query(sql))[0] ?? {};
    const n = (clave: string) => Number(f[clave] ?? 0);
    return {
      fotos: n('fotos'), pendientes: n('pendientes'), mejoradas: n('mejoradas'), sin_cambios: n('sin_cambios'),
      original_elegido: n('original_elegido'), omitidas: n('omitidas'), error: n('error'), chicas: n('chicas'),
      bytes_originales: n('bytes_originales'), bytes_mejoradas: n('bytes_mejoradas'),
    };
  }

  /**
   * Devuelve a la original todas las fotos que hoy muestran su mejorada (o las de un producto), en una
   * sola sentencia. Quedan como «original elegida»: las tandas no las vuelven a tocar. No borra archivos.
   * @returns cuántas fotos cambiaron.
   */
  async deshacer(id_producto?: number): Promise<number> {
    const filas = filasDe<{ id_imagen: number }>(await this.bd.query(
      `WITH m AS (
         UPDATE productos_imagenes_mejora x
            SET estado = 'original_elegido', actualizado_en = now()
           FROM productos_imagenes pi
          WHERE pi.id_imagen = x.id_imagen AND x.estado = 'mejorada' AND pi.url = x.url_mejorada
            AND ($1::int IS NULL OR pi.id_producto = $1::int)
          RETURNING x.*
       )
       UPDATE productos_imagenes pi
          SET url = m.url_original, thumb_url = COALESCE(m.thumb_original, m.url_original), mime = m.mime_original,
              size = m.size_original, width = m.ancho_original, height = m.alto_original,
              clave_almacen = m.clave_original, proveedor = m.proveedor_original
         FROM m
        WHERE pi.id_imagen = m.id_imagen
       RETURNING pi.id_imagen`,
      [id_producto ?? null],
    ));
    return filas.length;
  }

  /** ¿Esta foto ya tiene fila de mejora? */
  async yaProcesada(id_imagen: number): Promise<boolean> {
    const filas = filasDe<unknown>(await this.bd.query(
      'SELECT 1 FROM productos_imagenes_mejora WHERE id_imagen = $1', [id_imagen],
    ));
    return filas.length > 0;
  }

  /** Las fotos sin procesar (sin fila de mejora), las principales primero. */
  async pendientes(conTabla: boolean, limite: number, id_producto?: number): Promise<FotoPorRevisar[]> {
    const parametros: unknown[] = [limite];
    let filtro = CON_ARCHIVO;
    if (conTabla) filtro += ' AND NOT EXISTS (SELECT 1 FROM productos_imagenes_mejora m WHERE m.id_imagen = pi.id_imagen)';
    if (id_producto !== undefined) {
      parametros.push(id_producto);
      filtro += ' AND pi.id_producto = $2';
    }
    const filas = filasDe<any>(await this.bd.query(
      `SELECT pi.id_imagen, pi.id_producto, p.nombre AS producto, pi.url, pi.thumb_url, pi.mime, pi.size,
              pi.width, pi.height, pi.clave_almacen, pi.proveedor
         FROM productos_imagenes pi
         LEFT JOIN productos p ON p.id_producto = pi.id_producto
        WHERE ${filtro}
        ORDER BY pi.is_primary DESC NULLS LAST, pi.id_imagen ASC
        LIMIT $1`,
      parametros,
    ));
    return filas.map((f) => ({
      id_imagen: Number(f.id_imagen),
      id_producto: Number(f.id_producto),
      producto: f.producto ?? null,
      url: f.url,
      thumb_url: f.thumb_url ?? null,
      mime: f.mime ?? null,
      size: numero(f.size),
      width: numero(f.width),
      height: numero(f.height),
      clave_almacen: f.clave_almacen ?? null,
      proveedor: f.proveedor ?? null,
    }));
  }
}

import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { filasDe } from '../sunat/config/transacciones-fiscales';
import { EsquemaMejoraFotos } from './esquema-mejora-fotos';

/**
 * Persistencia de la mejora de fotos (tabla productos_imagenes_mejora, sql/fase23). Solo SQL con
 * parámetros $n. La entidad ProductoImagen NO se toca: esta tabla solo la lee el código nuevo, así que
 * desplegar el código antes que el script no rompe ninguna consulta existente.
 *
 * Invariante (§3 del plan): una fila de productos_imagenes apunta a una mejorada solo si existe su fila
 * aquí con la original. Por eso publicar y elegir son UNA sentencia cada una (las CTE que modifican
 * datos corren en la misma transacción implícita): o cambian las dos tablas o ninguna.
 */

export type EstadoMejora = 'mejorada' | 'sin_cambios' | 'original_elegido' | 'omitida' | 'error';

export interface FilaMejora {
  id_imagen: number;
  estado: EstadoMejora;
  version: number;
  proveedor_original: string;
  url_original: string;
  clave_original: string;
  thumb_original: string | null;
  mime_original: string | null;
  size_original: number | null;
  ancho_original: number | null;
  alto_original: number | null;
  proveedor_mejorada: string | null;
  url_mejorada: string | null;
  clave_mejorada: string | null;
  thumb_mejorada: string | null;
  mime_mejorada: string | null;
  size_mejorada: number | null;
  ancho_mejorada: number | null;
  alto_mejorada: number | null;
  informe: Record<string, unknown>;
}

/** Un archivo tal como lo devolvió el almacén (o como está en productos_imagenes). */
export interface ArchivoFoto {
  proveedor: string;
  url: string;
  clave: string;
  thumb_url: string | null;
  mime: string | null;
  size: number | null;
  ancho: number | null;
  alto: number | null;
}

/** Una foto del producto con su fila de mejora, si tiene. */
export interface FotoConMejora {
  id_imagen: number;
  url: string;
  width: number | null;
  height: number | null;
  mejora: FilaMejora | null;
}

const COLUMNAS = `m.id_imagen, m.estado, m.version, m.proveedor_original, m.url_original, m.clave_original,
  m.thumb_original, m.mime_original, m.size_original, m.ancho_original, m.alto_original, m.proveedor_mejorada,
  m.url_mejorada, m.clave_mejorada, m.thumb_mejorada, m.mime_mejorada, m.size_mejorada, m.ancho_mejorada,
  m.alto_mejorada, m.informe`;

/** Lista de columnas a escribir (mismo orden que `valores()`), sin id_imagen. */
const COLUMNAS_ESCRITURA = [
  'estado', 'version',
  'proveedor_original', 'url_original', 'clave_original', 'thumb_original', 'mime_original', 'size_original', 'ancho_original', 'alto_original',
  'proveedor_mejorada', 'url_mejorada', 'clave_mejorada', 'thumb_mejorada', 'mime_mejorada', 'size_mejorada', 'ancho_mejorada', 'alto_mejorada',
  'informe',
];

/**
 * Parámetros $2…$20 con su tipo explícito (en un INSERT … SELECT PostgreSQL no puede deducirlo).
 * $1 es id_imagen.
 */
const TIPOS = [
  'varchar', 'smallint',
  'varchar', 'text', 'text', 'text', 'varchar', 'integer', 'integer', 'integer',
  'varchar', 'text', 'text', 'text', 'varchar', 'integer', 'integer', 'integer',
  'jsonb',
];
const SELECT_VALORES = TIPOS.map((tipo, i) => `$${i + 2}::${tipo}`).join(', ');
const SET_EXCLUDED = [...COLUMNAS_ESCRITURA.map((c) => `${c} = EXCLUDED.${c}`), 'actualizado_en = now()'].join(', ');
/**
 * Qué hacer si la foto ya tiene fila. Las tandas usan `soloSiNueva`: si una persona decidió mientras
 * tanto (o ya se procesó), no se pisa nada y la imagen no se mueve.
 */
const alRepetir = (soloSiNueva: boolean) => (soloSiNueva ? 'DO NOTHING' : `DO UPDATE SET ${SET_EXCLUDED}`);

function valores(estado: EstadoMejora, version: number, original: ArchivoFoto, mejorada: ArchivoFoto | null, informe: unknown): unknown[] {
  const o = original, m = mejorada;
  return [
    estado, version,
    o.proveedor, o.url, o.clave, o.thumb_url, o.mime, o.size, o.ancho, o.alto,
    m?.proveedor ?? null, m?.url ?? null, m?.clave ?? null, m?.thumb_url ?? null, m?.mime ?? null, m?.size ?? null, m?.ancho ?? null, m?.alto ?? null,
    JSON.stringify(informe ?? {}),
  ];
}

const numero = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

function normalizar(fila: any): FilaMejora {
  return {
    ...fila,
    id_imagen: Number(fila.id_imagen),
    version: Number(fila.version),
    size_original: numero(fila.size_original),
    ancho_original: numero(fila.ancho_original),
    alto_original: numero(fila.alto_original),
    size_mejorada: numero(fila.size_mejorada),
    ancho_mejorada: numero(fila.ancho_mejorada),
    alto_mejorada: numero(fila.alto_mejorada),
    informe: typeof fila.informe === 'string' ? JSON.parse(fila.informe) : (fila.informe ?? {}),
  };
}

@Injectable()
export class MejoraFotosRepository {
  constructor(
    @InjectDataSource('pgConnection') private readonly bd: DataSource,
    private readonly esquema: EsquemaMejoraFotos,
  ) {}

  /** ¿Se corrió sql/fase23? */
  disponible(): Promise<boolean> {
    return this.esquema.disponible();
  }

  async porImagen(id_imagen: number): Promise<FilaMejora | null> {
    const filas = filasDe<any>(await this.bd.query(
      `SELECT ${COLUMNAS} FROM productos_imagenes_mejora m WHERE m.id_imagen = $1`,
      [id_imagen],
    ));
    return filas[0] ? normalizar(filas[0]) : null;
  }

  /** Todas las fotos del producto, en el orden de la galería, con su fila de mejora si la tienen. */
  async porProducto(id_producto: number): Promise<FotoConMejora[]> {
    const filas = filasDe<any>(await this.bd.query(
      `SELECT pi.id_imagen AS pi_id, pi.url AS pi_url, pi.width AS pi_width, pi.height AS pi_height, ${COLUMNAS}
         FROM productos_imagenes pi
         LEFT JOIN productos_imagenes_mejora m ON m.id_imagen = pi.id_imagen
        WHERE pi.id_producto = $1
        ORDER BY pi.is_primary DESC, pi.orden ASC, pi.id_imagen ASC`,
      [id_producto],
    ));
    return filas.map((f) => ({
      id_imagen: Number(f.pi_id),
      url: f.pi_url,
      width: numero(f.pi_width),
      height: numero(f.pi_height),
      mejora: f.id_imagen === null || f.id_imagen === undefined ? null : normalizar(f),
    }));
  }

  /**
   * Guarda la fila con la original y la mejorada Y apunta la imagen a la mejorada, en una sola sentencia.
   * Solo actúa si la imagen sigue apuntando a `original.url` (nadie la reemplazó mientras se mejoraba).
   * @returns `true` si publicó; `false` si la imagen ya no existe o cambió (no se escribió nada).
   */
  async publicarMejorada(id_imagen: number, version: number, original: ArchivoFoto, mejorada: ArchivoFoto, informe: unknown, soloSiNueva = false): Promise<boolean> {
    const filas = filasDe<{ id_imagen: number }>(await this.bd.query(
      `WITH base AS (
         SELECT id_imagen FROM productos_imagenes WHERE id_imagen = $1 AND url = $5::text FOR UPDATE
       ), m AS (
         INSERT INTO productos_imagenes_mejora (id_imagen, ${COLUMNAS_ESCRITURA.join(', ')})
         SELECT base.id_imagen, ${SELECT_VALORES} FROM base
         ON CONFLICT (id_imagen) ${alRepetir(soloSiNueva)}
         RETURNING id_imagen
       )
       UPDATE productos_imagenes pi
          SET url = $13::text, thumb_url = $15::text, mime = $16::varchar, size = $17::integer,
              width = $18::integer, height = $19::integer, clave_almacen = $14::text, proveedor = $12::varchar
         FROM m
        WHERE pi.id_imagen = m.id_imagen
       RETURNING pi.id_imagen`,
      [id_imagen, ...valores('mejorada', version, original, mejorada, informe)],
    ));
    return filas.length === 1;
  }

  /**
   * Anota una foto sin cambiar a qué archivo apunta (sin_cambios, omitida, error, original_elegido).
   * Pisa una fila anterior entera (también sus datos de mejorada): se usa al subir o reemplazar, cuando
   * la original es nueva. Solo escribe si la imagen sigue apuntando a `original.url`.
   */
  async registrar(id_imagen: number, estado: Exclude<EstadoMejora, 'mejorada'>, version: number, original: ArchivoFoto, informe: unknown, soloSiNueva = false): Promise<boolean> {
    const filas = filasDe<{ id_imagen: number }>(await this.bd.query(
      `INSERT INTO productos_imagenes_mejora (id_imagen, ${COLUMNAS_ESCRITURA.join(', ')})
       SELECT pi.id_imagen, ${SELECT_VALORES}
         FROM productos_imagenes pi
        WHERE pi.id_imagen = $1 AND pi.url = $5::text
       ON CONFLICT (id_imagen) ${alRepetir(soloSiNueva)}
       RETURNING id_imagen`,
      [id_imagen, ...valores(estado, version, original, null, informe)],
    ));
    return filas.length === 1;
  }

  /**
   * Cambia la foto publicada entre la original y la mejorada guardadas, y anota la elección
   * (`original_elegido` o `mejorada`), en una sola sentencia. Nunca borra archivos.
   * @returns `false` si no hay fila, o si se pidió la mejorada y no existe.
   */
  async elegir(id_imagen: number, cual: 'original' | 'mejorada'): Promise<boolean> {
    const filas = filasDe<{ id_imagen: number }>(await this.bd.query(
      `WITH m AS (
         UPDATE productos_imagenes_mejora
            SET estado = CASE WHEN $2::text = 'mejorada' THEN 'mejorada' ELSE 'original_elegido' END,
                actualizado_en = now()
          WHERE id_imagen = $1 AND ($2::text = 'original' OR url_mejorada IS NOT NULL)
          RETURNING *
       )
       UPDATE productos_imagenes pi
          SET url           = CASE WHEN $2::text = 'mejorada' THEN m.url_mejorada ELSE m.url_original END,
              thumb_url     = CASE WHEN $2::text = 'mejorada' THEN COALESCE(m.thumb_mejorada, m.url_mejorada)
                                   ELSE COALESCE(m.thumb_original, m.url_original) END,
              mime          = CASE WHEN $2::text = 'mejorada' THEN m.mime_mejorada ELSE m.mime_original END,
              size          = CASE WHEN $2::text = 'mejorada' THEN m.size_mejorada ELSE m.size_original END,
              width         = CASE WHEN $2::text = 'mejorada' THEN m.ancho_mejorada ELSE m.ancho_original END,
              height        = CASE WHEN $2::text = 'mejorada' THEN m.alto_mejorada ELSE m.alto_original END,
              clave_almacen = CASE WHEN $2::text = 'mejorada' THEN m.clave_mejorada ELSE m.clave_original END,
              proveedor     = CASE WHEN $2::text = 'mejorada' THEN m.proveedor_mejorada ELSE m.proveedor_original END
         FROM m
        WHERE pi.id_imagen = m.id_imagen
       RETURNING pi.id_imagen`,
      [id_imagen, cual],
    ));
    return filas.length === 1;
  }

  async eliminarFila(id_imagen: number): Promise<void> {
    await this.bd.query('DELETE FROM productos_imagenes_mejora WHERE id_imagen = $1', [id_imagen]);
  }
}

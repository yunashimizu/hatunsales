import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { createHash } from 'crypto';
import { DataSource } from 'typeorm';
import { CacheTtl } from '../config/cache-ttl';
import { FiscalConfigError } from '../config/fiscal-errores';
import type { AmbienteFiscal } from '../config/fiscal-config.tipos';
import { EjecutorSql, filasDe, TransaccionesFiscales } from '../config/transacciones-fiscales';
import type { DocumentoCpe } from '../nucleo/documento-fiscal.types';
import type { EnvioCpePreparado } from '../nucleo/preparador-envio-cpe';
import { fechaLimiteEnvioIndividual } from '../nucleo/reglas-envio';
import {
  ArchivoEnvio,
  ConsultorTx,
  EnvioVista,
  FiltroEnvios,
  MAXIMO_ENVIOS_POR_PAGINA,
  TIPOS_ARCHIVO_ENVIO,
  TipoArchivoEnvio,
} from './emision.contrato';
import {
  CierreEnvio,
  DatosRegistroEnvio,
  EnvioCerrado,
  EnvioRegistrado,
  ESTADOS_ENVIO_ABIERTOS,
  SEGUNDOS_RECLAMO,
  TIPOS_CPE_EMISION,
} from './emision.tipos';

export interface RegistroEnvioNuevo {
  ambiente: AmbienteFiscal;
  documento: DocumentoCpe;
  preparado: EnvioCpePreparado;
  /** null solo en las pruebas del panel (no hay comprobante comercial detrás). */
  idComprobante: number | null;
  idUsuario: number | null;
  /** yyyy-mm-dd (Lima). */
  fechaLimiteEnvio: string;
}

interface ArchivoNuevo {
  tipo: TipoArchivoEnvio;
  nombre: string;
  mime: string;
  contenido: Buffer;
}

export interface ContadoresEmision {
  pendientes: number;
  inciertos: number;
  vencen_hoy: number;
  vencidos: number;
}

/** Columnas de un envío para operar (t = fiscal_envios o el resultado de un UPDATE, c = comprobantes). */
const COLUMNAS_ENVIO = `
  t.id_envio, t.ambiente, t.tipo_documento, t.estado, t.intento, t.nombre_archivo, t.identificador,
  t.id_comprobante, t.codigo_sunat, t.respuesta_json #>> '{clasificacion,accion}' AS accion,
  (t.bloqueado_hasta IS NULL OR t.bloqueado_hasta < NOW()) AS libre,
  c.fecha_limite_envio::text AS fecha_limite_envio,
  t.respuesta_json -> 'documento' AS documento,
  t.respuesta_json ->> 'digest' AS digest,
  t.respuesta_json ->> 'cadena_qr' AS cadena_qr,
  COALESCE(t.respuesta_json ->> 'registrado_con_otros_datos', '') = 'true' AS registrado_con_otros_datos`;

/** El ZIP enviado (los reintentos mandan exactamente estos bytes). */
const COLUMNA_ZIP = `
  (SELECT a.contenido FROM fiscal_artifacts a
    WHERE a.id_envio = t.id_envio AND a.tipo_artifacto = 'zip' AND a.contenido IS NOT NULL
    ORDER BY a.id_artifact DESC LIMIT 1) AS zip`;

/** Solo los envíos de factura, boleta y notas de esta emisión (la GRE y la pila antigua quedan fuera). */
const FILTRO_CPE = `t.operacion = 'emitir' AND t.tipo_documento IN ('01', '03', '07', '08')`;

const COLUMNAS_VISTA = `
  t.id_envio, t.ambiente, t.tipo_documento, t.nombre_archivo, t.estado, t.codigo_sunat, t.mensaje_sunat,
  t.respuesta_json #>> '{clasificacion,accion}' AS accion_sunat, t.id_comprobante, t.creado_en, t.actualizado_en,
  t.intento, t.proximo_intento_en, t.bloqueado_hasta,
  t.respuesta_json #>> '{documento,serie}' AS serie,
  CASE WHEN (t.respuesta_json #>> '{documento,numero}') ~ '^[0-9]{1,9}$'
       THEN (t.respuesta_json #>> '{documento,numero}')::int END AS numero,
  ARRAY(SELECT DISTINCT a.tipo_artifacto FROM fiscal_artifacts a
         WHERE a.id_envio = t.id_envio AND a.contenido IS NOT NULL) AS archivos`;

function sha256(contenido: Buffer | string): string {
  return createHash('sha256').update(contenido).digest('hex');
}

/** timestamptz de node-postgres (Date) o ya texto → ISO 8601. */
function iso(valor: unknown): string | null {
  if (valor instanceof Date) return valor.toISOString();
  return typeof valor === 'string' ? valor : null;
}

function ordenarArchivos(lista: unknown): TipoArchivoEnvio[] {
  const presentes = new Set(Array.isArray(lista) ? lista.map(String) : []);
  return TIPOS_ARCHIVO_ENVIO.filter((tipo) => presentes.has(tipo));
}

function limiteDe(documento: DocumentoCpe): string | null {
  try {
    return fechaLimiteEnvioIndividual(documento.tipo, documento.serie, documento.fechaEmision);
  } catch {
    return null; // documento antiguo sin fecha válida: el plazo se decide con lo que haya en el comprobante
  }
}

function aEnvio(fila: Record<string, any>): EnvioRegistrado {
  const documento = fila.documento && typeof fila.documento === 'object' ? (fila.documento as DocumentoCpe) : null;
  const nombreBase = String(fila.identificador ?? '').trim() || String(fila.nombre_archivo ?? '').replace(/\.zip$/i, '');
  return {
    id_envio: Number(fila.id_envio),
    ambiente: fila.ambiente === 'produccion' ? 'produccion' : 'beta',
    tipo_documento: String(fila.tipo_documento ?? documento?.tipo ?? ''),
    estado: String(fila.estado ?? ''),
    estado_anterior: fila.estado_anterior ?? null,
    intento: Number(fila.intento ?? 0),
    nombre_archivo: String(fila.nombre_archivo ?? `${nombreBase}.zip`),
    nombre_base: nombreBase,
    id_comprobante: fila.id_comprobante === null || fila.id_comprobante === undefined ? null : Number(fila.id_comprobante),
    codigo_sunat: fila.codigo_sunat ?? null,
    accion: fila.accion ?? null,
    libre: fila.libre === true,
    fecha_limite_envio: fila.fecha_limite_envio ?? (documento ? limiteDe(documento) : null),
    datos: documento ? ({ documento, digest: fila.digest ?? '', cadena_qr: fila.cadena_qr ?? '' } as DatosRegistroEnvio) : null,
    registrado_con_otros_datos: fila.registrado_con_otros_datos === true,
    zip: Buffer.isBuffer(fila.zip) ? fila.zip : null,
  };
}

function aVista(fila: Record<string, any>): EnvioVista {
  return {
    id_envio: Number(fila.id_envio),
    ambiente: fila.ambiente === 'produccion' ? 'produccion' : 'beta',
    tipo_documento: String(fila.tipo_documento ?? ''),
    nombre_archivo: String(fila.nombre_archivo ?? ''),
    estado: String(fila.estado ?? ''),
    codigo_sunat: fila.codigo_sunat ?? null,
    mensaje_sunat: fila.mensaje_sunat ?? null,
    accion_sunat: fila.accion_sunat ?? null,
    id_comprobante: fila.id_comprobante === null || fila.id_comprobante === undefined ? null : Number(fila.id_comprobante),
    creado_en: iso(fila.creado_en) ?? '',
    archivos: ordenarArchivos(fila.archivos),
    serie: fila.serie ?? null,
    numero: fila.numero === null || fila.numero === undefined ? null : Number(fila.numero),
    intento: Number(fila.intento ?? 0),
    proximo_intento_en: iso(fila.proximo_intento_en),
    bloqueado_hasta: iso(fila.bloqueado_hasta),
    actualizado_en: iso(fila.actualizado_en),
  };
}

/** Índice o restricción de un error de unicidad de PostgreSQL (QueryFailedError copia los campos del driver). */
function restriccionUnica(error: unknown): string | null {
  const e = error as { code?: string; constraint?: string; driverError?: { code?: string; constraint?: string } };
  const codigo = e?.driverError?.code ?? e?.code;
  return codigo === '23505' ? String(e?.driverError?.constraint ?? e?.constraint ?? '') : null;
}

/**
 * Persistencia de los envíos de factura, boleta y notas (fiscal_envios + fiscal_artifacts) para BETA y
 * PRODUCCIÓN: el ambiente va como parámetro en todas las consultas que lo necesitan. Los bytes reales
 * (XML, XML firmado, ZIP y CDR) se guardan en PostgreSQL: nada depende del disco efímero de Railway.
 *
 * Exclusión entre procesos e instancias: cada operación «reclama» el envío con un UPDATE condicionado
 * (bloqueado_hasta = ahora + 60 s) antes de hablar con SUNAT, así dos instancias nunca mandan a la vez
 * el mismo ZIP; quien cierra solo puede pisar estados abiertos (nunca un ACEPTADO o RECHAZADO).
 */
@Injectable()
export class EnvioFiscalRepository {
  private readonly esquemaHora = new CacheTtl<boolean>((existe) => (existe ? 10 * 60_000 : 60_000));

  constructor(
    @InjectDataSource('pgConnection') private readonly bd: DataSource,
    private readonly transacciones: TransaccionesFiscales,
  ) {}

  /**
   * Dentro de la transacción del negocio (solo consultor.query con $n): envío en ENVIANDO con su plazo
   * de reclamo, los tres artefactos en UNA sentencia y los datos fiscales del comprobante.
   */
  async registrar(consultor: ConsultorTx, r: RegistroEnvioNuevo): Promise<number> {
    const { ambiente, documento, preparado } = r;
    const datos: DatosRegistroEnvio = {
      documento,
      digest: preparado.digestValue,
      cadena_qr: preparado.cadenaQr,
      advertencias: preparado.advertencias,
    };
    let filas: Array<{ id_envio: number }>;
    try {
      filas = filasDe<{ id_envio: number }>(
        await consultor.query(
          `INSERT INTO fiscal_envios
             (tipo_documento, ambiente, proveedor, operacion, intento, estado, nombre_archivo, identificador,
              id_usuario, id_comprobante, fecha_envio, bloqueado_hasta, hash_xml, respuesta_json)
           VALUES ($1, $2, 'sunat_directo', 'emitir', 1, 'ENVIANDO', $3, $4, $5, $6, NOW(),
                   NOW() + $7::int * INTERVAL '1 second', $8, $9::jsonb)
           RETURNING id_envio`,
          [
            documento.tipo,
            ambiente,
            preparado.zip.nombreZip,
            preparado.nombreBase,
            r.idUsuario,
            r.idComprobante,
            SEGUNDOS_RECLAMO,
            sha256(preparado.xmlFirmado),
            JSON.stringify(datos),
          ],
        ),
      );
    } catch (error) {
      throw this.traducirUnicidad(error, documento);
    }
    const idEnvio = Number(filas[0]?.id_envio);
    if (!Number.isSafeInteger(idEnvio) || idEnvio <= 0) throw new Error('No se pudo registrar el envío fiscal.');

    await this.insertarArchivos(consultor, idEnvio, r.idComprobante, ambiente, [
      { tipo: 'xml_original', nombre: `${preparado.nombreBase}-original.xml`, mime: 'application/xml', contenido: Buffer.from(preparado.xmlSinFirmar, 'utf8') },
      { tipo: 'xml_firmado', nombre: `${preparado.nombreBase}.xml`, mime: 'application/xml', contenido: Buffer.from(preparado.xmlFirmado, 'utf8') },
      { tipo: 'zip', nombre: preparado.zip.nombreZip, mime: 'application/zip', contenido: preparado.zip.zip },
    ]);

    if (r.idComprobante !== null) await this.marcarComprobanteEnviando(consultor, r, idEnvio);
    return idEnvio;
  }

  /**
   * Primer envío (después del COMMIT del negocio): solo si sigue como se registró (intento 1, sin
   * respuesta). Si la tarea ya lo tomó porque el proceso tardó, aquí no se vuelve a enviar.
   */
  async reclamarPrimerEnvio(idEnvio: number, conZip: boolean): Promise<EnvioRegistrado | null> {
    const filas = filasDe<Record<string, any>>(
      await this.bd.query(
        `WITH tomado AS (
           UPDATE fiscal_envios e
              SET bloqueado_hasta = NOW() + $2::int * INTERVAL '1 second', fecha_envio = NOW(), actualizado_en = NOW()
            WHERE e.id_envio = $1 AND e.operacion = 'emitir' AND e.estado = 'ENVIANDO'
              AND e.intento = 1 AND e.fecha_respuesta IS NULL
           RETURNING e.*
         )
         SELECT ${COLUMNAS_ENVIO}${conZip ? `, ${COLUMNA_ZIP}` : ''}
           FROM tomado t LEFT JOIN comprobantes c ON c.id_comprobante = t.id_comprobante`,
        [idEnvio, SEGUNDOS_RECLAMO],
      ),
    );
    return filas[0] ? aEnvio(filas[0]) : null;
  }

  /**
   * Reintento seguro (D5.1): PENDIENTE_REENVIO que no espera recuperar el CDR, o ENVIANDO con el reclamo
   * vencido (resultado incierto). FOR UPDATE SKIP LOCKED: si otra instancia lo está tomando, se salta.
   */
  async reclamarReintento(idEnvio: number): Promise<EnvioRegistrado | null> {
    const filas = filasDe<Record<string, any>>(
      await this.bd.query(
        `WITH objetivo AS (
           SELECT e.id_envio, e.estado AS estado_anterior
             FROM fiscal_envios e
            WHERE e.id_envio = $1 AND e.operacion = 'emitir'
              AND ((e.estado = 'PENDIENTE_REENVIO'
                    AND (e.respuesta_json #>> '{clasificacion,accion}') IS DISTINCT FROM 'RECUPERAR_CDR')
                   OR e.estado = 'ENVIANDO')
              AND (e.bloqueado_hasta IS NULL OR e.bloqueado_hasta < NOW())
            FOR UPDATE SKIP LOCKED
         ), tomado AS (
           UPDATE fiscal_envios e
              SET estado = 'ENVIANDO', intento = e.intento + 1,
                  bloqueado_hasta = NOW() + $2::int * INTERVAL '1 second',
                  fecha_envio = NOW(), actualizado_en = NOW(), proximo_intento_en = NULL
             FROM objetivo o
            WHERE e.id_envio = o.id_envio
           RETURNING e.*, o.estado_anterior
         )
         SELECT ${COLUMNAS_ENVIO}, t.estado_anterior, ${COLUMNA_ZIP}
           FROM tomado t LEFT JOIN comprobantes c ON c.id_comprobante = t.id_comprobante`,
        [idEnvio, SEGUNDOS_RECLAMO],
      ),
    );
    return filas[0] ? aEnvio(filas[0]) : null;
  }

  /** Consulta del CDR (sin reenviar): reclama el envío sin cambiar su estado mientras se pregunta a SUNAT. */
  async reclamarConsulta(idEnvio: number): Promise<EnvioRegistrado | null> {
    const filas = filasDe<Record<string, any>>(
      await this.bd.query(
        `WITH tomado AS (
           UPDATE fiscal_envios e
              SET bloqueado_hasta = NOW() + $2::int * INTERVAL '1 second', actualizado_en = NOW()
            WHERE e.id_envio = $1 AND e.operacion = 'emitir' AND e.estado = ANY($3::text[])
              AND (e.bloqueado_hasta IS NULL OR e.bloqueado_hasta < NOW())
           RETURNING e.*
         )
         SELECT ${COLUMNAS_ENVIO}
           FROM tomado t LEFT JOIN comprobantes c ON c.id_comprobante = t.id_comprobante`,
        [idEnvio, SEGUNDOS_RECLAMO, ESTADOS_ENVIO_ABIERTOS],
      ),
    );
    return filas[0] ? aEnvio(filas[0]) : null;
  }

  /** Lectura sin reclamar (para validar y para explicar por qué no se puede operar). */
  async leer(idEnvio: number): Promise<EnvioRegistrado | null> {
    const filas = filasDe<Record<string, any>>(
      await this.bd.query(
        `SELECT ${COLUMNAS_ENVIO}
           FROM fiscal_envios t LEFT JOIN comprobantes c ON c.id_comprobante = t.id_comprobante
          WHERE t.id_envio = $1 AND ${FILTRO_CPE}`,
        [idEnvio],
      ),
    );
    return filas[0] ? aEnvio(filas[0]) : null;
  }

  /**
   * Guarda el resultado (D5.3: el que llama reintenta si la BD falla, con la respuesta en memoria).
   * Solo pisa estados abiertos: si otro proceso ya lo dejó ACEPTADO o RECHAZADO devuelve null.
   */
  async completar(idEnvio: number, ambiente: AmbienteFiscal, nombreBase: string, cierre: CierreEnvio): Promise<EnvioCerrado | null> {
    const aceptado = cierre.estado === 'ACEPTADO' || cierre.estado === 'ACEPTADO_OBS';
    const sunat = cierre.sunat;
    return this.transacciones.ejecutar(async (tx) => {
      const filas = filasDe<{ id_comprobante: number | null; tipo_documento: string; archivos: string[] }>(
        await tx.query(
          `UPDATE fiscal_envios e
              SET estado = $3::varchar,
                  codigo_sunat = COALESCE($4::varchar, e.codigo_sunat),
                  mensaje_sunat = COALESCE($5::text, e.mensaje_sunat),
                  observaciones = COALESCE($6::text, e.observaciones),
                  tiempo_ms = COALESCE($7::int, e.tiempo_ms),
                  fecha_respuesta = CASE WHEN $4::varchar IS NULL THEN e.fecha_respuesta ELSE NOW() END,
                  respuesta_json = COALESCE(e.respuesta_json, '{}'::jsonb) || $8::jsonb,
                  ultimo_error = CASE WHEN $9::boolean THEN NULL ELSE $10::text END,
                  proximo_intento_en = CASE WHEN $11::int IS NULL THEN NULL ELSE NOW() + $11::int * INTERVAL '1 minute' END,
                  bloqueado_hasta = NULL, actualizado_en = NOW()
            WHERE e.id_envio = $1 AND e.ambiente = $2 AND e.estado = ANY($12::text[])
            RETURNING e.id_comprobante, e.tipo_documento,
                      ARRAY(SELECT DISTINCT a.tipo_artifacto FROM fiscal_artifacts a
                             WHERE a.id_envio = e.id_envio AND a.contenido IS NOT NULL) AS archivos`,
          [
            idEnvio,
            ambiente,
            cierre.estado,
            sunat?.codigo ?? null,
            sunat?.descripcion ?? null,
            sunat ? JSON.stringify(sunat.observaciones) : null,
            sunat ? Math.round(sunat.tiempoMs) : null,
            JSON.stringify(cierre.json),
            aceptado,
            cierre.mensaje,
            cierre.proximoIntentoMin,
            ESTADOS_ENVIO_ABIERTOS,
          ],
        ),
      );
      const fila = filas[0];
      if (!fila) return null;
      const idComprobante = fila.id_comprobante === null ? null : Number(fila.id_comprobante);

      const cdr: ArchivoNuevo[] = [];
      if (cierre.cdr?.xml) {
        cdr.push({ tipo: 'cdr_xml', nombre: `R-${nombreBase}.xml`, mime: 'application/xml', contenido: Buffer.from(cierre.cdr.xml, 'utf8') });
      }
      if (cierre.cdr?.zip?.length) {
        cdr.push({ tipo: 'cdr_zip', nombre: `R-${nombreBase}.zip`, mime: 'application/zip', contenido: cierre.cdr.zip });
      }
      await this.insertarArchivos(tx, idEnvio, idComprobante, ambiente, cdr);

      if (idComprobante !== null) {
        const estadoComprobante = aceptado
          ? 'emitido'
          : cierre.estado === 'PENDIENTE_REENVIO' || cierre.estado === 'ENVIANDO'
            ? 'pendiente'
            : 'error';
        await tx.query(
          `UPDATE comprobantes
              SET estado = $2, estado_sunat = $3, id_envio_ultimo = $4, aceptada_sunat = $5::boolean,
                  sunat_description = COALESCE($6::text, sunat_description),
                  sunat_responsecode = COALESCE($7::text, sunat_responsecode),
                  sunat_soap_error = CASE WHEN $5::boolean THEN NULL ELSE $8::text END,
                  sunat_observaciones = COALESCE($9::jsonb, sunat_observaciones),
                  emitido_en = CASE WHEN $5::boolean THEN COALESCE(emitido_en, NOW()) ELSE emitido_en END,
                  error_mensaje = CASE WHEN $5::boolean THEN NULL ELSE $8::text END
            WHERE id_comprobante = $1`,
          [
            idComprobante,
            estadoComprobante,
            cierre.estado,
            idEnvio,
            aceptado,
            sunat?.descripcion ?? null,
            sunat?.codigo ?? null,
            cierre.mensaje,
            sunat ? JSON.stringify(sunat.observaciones) : null,
          ],
        );
      }
      return { id_comprobante: idComprobante, tipo_documento: String(fila.tipo_documento), archivos: (fila.archivos ?? []).map(String) };
    });
  }

  /**
   * Aceptación confirmada por el administrador tras verificar en SUNAT (D5.1), dentro de su transacción
   * (la auditoría va en la misma). Solo envíos de resultado incierto; null si cambió de estado.
   */
  async marcarAceptadoManual(
    ejecutor: EjecutorSql,
    idEnvio: number,
    mensaje: string,
    json: Record<string, unknown>,
  ): Promise<(EnvioCerrado & { ambiente: AmbienteFiscal }) | null> {
    const filas = filasDe<{ id_comprobante: number | null; tipo_documento: string; ambiente: string; archivos: string[] }>(
      await ejecutor.query(
        `UPDATE fiscal_envios e
            SET estado = 'ACEPTADO', respuesta_json = COALESCE(e.respuesta_json, '{}'::jsonb) || $2::jsonb,
                ultimo_error = NULL, bloqueado_hasta = NULL, proximo_intento_en = NULL, actualizado_en = NOW()
          WHERE e.id_envio = $1 AND e.operacion = 'emitir'
            AND ((e.estado = 'PENDIENTE_REENVIO' AND e.respuesta_json #>> '{clasificacion,accion}' = 'RECUPERAR_CDR')
                 OR (e.estado = 'ENVIANDO' AND (e.bloqueado_hasta IS NULL OR e.bloqueado_hasta < NOW())))
          RETURNING e.id_comprobante, e.tipo_documento, e.ambiente,
                    ARRAY(SELECT DISTINCT a.tipo_artifacto FROM fiscal_artifacts a
                           WHERE a.id_envio = e.id_envio AND a.contenido IS NOT NULL) AS archivos`,
        [idEnvio, JSON.stringify(json)],
      ),
    );
    const fila = filas[0];
    if (!fila) return null;
    const idComprobante = fila.id_comprobante === null ? null : Number(fila.id_comprobante);
    if (idComprobante !== null) {
      await ejecutor.query(
        `UPDATE comprobantes
            SET estado = 'emitido', estado_sunat = 'ACEPTADO', aceptada_sunat = true, id_envio_ultimo = $3,
                emitido_en = COALESCE(emitido_en, NOW()), error_mensaje = NULL, sunat_soap_error = NULL,
                sunat_description = $2
          WHERE id_comprobante = $1`,
        [idComprobante, mensaje, idEnvio],
      );
    }
    return {
      id_comprobante: idComprobante,
      tipo_documento: String(fila.tipo_documento),
      ambiente: fila.ambiente === 'produccion' ? 'produccion' : 'beta',
      archivos: (fila.archivos ?? []).map(String),
    };
  }

  async archivo(idEnvio: number, tipo: TipoArchivoEnvio): Promise<ArchivoEnvio | null> {
    const filas = filasDe<{ nombre: string | null; mime: string | null; contenido: Buffer | null }>(
      await this.bd.query(
        `SELECT a.nombre, a.mime, a.contenido
           FROM fiscal_artifacts a
          WHERE a.id_envio = $1 AND a.tipo_artifacto = $2 AND a.contenido IS NOT NULL
          ORDER BY a.id_artifact DESC LIMIT 1`,
        [idEnvio, tipo],
      ),
    );
    const fila = filas[0];
    if (!fila || !Buffer.isBuffer(fila.contenido)) return null;
    return { nombre: fila.nombre ?? `${tipo}-${idEnvio}`, mime: fila.mime ?? 'application/octet-stream', contenido: fila.contenido };
  }

  async listar(filtro: FiltroEnvios): Promise<{ datos: EnvioVista[]; total: number; pagina: number; por_pagina: number }> {
    const pagina = Math.max(1, Math.trunc(Number(filtro.pagina) || 1));
    const porPagina = Math.min(MAXIMO_ENVIOS_POR_PAGINA, Math.max(1, Math.trunc(Number(filtro.por_pagina) || 20)));
    const tipos = filtro.tipo ? [filtro.tipo] : [...TIPOS_CPE_EMISION];
    const condiciones = `t.proveedor = 'sunat_directo' AND t.operacion = 'emitir' AND t.tipo_documento = ANY($1::text[])
      AND ($2::text IS NULL OR t.ambiente = $2::text)
      AND ($3::text IS NULL OR t.estado = $3::text)
      AND ($4::int IS NULL OR t.id_comprobante = $4::int)`;
    const parametros = [tipos, filtro.ambiente ?? null, filtro.estado ?? null, filtro.id_comprobante ?? null];
    const [filas, conteo] = await Promise.all([
      this.bd.query(
        `SELECT ${COLUMNAS_VISTA} FROM fiscal_envios t WHERE ${condiciones}
          ORDER BY t.id_envio DESC LIMIT $5 OFFSET $6`,
        [...parametros, porPagina, (pagina - 1) * porPagina],
      ),
      this.bd.query(`SELECT COUNT(*)::int AS total FROM fiscal_envios t WHERE ${condiciones}`, parametros),
    ]);
    return {
      datos: filasDe<Record<string, any>>(filas).map(aVista),
      total: Number(filasDe<{ total: number }>(conteo)[0]?.total ?? 0),
      pagina,
      por_pagina: porPagina,
    };
  }

  async obtener(idEnvio: number): Promise<EnvioVista | null> {
    const filas = filasDe<Record<string, any>>(
      await this.bd.query(`SELECT ${COLUMNAS_VISTA} FROM fiscal_envios t WHERE t.id_envio = $1 AND ${FILTRO_CPE}`, [idEnvio]),
    );
    return filas[0] ? aVista(filas[0]) : null;
  }

  /**
   * Candidatos de la tarea (D7) del ambiente vigente: pendientes de reintento cuyo turno llegó y envíos
   * ENVIANDO con el reclamo vencido. Cada uno se reclama después por separado (reclamarReintento).
   */
  async candidatosTarea(ambiente: AmbienteFiscal, limite: number): Promise<number[]> {
    const filas = filasDe<{ id_envio: number }>(
      await this.bd.query(
        `SELECT t.id_envio
           FROM fiscal_envios t
          WHERE t.ambiente = $1 AND t.proveedor = 'sunat_directo' AND ${FILTRO_CPE} AND t.id_comprobante IS NOT NULL
            AND ((t.estado = 'PENDIENTE_REENVIO'
                  AND COALESCE(t.respuesta_json #>> '{clasificacion,accion}', 'REINTENTAR') = 'REINTENTAR'
                  AND (t.proximo_intento_en IS NULL OR t.proximo_intento_en <= NOW()))
                 OR t.estado = 'ENVIANDO')
            AND (t.bloqueado_hasta IS NULL OR t.bloqueado_hasta < NOW())
          ORDER BY COALESCE(t.proximo_intento_en, t.actualizado_en), t.id_envio
          LIMIT $2`,
        [ambiente, Math.max(1, Math.trunc(limite))],
      ),
    );
    return filas.map((f) => Number(f.id_envio));
  }

  /** Cola y plazos del ambiente para GET /fiscal/estado. */
  async contadores(ambiente: AmbienteFiscal, hoy: string): Promise<ContadoresEmision> {
    const filas = filasDe<Record<string, unknown>>(
      await this.bd.query(
        `SELECT
           (SELECT COUNT(*) FROM fiscal_envios t
             WHERE t.ambiente = $1 AND ${FILTRO_CPE} AND t.id_comprobante IS NOT NULL AND t.estado = 'PENDIENTE_REENVIO'
               AND (t.respuesta_json #>> '{clasificacion,accion}') IS DISTINCT FROM 'RECUPERAR_CDR')::int AS pendientes,
           (SELECT COUNT(*) FROM fiscal_envios t
             WHERE t.ambiente = $1 AND ${FILTRO_CPE} AND t.id_comprobante IS NOT NULL
               AND ((t.estado = 'ENVIANDO' AND (t.bloqueado_hasta IS NULL OR t.bloqueado_hasta < NOW()))
                    OR (t.estado = 'PENDIENTE_REENVIO' AND t.respuesta_json #>> '{clasificacion,accion}' = 'RECUPERAR_CDR')))::int AS inciertos,
           (SELECT COUNT(*) FROM comprobantes c
             WHERE c.ambiente_fiscal = $1 AND c.proveedor_fiscal = 'sunat_directo' AND COALESCE(c.anulado, false) = false
               AND c.estado_sunat NOT IN ('ACEPTADO', 'ACEPTADO_OBS', 'RECHAZADO', 'ANULADO', 'BAJA_PENDIENTE')
               AND c.fecha_limite_envio = $2::date)::int AS vencen_hoy,
           (SELECT COUNT(*) FROM comprobantes c
             WHERE c.ambiente_fiscal = $1 AND c.proveedor_fiscal = 'sunat_directo' AND COALESCE(c.anulado, false) = false
               AND c.estado_sunat NOT IN ('ACEPTADO', 'ACEPTADO_OBS', 'RECHAZADO', 'ANULADO', 'BAJA_PENDIENTE')
               AND c.fecha_limite_envio < $2::date)::int AS vencidos`,
        [ambiente, hoy],
      ),
    );
    const fila = filas[0] ?? {};
    return {
      pendientes: Number(fila.pendientes ?? 0),
      inciertos: Number(fila.inciertos ?? 0),
      vencen_hoy: Number(fila.vencen_hoy ?? 0),
      vencidos: Number(fila.vencidos ?? 0),
    };
  }

  /**
   * Primer número libre de cada serie de BETA según lo ya enviado en ese ambiente (las pruebas del panel
   * no crean comprobantes, pero su número quedó en fiscal_envios y uq_fiscal_envio_identificador no
   * admite repetirlo). Solo trae las series que tienen envíos.
   */
  async primerosLibresBeta(series: readonly string[]): Promise<Record<string, number>> {
    const filas = filasDe<{ serie: string; ultimo: string | number }>(
      await this.bd.query(
        `SELECT split_part(t.identificador, '-', 3) AS serie, MAX(split_part(t.identificador, '-', 4)::bigint) AS ultimo
           FROM fiscal_envios t
          WHERE t.ambiente = 'beta' AND split_part(t.identificador, '-', 3) = ANY($1::text[])
            AND split_part(t.identificador, '-', 4) ~ '^[0-9]{1,8}$'
          GROUP BY 1`,
        [series],
      ),
    );
    return Object.fromEntries(filas.map((f) => [String(f.serie), Number(f.ultimo) + 1]));
  }

  /** Número para un documento de prueba BETA del panel: después de todo lo enviado o registrado en esa serie. */
  async siguienteNumeroPruebaBeta(serie: string): Promise<number> {
    const filas = filasDe<{ siguiente: string | number }>(
      await this.bd.query(
        `SELECT GREATEST(
                  COALESCE((SELECT MAX(c.numero) FROM comprobantes c WHERE c.serie = $1), 0),
                  COALESCE((SELECT MAX(split_part(t.identificador, '-', 4)::bigint) FROM fiscal_envios t
                             WHERE t.ambiente = 'beta' AND split_part(t.identificador, '-', 3) = $1
                               AND split_part(t.identificador, '-', 4) ~ '^[0-9]{1,8}$'), 0)
                ) + 1 AS siguiente`,
        [serie],
      ),
    );
    return Number(filas[0]?.siguiente ?? 1);
  }

  /**
   * comprobantes.hora_emision la crea fase12: sin ella se omite (la venta no se cae por una migración
   * pendiente). Se pregunta al catálogo con la MISMA conexión de la transacción y se recuerda.
   */
  tieneHoraEmision(ejecutor: EjecutorSql): Promise<boolean> {
    return this.esquemaHora.obtener('comprobantes.hora_emision', async () => {
      try {
        const filas = filasDe<{ existe: boolean }>(
          await ejecutor.query(
            `SELECT EXISTS (SELECT 1 FROM information_schema.columns
                             WHERE table_schema = current_schema() AND table_name = 'comprobantes'
                               AND column_name = 'hora_emision') AS existe`,
          ),
        );
        return filas[0]?.existe === true;
      } catch {
        return false; // sin poder leer el catálogo se omite la columna (y se vuelve a preguntar en un minuto)
      }
    });
  }

  private async marcarComprobanteEnviando(consultor: ConsultorTx, r: RegistroEnvioNuevo, idEnvio: number): Promise<void> {
    const { documento, preparado } = r;
    const parametros: unknown[] = [
      r.idComprobante,
      r.ambiente,
      idEnvio,
      preparado.cadenaQr,
      preparado.digestValue,
      formaPagoDe(documento),
      cuotasDe(documento),
      r.fechaLimiteEnvio,
      documento.serie,
      documento.numero,
    ];
    let hora = '';
    if (await this.tieneHoraEmision(consultor)) {
      parametros.push(documento.horaEmision);
      hora = `, hora_emision = $${parametros.length}::time`;
    }
    const filas = filasDe<{ id_comprobante: number }>(
      await consultor.query(
        `UPDATE comprobantes
            SET proveedor_fiscal = 'sunat_directo', ambiente_fiscal = $2, estado = 'pendiente', estado_sunat = 'ENVIANDO',
                id_envio_ultimo = $3, error_mensaje = NULL, cadena_qr = $4, codigo_hash = $5,
                forma_pago = $6, cuotas = $7::jsonb, fecha_limite_envio = $8::date${hora}
          WHERE id_comprobante = $1 AND serie = $9 AND numero = $10
          RETURNING id_comprobante`,
        parametros,
      ),
    );
    if (!filas.length) {
      throw new Error(
        `El comprobante ${r.idComprobante} no existe o no es ${documento.serie}-${documento.numero}: no se registra el envío.`,
      );
    }
  }

  /** Todos los archivos del envío en UNA sentencia (menos viajes a la BD en la venta). */
  private async insertarArchivos(
    ejecutor: EjecutorSql,
    idEnvio: number,
    idComprobante: number | null,
    ambiente: AmbienteFiscal,
    archivos: ArchivoNuevo[],
  ): Promise<void> {
    if (!archivos.length) return;
    const parametros: unknown[] = [idEnvio, idComprobante];
    const filas = archivos.map((archivo) => {
      const base = parametros.length;
      parametros.push(
        archivo.tipo,
        `bd:${ambiente}:${idEnvio}:${archivo.tipo}`,
        archivo.nombre,
        archivo.mime,
        sha256(archivo.contenido),
        archivo.contenido.length,
        archivo.contenido,
      );
      const marcas = Array.from({ length: 7 }, (_, i) => `$${base + i + 1}`);
      return `($1, $2, ${marcas.join(', ')})`;
    });
    await ejecutor.query(
      `INSERT INTO fiscal_artifacts (id_envio, id_comprobante, tipo_artifacto, storage_key, nombre, mime, hash, size, contenido)
       VALUES ${filas.join(', ')}`,
      parametros,
    );
  }

  /** Un número ya enviado en este ambiente o un envío en curso del comprobante: errores claros, no un 500. */
  private traducirUnicidad(error: unknown, documento: DocumentoCpe): unknown {
    const restriccion = restriccionUnica(error);
    if (restriccion === 'uq_fiscal_envio_identificador') {
      return new FiscalConfigError(
        'FISCAL_NUMERO_OCUPADO',
        `El número ${documento.serie}-${documento.numero} ya se envió a SUNAT en este ambiente: se debe usar el siguiente.`,
        { serie: documento.serie, numero: documento.numero },
      );
    }
    if (restriccion === 'uq_fiscal_envio_en_curso') {
      return new FiscalConfigError('FISCAL_ENVIO_EN_CURSO', 'El comprobante ya tiene un envío a SUNAT en curso.');
    }
    return error;
  }
}

/** Exactamente 'Contado' o 'Credito' (CHECK comprobantes_forma_pago_ck); null si el documento no la lleva. */
export function formaPagoDe(documento: DocumentoCpe): 'Contado' | 'Credito' | null {
  const tipo = String(documento.formaPago?.tipo ?? '')
    .trim()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
  if (tipo === 'contado') return 'Contado';
  if (tipo === 'credito') return 'Credito';
  return null;
}

/** [{numero, monto, fechaPago}] al crédito; null al contado o sin forma de pago. */
export function cuotasDe(documento: DocumentoCpe): string | null {
  if (formaPagoDe(documento) !== 'Credito') return null;
  const cuotas = (documento.formaPago?.cuotas ?? []).map((c) => ({ numero: c.numero, monto: c.monto, fechaPago: c.fechaPago }));
  return JSON.stringify(cuotas);
}

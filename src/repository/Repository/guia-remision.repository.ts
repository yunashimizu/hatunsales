import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { createHash } from 'crypto';
import { DataSource } from 'typeorm';
import { EjecutorSql, filasDe, TransaccionesFiscales } from '../../sunat/config/transacciones-fiscales';
import type { EmisorCpe } from '../../sunat/nucleo/documento-fiscal.types';
import type { GrePreparada } from '../../sunat/gre/gre.contrato';
import type { DocumentoGre } from '../../sunat/gre/gre.tipos';
import type { TipoArchivoGuia } from '../../models/model/guia-remision.response';

/** Datos del formulario que no tienen columna propia en guias_remision (van en payload_sunat.formulario). */
export interface FormularioGuia {
  descripcion_motivo: string | null;
  fecha_entrega_transportista: string | null;
  partida_codigo_establecimiento: string | null;
  llegada_codigo_establecimiento: string | null;
  registro_mtc: string | null;
  tarjeta_circulacion: string | null;
  conductor_nombres: string | null;
  conductor_apellidos: string | null;
}

/** payload_sunat de la guía: lo que no tiene columna y la foto de lo que se firmó. */
export interface PayloadGuia {
  formulario?: Partial<FormularioGuia>;
  /** Fecha, hora y remitente con que se firmó el último envío (representación impresa). */
  emision?: { fecha: string; hora: string; nombre_base: string; remitente: EmisorCpe };
  anulacion?: { motivo: string | null; fecha: string; id_usuario: number | null };
}

export interface ComprobanteRelacionadoGuia {
  id_comprobante: number;
  id_tipo: number;
  serie: string;
  numero: number;
  ambiente_fiscal: string | null;
}

/** Último envío de la guía a SUNAT (fiscal_envios). */
export interface EnvioGuia {
  id_envio: number;
  estado: string;
  codigo: string | null;
  mensaje: string | null;
  ticket: string | null;
  intento: number;
  consultas: number;
  revision_manual: boolean;
  /** Reclamado por otro proceso (bloqueado_hasta en el futuro). */
  en_curso: boolean;
  proximo_intento_en: string | null;
  actualizado_en: string | null;
  archivos: TipoArchivoGuia[];
}

export interface FilaGuia {
  id_guia: number;
  id_venta: number | null;
  id_comprobante: number | null;
  id_almacen_origen: number | null;
  serie: string | null;
  numero: number | null;
  estado: string;
  fecha_emision: string | null;
  fecha_inicio_traslado: string | null;
  motivo_traslado_codigo: string | null;
  modalidad_traslado: string | null;
  direccion_origen: string | null;
  origen_ubigeo: string | null;
  direccion_destino: string | null;
  destino_ubigeo: string | null;
  peso_bruto_total: number | null;
  unidad_peso: string | null;
  numero_bultos: number | null;
  destinatario_tipo_doc: string | null;
  destinatario_numero_doc: string | null;
  destinatario_denominacion: string | null;
  destinatario_direccion: string | null;
  placa_principal: string | null;
  marca_vehiculo: string | null;
  conductor_nombre: string | null;
  conductor_tipo_doc: string | null;
  conductor_numero_doc: string | null;
  conductor_licencia: string | null;
  transportista_ruc: string | null;
  transportista_denominacion: string | null;
  observaciones: string | null;
  error_mensaje: string | null;
  sunat_ticket: string | null;
  sunat_responsecode: string | null;
  sunat_description: string | null;
  cadena_qr: string | null;
  codigo_hash: string | null;
  payload: PayloadGuia;
  creado_en: string | null;
  comprobante: ComprobanteRelacionadoGuia | null;
  envio: EnvioGuia | null;
}

export interface FilaItemGuia {
  id_item: number;
  id_producto: number;
  id_venta_detalle: number | null;
  codigo: string | null;
  descripcion: string;
  unidad_medida: string | null;
  cantidad: number;
  orden: number;
  codigo_sunat: string | null;
}

export interface VentaGuia {
  id_venta: number;
  fecha: string | null;
  total: number;
  estado: string;
  id_cliente: number | null;
  id_empresa: number | null;
  empresa: {
    ruc: string | null;
    razon_social: string | null;
    direccion: string | null;
    ubigeo: string | null;
    departamento: string | null;
    provincia: string | null;
    distrito: string | null;
  } | null;
  cliente: { dni: string | null; nombre: string | null; direccion: string | null } | null;
}

/** Lo vendido de un producto y lo que ya llevan las demás guías vigentes de la venta. */
export interface ProductoVendidoGuia {
  id_producto: number;
  id_venta_detalle: number;
  cantidad_vendida: number;
  cantidad_en_guias: number;
  nombre: string | null;
  codigo: string | null;
  unidad_medida: string | null;
}

export interface ProductoGuia {
  id_producto: number;
  nombre: string | null;
  codigo: string | null;
  unidad_medida: string | null;
}

export interface AlmacenSalidaGuia {
  id_almacen: number;
  nombre: string | null;
  direccion: string | null;
}

export interface ItemGuardarGuia {
  id_producto: number;
  id_venta_detalle: number | null;
  codigo: string | null;
  descripcion: string;
  unidad_medida: string;
  cantidad: number;
}

/** Lo que se guarda de un borrador (POST) o de una edición (PUT). */
export interface DatosGuardarGuia {
  id_comprobante: number | null;
  id_empresa: number | null;
  id_cliente: number | null;
  id_almacen_origen: number | null;
  motivo_traslado_codigo: string;
  motivo_traslado_texto: string;
  modalidad_traslado: string;
  fecha_inicio_traslado: string | null;
  direccion_origen: string | null;
  origen_ubigeo: string | null;
  direccion_destino: string | null;
  destino_ubigeo: string | null;
  peso_bruto_total: number | null;
  unidad_peso: string;
  numero_bultos: number | null;
  destinatario_tipo_doc: string | null;
  destinatario_numero_doc: string | null;
  destinatario_denominacion: string | null;
  destinatario_direccion: string | null;
  placa_principal: string | null;
  marca_vehiculo: string | null;
  conductor_nombre: string | null;
  conductor_tipo_doc: string | null;
  conductor_numero_doc: string | null;
  conductor_licencia: string | null;
  transportista_ruc: string | null;
  transportista_denominacion: string | null;
  observaciones: string | null;
  formulario: FormularioGuia;
  items: ItemGuardarGuia[];
}

export interface FiltroListadoGuias {
  texto?: string;
  estado?: string;
  desde?: string;
  hasta?: string;
  id_venta?: number;
  pagina: number;
  por_pagina: number;
}

export interface RegistroEmisionGuia {
  idGuia: number;
  /** Número que ya tenía la guía (rechazada o pendiente) o null si se asigna ahora. */
  numeroAnterior: number | null;
  idComprobante: number | null;
  idUsuario: number | null;
  preparada: GrePreparada;
}

/** Envío reclamado para reenviar el MISMO archivo (resultado incierto). */
export interface EnvioParaReenvio {
  id_envio: number;
  nombre_base: string;
  documento: DocumentoGre | null;
  digest: string;
  advertencias: string[];
  xml: string | null;
  xml_firmado: string | null;
  zip: Buffer | null;
}

/** Envío reclamado para consultar su ticket. */
export interface EnvioParaConsulta {
  id_envio: number;
  id_guia: number;
  ticket: string | null;
  nombre_base: string;
  documento: Pick<DocumentoGre, 'serie' | 'numero'> & { remitente?: { ruc?: string } } | null;
  digest: string | null;
  consultas: number;
}

export interface CierreEnvioGuia {
  estadoEnvio: 'TICKET_PENDIENTE' | 'RECHAZADO' | 'ERROR_CONFIG' | 'PENDIENTE_REENVIO';
  estadoGuia: 'enviado' | 'rechazado' | 'pendiente';
  ticket: string | null;
  codigo: string | null;
  mensaje: string;
  /** null = sin error que mostrar en la guía. */
  errorGuia: string | null;
  respuesta: Record<string, unknown>;
  proximoIntentoSeg: number | null;
}

export interface CierreConsultaGuia {
  estadoEnvio: 'ACEPTADO' | 'ACEPTADO_OBS' | 'RECHAZADO' | 'TICKET_PENDIENTE';
  estadoGuia: 'aceptado' | 'rechazado' | 'enviado';
  codigo: string | null;
  mensaje: string;
  errorGuia: string | null;
  observaciones: Array<{ codigo: string; descripcion: string }> | null;
  cdr: { xml: Buffer; zip: Buffer } | null;
  cadenaQr: string | null;
  codigoHash: string | null;
  /** Se mezcla en fiscal_envios.respuesta_json (consultas, revision_manual, última consulta). */
  respuestaEnvio: Record<string, unknown>;
  respuestaGuia: Record<string, unknown>;
  proximoIntentoSeg: number | null;
}

export interface ArchivoGuia {
  nombre: string;
  mime: string;
  contenido: Buffer;
}

/** Otro proceso ya tomó el número candidato: se vuelve a preparar con `siguiente`. */
export class NumeroGuiaOcupadoError extends Error {
  constructor(
    readonly serie: string,
    readonly numero: number,
    readonly siguiente: number,
  ) {
    super(`El número ${serie}-${numero} ya se asignó a otra guía; el siguiente libre es ${siguiente}.`);
    this.name = 'NumeroGuiaOcupadoError';
  }
}

/** La guía ya tiene un envío a SUNAT en curso (índice único de fase13 o la verificación en la transacción). */
export class EnvioGuiaEnCursoError extends Error {
  constructor() {
    super('La guía ya tiene un envío a SUNAT en curso.');
    this.name = 'EnvioGuiaEnCursoError';
  }
}

/**
 * Reclamo (bloqueado_hasta) de un envío o de una consulta del ticket: mientras dura, ningún otro proceso lo
 * toma. Cubre con margen el PEOR caso del cliente REST de la GRE (gre-rest-client.ts: 20 s por petición + 2 s
 * del corte de respaldo; el token con 1 reintento y 1 s de pausa = 45 s; ante un 401 renueva el token una
 * vez). Envío: (45 s de token + 22 s del POST) × 2 = 134 s. Consulta: 45 + 22 (el 401) + 45 + 3 GET con
 * pausas de 1 y 3 s = 182 s. Con un plazo menor, un «Emitir» manual podía reenviar el mismo ZIP mientras el
 * primer envío aún esperaba a SUNAT, y al cerrar se perdía uno de los dos resultados (quizá el ticket).
 */
export const SEGUNDOS_RECLAMO_ENVIO_GUIA = 180;
export const SEGUNDOS_RECLAMO_CONSULTA_GUIA = 240;
/** Estados de fiscal_envios con el resultado aún abierto: uno a la vez por guía. */
export const ESTADOS_ENVIO_GUIA_ABIERTOS = ['ENVIANDO', 'TICKET_PENDIENTE', 'PENDIENTE_REENVIO'] as const;

const MIME_ARCHIVO: Readonly<Record<string, string>> = {
  xml_original: 'application/xml',
  xml_firmado: 'application/xml',
  zip: 'application/zip',
  cdr_xml: 'application/xml',
  cdr_zip: 'application/zip',
};

/** Solo los envíos de la GRE de este sistema (la pila antigua usa proveedor 'sunat-direct' y no guarda id_guia). */
const FILTRO_ENVIO_GRE = `f.operacion = 'emitir' AND f.tipo_documento = '09' AND f.proveedor = 'sunat_directo'`;

const COLUMNAS_GUIA = `
  g.id_guia, g.id_venta, g.id_comprobante, g.id_almacen_origen, g.serie, g.numero,
  COALESCE(NULLIF(TRIM(g.estado), ''), 'borrador') AS estado,
  to_char(g.fecha_emision, 'YYYY-MM-DD') AS fecha_emision,
  to_char(g.fecha_inicio_traslado, 'YYYY-MM-DD') AS fecha_inicio_traslado,
  g.motivo_traslado_codigo, g.modalidad_traslado, g.direccion_origen, g.origen_ubigeo,
  COALESCE(g.direccion_destino, g.direccion_envio) AS direccion_destino, g.destino_ubigeo,
  g.peso_bruto_total::text AS peso_bruto_total, g.unidad_peso, g.numero_bultos::text AS numero_bultos,
  g.destinatario_tipo_doc, g.destinatario_numero_doc, g.destinatario_denominacion, g.destinatario_direccion,
  g.placa_principal, g.marca_vehiculo, g.conductor_nombre, g.conductor_tipo_doc, g.conductor_numero_doc,
  g.conductor_licencia, g.transportista_ruc, g.transportista_denominacion, g.observaciones, g.error_mensaje,
  g.sunat_ticket, g.sunat_responsecode, g.sunat_description, g.cadena_qr, g.codigo_hash, g.payload_sunat,
  to_char(g.creado_en, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS creado_en,
  c.id_comprobante AS comp_id, c.id_tipo AS comp_tipo, c.serie AS comp_serie, c.numero AS comp_numero,
  c.ambiente_fiscal AS comp_ambiente,
  e.id_envio AS env_id, e.estado AS env_estado, e.codigo_sunat AS env_codigo, e.mensaje_sunat AS env_mensaje,
  e.sunat_ticket AS env_ticket, e.intento AS env_intento, e.consultas AS env_consultas,
  e.revision_manual AS env_revision_manual, e.en_curso AS env_en_curso,
  e.proximo_intento_en AS env_proximo, e.actualizado_en AS env_actualizado, e.archivos AS env_archivos`;

/** Comprobante relacionado y último envío de la guía (alias g). */
const UNIONES_GUIA = `
  LEFT JOIN comprobantes c ON c.id_comprobante = g.id_comprobante
  LEFT JOIN LATERAL (
    SELECT f.id_envio, f.estado, f.codigo_sunat, f.mensaje_sunat, f.sunat_ticket, f.intento,
           CASE WHEN f.respuesta_json ->> 'consultas' ~ '^[0-9]{1,6}$'
                THEN (f.respuesta_json ->> 'consultas')::int ELSE 0 END AS consultas,
           COALESCE(f.respuesta_json ->> 'revision_manual', '') = 'true' AS revision_manual,
           (f.bloqueado_hasta IS NOT NULL AND f.bloqueado_hasta >= NOW()) AS en_curso,
           f.proximo_intento_en, f.actualizado_en,
           ARRAY(SELECT DISTINCT a.tipo_artifacto FROM fiscal_artifacts a
                  WHERE a.id_envio = f.id_envio AND a.contenido IS NOT NULL) AS archivos
      FROM fiscal_envios f
     WHERE f.id_guia = g.id_guia AND ${FILTRO_ENVIO_GRE}
     ORDER BY f.id_envio DESC
     LIMIT 1
  ) e ON TRUE`;

function sha256(contenido: Buffer | string): string {
  return createHash('sha256').update(contenido).digest('hex');
}

function texto(valor: unknown): string | null {
  if (valor === null || valor === undefined) return null;
  const limpio = String(valor).trim();
  return limpio === '' ? null : limpio;
}

function entero(valor: unknown): number | null {
  if (valor === null || valor === undefined || valor === '') return null;
  const n = Number(valor);
  return Number.isSafeInteger(n) ? n : null;
}

function decimal(valor: unknown): number | null {
  if (valor === null || valor === undefined || valor === '') return null;
  const n = Number(valor);
  return Number.isFinite(n) ? n : null;
}

/** timestamptz (Date de node-postgres) o texto → ISO 8601. */
function iso(valor: unknown): string | null {
  if (valor instanceof Date) return valor.toISOString();
  return typeof valor === 'string' && valor ? valor : null;
}

function objeto(valor: unknown): Record<string, any> | null {
  return valor && typeof valor === 'object' && !Array.isArray(valor) ? (valor as Record<string, any>) : null;
}

const TIPOS_ARCHIVO_LISTA: readonly TipoArchivoGuia[] = ['xml_firmado', 'zip', 'cdr_xml', 'cdr_zip'];

function archivosDe(lista: unknown): TipoArchivoGuia[] {
  const presentes = new Set(Array.isArray(lista) ? lista.map(String) : []);
  return TIPOS_ARCHIVO_LISTA.filter((tipo) => presentes.has(tipo));
}

/** `%`, `_` y `\` del texto buscado son literales, no comodines de LIKE. */
function patronContiene(valor: string): string {
  return `%${valor.replace(/[\\%_]/g, '\\$&')}%`;
}

/** Índice o restricción de un error de unicidad de PostgreSQL (QueryFailedError copia los campos del driver). */
function restriccionUnica(error: unknown): string | null {
  const e = error as { code?: string; constraint?: string; driverError?: { code?: string; constraint?: string } };
  const codigo = e?.driverError?.code ?? e?.code;
  return codigo === '23505' ? String(e?.driverError?.constraint ?? e?.constraint ?? '') : null;
}

function aFila(f: Record<string, any>): FilaGuia {
  const payload = (objeto(f.payload_sunat) ?? {}) as PayloadGuia;
  return {
    id_guia: Number(f.id_guia),
    id_venta: entero(f.id_venta),
    id_comprobante: entero(f.id_comprobante),
    id_almacen_origen: entero(f.id_almacen_origen),
    serie: texto(f.serie),
    numero: entero(f.numero),
    estado: String(f.estado ?? 'borrador'),
    fecha_emision: texto(f.fecha_emision),
    fecha_inicio_traslado: texto(f.fecha_inicio_traslado),
    motivo_traslado_codigo: texto(f.motivo_traslado_codigo),
    modalidad_traslado: texto(f.modalidad_traslado),
    direccion_origen: texto(f.direccion_origen),
    origen_ubigeo: texto(f.origen_ubigeo),
    direccion_destino: texto(f.direccion_destino),
    destino_ubigeo: texto(f.destino_ubigeo),
    peso_bruto_total: decimal(f.peso_bruto_total),
    unidad_peso: texto(f.unidad_peso),
    numero_bultos: decimal(f.numero_bultos),
    destinatario_tipo_doc: texto(f.destinatario_tipo_doc),
    destinatario_numero_doc: texto(f.destinatario_numero_doc),
    destinatario_denominacion: texto(f.destinatario_denominacion),
    destinatario_direccion: texto(f.destinatario_direccion),
    placa_principal: texto(f.placa_principal),
    marca_vehiculo: texto(f.marca_vehiculo),
    conductor_nombre: texto(f.conductor_nombre),
    conductor_tipo_doc: texto(f.conductor_tipo_doc),
    conductor_numero_doc: texto(f.conductor_numero_doc),
    conductor_licencia: texto(f.conductor_licencia),
    transportista_ruc: texto(f.transportista_ruc),
    transportista_denominacion: texto(f.transportista_denominacion),
    observaciones: texto(f.observaciones),
    error_mensaje: texto(f.error_mensaje),
    sunat_ticket: texto(f.sunat_ticket),
    sunat_responsecode: texto(f.sunat_responsecode),
    sunat_description: texto(f.sunat_description),
    cadena_qr: texto(f.cadena_qr),
    codigo_hash: texto(f.codigo_hash),
    payload,
    creado_en: texto(f.creado_en),
    comprobante:
      f.comp_id === null || f.comp_id === undefined
        ? null
        : {
            id_comprobante: Number(f.comp_id),
            id_tipo: Number(f.comp_tipo),
            serie: String(f.comp_serie ?? ''),
            numero: Number(f.comp_numero),
            ambiente_fiscal: texto(f.comp_ambiente),
          },
    envio:
      f.env_id === null || f.env_id === undefined
        ? null
        : {
            id_envio: Number(f.env_id),
            estado: String(f.env_estado ?? ''),
            codigo: texto(f.env_codigo),
            mensaje: texto(f.env_mensaje),
            ticket: texto(f.env_ticket),
            intento: Number(f.env_intento ?? 0),
            consultas: Number(f.env_consultas ?? 0),
            revision_manual: f.env_revision_manual === true,
            en_curso: f.env_en_curso === true,
            proximo_intento_en: iso(f.env_proximo),
            actualizado_en: iso(f.env_actualizado),
            archivos: archivosDe(f.env_archivos),
          },
  };
}

/** Columnas que escriben POST y PUT. */
const COLUMNAS_GUARDADO = [
  'id_comprobante', 'id_empresa', 'id_cliente', 'id_almacen_origen', 'motivo_traslado_codigo', 'motivo_traslado',
  'modalidad_traslado', 'fecha_inicio_traslado', 'direccion_origen', 'origen_ubigeo', 'direccion_destino',
  'destino_ubigeo', 'direccion_envio', 'peso_bruto_total', 'peso_total', 'unidad_peso', 'numero_bultos',
  'destinatario_tipo_doc', 'destinatario_numero_doc', 'destinatario_denominacion', 'destinatario_direccion',
  'placa_principal', 'marca_vehiculo', 'conductor_nombre', 'conductor_tipo_doc', 'conductor_numero_doc',
  'conductor_licencia', 'transportista_ruc', 'transportista_denominacion', 'observaciones',
] as const;

/** Valores en el orden de COLUMNAS_GUARDADO. */
function valoresGuardado(d: DatosGuardarGuia): unknown[] {
  const valores: Record<(typeof COLUMNAS_GUARDADO)[number], unknown> = {
    id_comprobante: d.id_comprobante,
    id_empresa: d.id_empresa,
    id_cliente: d.id_cliente,
    id_almacen_origen: d.id_almacen_origen,
    motivo_traslado_codigo: d.motivo_traslado_codigo,
    motivo_traslado: d.motivo_traslado_texto,
    modalidad_traslado: d.modalidad_traslado,
    fecha_inicio_traslado: d.fecha_inicio_traslado,
    direccion_origen: d.direccion_origen,
    origen_ubigeo: d.origen_ubigeo,
    direccion_destino: d.direccion_destino,
    destino_ubigeo: d.destino_ubigeo,
    // direccion_envio y peso_total son columnas de la versión anterior: se mantienen para lo que aún las lee.
    direccion_envio: d.direccion_destino,
    peso_bruto_total: d.peso_bruto_total,
    peso_total: d.peso_bruto_total === null ? null : String(d.peso_bruto_total),
    unidad_peso: d.unidad_peso,
    numero_bultos: d.numero_bultos,
    destinatario_tipo_doc: d.destinatario_tipo_doc,
    destinatario_numero_doc: d.destinatario_numero_doc,
    destinatario_denominacion: d.destinatario_denominacion,
    destinatario_direccion: d.destinatario_direccion,
    placa_principal: d.placa_principal,
    marca_vehiculo: d.marca_vehiculo,
    conductor_nombre: d.conductor_nombre,
    conductor_tipo_doc: d.conductor_tipo_doc,
    conductor_numero_doc: d.conductor_numero_doc,
    conductor_licencia: d.conductor_licencia,
    transportista_ruc: d.transportista_ruc,
    transportista_denominacion: d.transportista_denominacion,
    observaciones: d.observaciones,
  };
  return COLUMNAS_GUARDADO.map((columna) => valores[columna]);
}

/**
 * Persistencia de la GRE remitente (guias_remision, guias_remision_items y sus envíos en fiscal_envios +
 * fiscal_artifacts). Solo SQL parametrizado; las transacciones fijan lock_timeout y statement_timeout
 * (TransaccionesFiscales) y los candados son de transacción (pg_advisory_xact_lock), nunca de sesión.
 * La venta y su detalle son la fuente de verdad de lo vendido: el navegador no decide los topes.
 */
@Injectable()
export class GuiaRemisionRepository {
  constructor(
    @InjectDataSource('pgConnection') private readonly bd: DataSource,
    private readonly transacciones: TransaccionesFiscales,
  ) {}

  transaccion<T>(trabajo: (tx: EjecutorSql) => Promise<T>): Promise<T> {
    return this.transacciones.ejecutar(trabajo);
  }

  /** Candado de la transacción (se libera solo al COMMIT o ROLLBACK). */
  async bloquear(tx: EjecutorSql, clave: string): Promise<void> {
    await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [clave]);
  }

  // ── Lectura ────────────────────────────────────────────────────────────────

  async listar(filtro: FiltroListadoGuias): Promise<{ filas: FilaGuia[]; total: number }> {
    const parametros: unknown[] = [];
    const condiciones: string[] = [];
    const agregar = (valor: unknown): string => {
      parametros.push(valor);
      return `$${parametros.length}`;
    };
    if (filtro.estado) condiciones.push(`COALESCE(NULLIF(TRIM(g.estado), ''), 'borrador') = ${agregar(filtro.estado)}`);
    if (filtro.id_venta) condiciones.push(`g.id_venta = ${agregar(filtro.id_venta)}::int`);
    // Los borradores aún no tienen fecha de emisión: cuentan por su día de creación en Lima (creado_en va en UTC).
    const dia = `COALESCE(g.fecha_emision, ((g.creado_en AT TIME ZONE 'UTC') AT TIME ZONE 'America/Lima')::date)`;
    if (filtro.desde) condiciones.push(`${dia} >= ${agregar(filtro.desde)}::date`);
    if (filtro.hasta) condiciones.push(`${dia} <= ${agregar(filtro.hasta)}::date`);
    const busqueda = filtro.texto?.trim();
    if (busqueda) {
      const patron = agregar(patronContiene(busqueda));
      const numerico = /^\d{1,9}$/.test(busqueda) ? agregar(Number(busqueda)) : null;
      condiciones.push(`(
        (COALESCE(g.serie, '') || '-' || COALESCE(LPAD(g.numero::text, 8, '0'), '')) ILIKE ${patron} ESCAPE '\\'
        OR g.destinatario_denominacion ILIKE ${patron} ESCAPE '\\'
        OR g.destinatario_numero_doc ILIKE ${patron} ESCAPE '\\'
        OR (c.serie || '-' || LPAD(c.numero::text, 8, '0')) ILIKE ${patron} ESCAPE '\\'
        ${numerico ? `OR g.id_venta = ${numerico}::int OR g.numero = ${numerico}::int` : ''}
      )`);
    }
    const donde = condiciones.length ? `WHERE ${condiciones.join(' AND ')}` : '';
    const parametrosConteo = [...parametros];
    const porPagina = Math.min(100, Math.max(1, Math.trunc(filtro.por_pagina) || 20));
    const pagina = Math.max(1, Math.trunc(filtro.pagina) || 1);
    const limite = agregar(porPagina);
    const desplazamiento = agregar((pagina - 1) * porPagina);

    const [filas, conteo] = await Promise.all([
      this.bd.query(
        `SELECT ${COLUMNAS_GUIA}
           FROM guias_remision g ${UNIONES_GUIA}
           ${donde}
          ORDER BY g.id_guia DESC
          LIMIT ${limite} OFFSET ${desplazamiento}`,
        parametros,
      ),
      this.bd.query(
        `SELECT COUNT(*)::int AS total
           FROM guias_remision g
           LEFT JOIN comprobantes c ON c.id_comprobante = g.id_comprobante
           ${donde}`,
        parametrosConteo,
      ),
    ]);
    return { filas: filasDe<Record<string, any>>(filas).map(aFila), total: Number(filasDe<{ total: number }>(conteo)[0]?.total ?? 0) };
  }

  /** La guía con su comprobante relacionado y su último envío; `bloquear` = FOR UPDATE de la fila (dentro de una transacción). */
  async obtener(idGuia: number, ejecutor: EjecutorSql = this.bd, bloquear = false): Promise<FilaGuia | null> {
    if (bloquear) await ejecutor.query('SELECT 1 FROM guias_remision WHERE id_guia = $1 FOR UPDATE', [idGuia]);
    const filas = filasDe<Record<string, any>>(
      await ejecutor.query(`SELECT ${COLUMNAS_GUIA} FROM guias_remision g ${UNIONES_GUIA} WHERE g.id_guia = $1`, [idGuia]),
    );
    return filas[0] ? aFila(filas[0]) : null;
  }

  async items(idGuia: number, ejecutor: EjecutorSql = this.bd): Promise<FilaItemGuia[]> {
    const filas = filasDe<Record<string, any>>(
      await ejecutor.query(
        `SELECT i.id_item, i.id_producto, i.id_venta_detalle, i.codigo, i.descripcion, i.unidad_medida,
                i.cantidad::text AS cantidad, COALESCE(i.orden, 0) AS orden, p.codigo_sunat
           FROM guias_remision_items i
           LEFT JOIN productos p ON p.id_producto = i.id_producto
          WHERE i.id_guia = $1
          ORDER BY COALESCE(i.orden, 2147483647), i.id_item`,
        [idGuia],
      ),
    );
    return filas.map((f) => ({
      id_item: Number(f.id_item),
      id_producto: Number(f.id_producto),
      id_venta_detalle: entero(f.id_venta_detalle),
      codigo: texto(f.codigo),
      descripcion: texto(f.descripcion) ?? 'Producto',
      unidad_medida: texto(f.unidad_medida),
      cantidad: Number(f.cantidad ?? 0),
      orden: Number(f.orden ?? 0),
      codigo_sunat: texto(f.codigo_sunat),
    }));
  }

  async venta(idVenta: number, ejecutor: EjecutorSql = this.bd): Promise<VentaGuia | null> {
    const filas = filasDe<Record<string, any>>(
      await ejecutor.query(
        `SELECT v.id_venta,
                to_char((v.fecha AT TIME ZONE 'UTC') AT TIME ZONE 'America/Lima', 'YYYY-MM-DD') AS fecha,
                COALESCE(v.total, 0)::text AS total,
                LOWER(COALESCE(NULLIF(TRIM(v.estado), ''), 'activa')) AS estado,
                v.id_cliente, v.id_empresa,
                e.id_empresa AS e_id, e.ruc AS e_ruc, e.razon_social AS e_razon_social, e.direccion AS e_direccion,
                e.ubigeo AS e_ubigeo, e.departamento AS e_departamento, e.provincia AS e_provincia, e.distrito AS e_distrito,
                c.id_cliente AS c_id, c.dni::text AS c_dni,
                NULLIF(TRIM(CONCAT_WS(' ', c.nombre, c.apellido_paterno, c.apellido_materno)), '') AS c_nombre,
                c.direccion AS c_direccion
           FROM ventas v
           LEFT JOIN empresas e ON e.id_empresa = v.id_empresa
           LEFT JOIN clientes c ON c.id_cliente = v.id_cliente
          WHERE v.id_venta = $1`,
        [idVenta],
      ),
    );
    const f = filas[0];
    if (!f) return null;
    return {
      id_venta: Number(f.id_venta),
      fecha: texto(f.fecha),
      total: Number(f.total ?? 0),
      estado: String(f.estado),
      id_cliente: entero(f.id_cliente),
      id_empresa: entero(f.id_empresa),
      empresa:
        f.e_id === null || f.e_id === undefined
          ? null
          : {
              ruc: texto(f.e_ruc),
              razon_social: texto(f.e_razon_social),
              direccion: texto(f.e_direccion),
              ubigeo: texto(f.e_ubigeo),
              departamento: texto(f.e_departamento),
              provincia: texto(f.e_provincia),
              distrito: texto(f.e_distrito),
            },
      cliente:
        f.c_id === null || f.c_id === undefined
          ? null
          : { dni: texto(f.c_dni), nombre: texto(f.c_nombre), direccion: texto(f.c_direccion) },
    };
  }

  /**
   * Por producto: lo vendido (detalle_venta) y lo que ya llevan las guías VIGENTES de la venta (no anuladas
   * ni rechazadas), sin contar `excluirIdGuia` (la que se está editando o emitiendo).
   */
  async productosVendidos(idVenta: number, excluirIdGuia: number | null, ejecutor: EjecutorSql = this.bd): Promise<ProductoVendidoGuia[]> {
    const filas = filasDe<Record<string, any>>(
      await ejecutor.query(
        `WITH vendido AS (
           SELECT d.id_producto, SUM(d.cantidad)::numeric AS cantidad, MIN(d.id_detalle) AS id_detalle
             FROM detalle_venta d
            WHERE d.id_venta = $1 AND d.id_producto IS NOT NULL
            GROUP BY d.id_producto
         ), en_guias AS (
           SELECT gi.id_producto, SUM(gi.cantidad) AS cantidad
             FROM guias_remision_items gi
             JOIN guias_remision g ON g.id_guia = gi.id_guia
            WHERE g.id_venta = $1
              AND COALESCE(NULLIF(TRIM(g.estado), ''), 'borrador') NOT IN ('anulado', 'rechazado')
              AND ($2::int IS NULL OR g.id_guia <> $2::int)
            GROUP BY gi.id_producto
         )
         SELECT v.id_producto, v.id_detalle, v.cantidad::text AS cantidad_vendida,
                COALESCE(eg.cantidad, 0)::text AS cantidad_en_guias,
                p.nombre, COALESCE(NULLIF(TRIM(p.sku), ''), NULLIF(TRIM(p.codigo_barras), ''), v.id_producto::text) AS codigo,
                p.unidad_medida
           FROM vendido v
           LEFT JOIN en_guias eg ON eg.id_producto = v.id_producto
           LEFT JOIN productos p ON p.id_producto = v.id_producto
          ORDER BY v.id_detalle`,
        [idVenta, excluirIdGuia],
      ),
    );
    return filas.map((f) => ({
      id_producto: Number(f.id_producto),
      id_venta_detalle: Number(f.id_detalle),
      cantidad_vendida: Number(f.cantidad_vendida ?? 0),
      cantidad_en_guias: Number(f.cantidad_en_guias ?? 0),
      nombre: texto(f.nombre),
      codigo: texto(f.codigo),
      unidad_medida: texto(f.unidad_medida),
    }));
  }

  /** Factura o boleta vigente de la venta (no anulada ni en error): el documento relacionado de la guía. */
  async comprobantePrincipal(idVenta: number, ejecutor: EjecutorSql = this.bd): Promise<ComprobanteRelacionadoGuia | null> {
    const filas = filasDe<Record<string, any>>(
      await ejecutor.query(
        `SELECT id_comprobante, id_tipo, serie, numero, ambiente_fiscal
           FROM comprobantes
          WHERE id_venta = $1 AND id_tipo IN (1, 2)
            AND COALESCE(anulado, FALSE) = FALSE AND COALESCE(estado, '') <> 'error'
          ORDER BY id_comprobante
          LIMIT 1`,
        [idVenta],
      ),
    );
    const f = filas[0];
    return f
      ? { id_comprobante: Number(f.id_comprobante), id_tipo: Number(f.id_tipo), serie: String(f.serie), numero: Number(f.numero), ambiente_fiscal: texto(f.ambiente_fiscal) }
      : null;
  }

  /** Almacenes de los que salió el stock de la venta (con la dirección de su sucursal). */
  async almacenesDeSalida(idVenta: number): Promise<AlmacenSalidaGuia[]> {
    const filas = filasDe<Record<string, any>>(
      await this.bd.query(
        `SELECT a.id_almacen, a.nombre, NULLIF(TRIM(s.direccion), '') AS direccion
           FROM (SELECT DISTINCT id_almacen FROM venta_stock_salida WHERE id_venta = $1) x
           JOIN almacenes a ON a.id_almacen = x.id_almacen
           LEFT JOIN sucursales s ON s.id_sucursal = a.id_sucursal
          ORDER BY a.id_almacen`,
        [idVenta],
      ),
    );
    return filas.map((f) => ({ id_almacen: Number(f.id_almacen), nombre: texto(f.nombre), direccion: texto(f.direccion) }));
  }

  async guiasDeVenta(idVenta: number): Promise<Array<{ id_guia: number; serie: string | null; numero: number | null; estado: string }>> {
    const filas = filasDe<Record<string, any>>(
      await this.bd.query(
        `SELECT id_guia, serie, numero, COALESCE(NULLIF(TRIM(estado), ''), 'borrador') AS estado
           FROM guias_remision WHERE id_venta = $1 ORDER BY id_guia`,
        [idVenta],
      ),
    );
    return filas.map((f) => ({ id_guia: Number(f.id_guia), serie: texto(f.serie), numero: entero(f.numero), estado: String(f.estado) }));
  }

  async productos(ids: number[], ejecutor: EjecutorSql = this.bd): Promise<ProductoGuia[]> {
    if (!ids.length) return [];
    const filas = filasDe<Record<string, any>>(
      await ejecutor.query(
        `SELECT id_producto, nombre, unidad_medida,
                COALESCE(NULLIF(TRIM(sku), ''), NULLIF(TRIM(codigo_barras), ''), id_producto::text) AS codigo
           FROM productos WHERE id_producto = ANY($1::int[])`,
        [ids],
      ),
    );
    return filas.map((f) => ({ id_producto: Number(f.id_producto), nombre: texto(f.nombre), codigo: texto(f.codigo), unidad_medida: texto(f.unidad_medida) }));
  }

  /** Primer número libre de la serie: el mayor entre MAX(número) + 1 y el correlativo inicial configurado. */
  async siguienteNumero(serie: string, piso: number, ejecutor: EjecutorSql = this.bd): Promise<number> {
    const filas = filasDe<{ ultimo: string | number | null }>(
      await ejecutor.query('SELECT COALESCE(MAX(numero), 0) AS ultimo FROM guias_remision WHERE serie = $1', [serie]),
    );
    const minimo = Number.isSafeInteger(piso) && piso >= 1 ? piso : 1;
    return Math.max(Number(filas[0]?.ultimo ?? 0) + 1, minimo);
  }

  /** ¿Tiene la guía un envío con el resultado abierto? (lo bloquea para que nadie registre otro a la vez). */
  async envioAbierto(tx: EjecutorSql, idGuia: number): Promise<{ id_envio: number; estado: string } | null> {
    const filas = filasDe<{ id_envio: number; estado: string }>(
      await tx.query(
        `SELECT f.id_envio, f.estado FROM fiscal_envios f
          WHERE f.id_guia = $1 AND ${FILTRO_ENVIO_GRE} AND f.estado = ANY($2::text[])
          ORDER BY f.id_envio DESC LIMIT 1
          FOR UPDATE`,
        [idGuia, ESTADOS_ENVIO_GUIA_ABIERTOS],
      ),
    );
    return filas[0] ? { id_envio: Number(filas[0].id_envio), estado: String(filas[0].estado) } : null;
  }

  async buscarPorClave(clave: string, ejecutor: EjecutorSql = this.bd): Promise<number | null> {
    const filas = filasDe<{ id_guia: number }>(
      await ejecutor.query('SELECT id_guia FROM guias_remision WHERE clave_idempotencia = $1 LIMIT 1', [clave]),
    );
    return filas[0] ? Number(filas[0].id_guia) : null;
  }

  // ── Borrador y edición ─────────────────────────────────────────────────────

  async insertar(
    tx: EjecutorSql,
    datos: DatosGuardarGuia,
    extra: { idVenta: number | null; idUsuario: number | null; clave: string | null },
  ): Promise<number> {
    const valores = valoresGuardado(datos);
    const columnas = [...COLUMNAS_GUARDADO, 'id_venta', 'id_usuario', 'clave_idempotencia', 'payload_sunat'];
    valores.push(extra.idVenta, extra.idUsuario, extra.clave, JSON.stringify({ formulario: datos.formulario }));
    const marcas = valores.map((_, i) => (columnas[i] === 'payload_sunat' ? `$${i + 1}::jsonb` : `$${i + 1}`));
    // creado_en (timestamp sin zona) va en UTC como el resto del sistema, aunque la BD tenga otra zona horaria.
    const filas = filasDe<{ id_guia: number }>(
      await tx.query(
        `INSERT INTO guias_remision (${columnas.join(', ')}, tipo_guia, sunat_tipo_documento, estado, creado_en)
         VALUES (${marcas.join(', ')}, 'remitente', '09', 'borrador', NOW() AT TIME ZONE 'UTC')
         RETURNING id_guia`,
        valores,
      ),
    );
    const idGuia = Number(filas[0]?.id_guia);
    await this.insertarItems(tx, idGuia, datos.items);
    return idGuia;
  }

  /** Reescribe un borrador o una guía rechazada (el estado, la venta y el número no cambian). */
  async actualizar(tx: EjecutorSql, idGuia: number, datos: DatosGuardarGuia): Promise<boolean> {
    const valores = valoresGuardado(datos);
    const asignaciones = COLUMNAS_GUARDADO.map((columna, i) => `${columna} = $${i + 1}`);
    valores.push(JSON.stringify(datos.formulario), idGuia);
    const filas = filasDe<{ id_guia: number }>(
      await tx.query(
        `UPDATE guias_remision
            SET ${asignaciones.join(', ')},
                payload_sunat = COALESCE(payload_sunat, '{}'::jsonb) || jsonb_build_object('formulario', $${valores.length - 1}::jsonb)
          WHERE id_guia = $${valores.length} AND estado IN ('borrador', 'rechazado')
          RETURNING id_guia`,
        valores,
      ),
    );
    if (!filas.length) return false;
    await tx.query('DELETE FROM guias_remision_items WHERE id_guia = $1', [idGuia]);
    await this.insertarItems(tx, idGuia, datos.items);
    return true;
  }

  /** Todas las líneas en un solo INSERT. */
  private async insertarItems(tx: EjecutorSql, idGuia: number, items: ItemGuardarGuia[]): Promise<void> {
    if (!items.length) return;
    await tx.query(
      `INSERT INTO guias_remision_items (id_guia, id_producto, id_venta_detalle, codigo, descripcion, unidad_medida, cantidad, orden)
       SELECT $1, i.id_producto, i.id_venta_detalle, i.codigo, i.descripcion, i.unidad, i.cantidad, i.n
         FROM unnest($2::int[], $3::int[], $4::text[], $5::text[], $6::text[], $7::numeric[])
              WITH ORDINALITY AS i(id_producto, id_venta_detalle, codigo, descripcion, unidad, cantidad, n)
        ORDER BY i.n`,
      [
        idGuia,
        items.map((i) => i.id_producto),
        items.map((i) => i.id_venta_detalle),
        items.map((i) => i.codigo),
        items.map((i) => i.descripcion),
        items.map((i) => i.unidad_medida),
        items.map((i) => String(i.cantidad)),
      ],
    );
  }

  async anular(tx: EjecutorSql, idGuia: number, anulacion: NonNullable<PayloadGuia['anulacion']>): Promise<boolean> {
    const filas = filasDe<{ id_guia: number }>(
      await tx.query(
        `UPDATE guias_remision
            SET estado = 'anulado',
                payload_sunat = COALESCE(payload_sunat, '{}'::jsonb) || jsonb_build_object('anulacion', $2::jsonb)
          WHERE id_guia = $1 AND estado IN ('borrador', 'rechazado')
          RETURNING id_guia`,
        [idGuia, JSON.stringify(anulacion)],
      ),
    );
    return filas.length > 0;
  }

  // ── Emisión ────────────────────────────────────────────────────────────────

  /**
   * Dentro de la transacción del negocio (candados ya tomados): número, serie y estado 'pendiente' en la
   * guía, el envío en ENVIANDO con su reclamo y los tres artefactos en UN solo INSERT. Todo antes
   * de hablar con SUNAT: si el proceso cae después del COMMIT, el envío queda incierto y se reenvía el
   * mismo ZIP. Lanza NumeroGuiaOcupadoError o EnvioGuiaEnCursoError ante los índices únicos.
   */
  async registrarEmision(tx: EjecutorSql, r: RegistroEmisionGuia): Promise<number> {
    const { preparada } = r;
    const documento = preparada.documento;
    const emision: NonNullable<PayloadGuia['emision']> = {
      fecha: documento.fechaEmision,
      hora: documento.horaEmision,
      nombre_base: preparada.nombreBase,
      remitente: documento.remitente,
    };
    try {
      const guia = filasDe<{ id_guia: number }>(
        await tx.query(
          `UPDATE guias_remision
              SET serie = $2, numero = $3, estado = 'pendiente', fecha_emision = $4::date, sunat_tipo_documento = '09',
                  id_comprobante = $5, error_mensaje = NULL, sunat_ticket = NULL, sunat_responsecode = NULL,
                  sunat_description = NULL, cadena_qr = NULL, codigo_hash = NULL,
                  payload_sunat = COALESCE(payload_sunat, '{}'::jsonb) || jsonb_build_object('emision', $6::jsonb)
            WHERE id_guia = $1 AND estado IN ('borrador', 'rechazado', 'pendiente')
              AND numero IS NOT DISTINCT FROM $7::int
            RETURNING id_guia`,
          [r.idGuia, documento.serie, documento.numero, documento.fechaEmision, r.idComprobante, JSON.stringify(emision), r.numeroAnterior],
        ),
      );
      if (!guia.length) throw new EnvioGuiaEnCursoError();

      const datosEnvio = {
        documento,
        digest: preparada.digestValue,
        sha256_zip: preparada.sha256,
        advertencias: preparada.advertencias,
        consultas: 0,
      };
      const envio = filasDe<{ id_envio: number }>(
        await tx.query(
          `INSERT INTO fiscal_envios
             (id_guia, tipo_documento, ambiente, proveedor, operacion, intento, estado, nombre_archivo, identificador,
              id_usuario, fecha_envio, bloqueado_hasta, hash_xml, respuesta_json)
           VALUES ($1, '09', 'produccion', 'sunat_directo', 'emitir', 1, 'ENVIANDO', $2, $3, $4, NOW(),
                   NOW() + $5::int * INTERVAL '1 second', $6, $7::jsonb)
           RETURNING id_envio`,
          [
            r.idGuia,
            `${preparada.nombreBase}.zip`,
            preparada.nombreBase,
            r.idUsuario,
            SEGUNDOS_RECLAMO_ENVIO_GUIA,
            sha256(preparada.xmlFirmado),
            JSON.stringify(datosEnvio),
          ],
        ),
      );
      const idEnvio = Number(envio[0]?.id_envio);
      if (!Number.isSafeInteger(idEnvio) || idEnvio <= 0) throw new Error('No se pudo registrar el envío de la guía.');

      await this.insertarArchivos(tx, idEnvio, [
        { tipo: 'xml_original', nombre: `${preparada.nombreBase}-original.xml`, contenido: Buffer.from(preparada.xml, 'utf8') },
        { tipo: 'xml_firmado', nombre: `${preparada.nombreBase}.xml`, contenido: Buffer.from(preparada.xmlFirmado, 'utf8') },
        { tipo: 'zip', nombre: `${preparada.nombreBase}.zip`, contenido: preparada.zip },
      ]);
      return idEnvio;
    } catch (error) {
      const restriccion = restriccionUnica(error);
      if (restriccion === 'uq_guias_remision_serie_numero') {
        throw new NumeroGuiaOcupadoError(documento.serie, documento.numero, documento.numero + 1);
      }
      if (restriccion !== null) throw new EnvioGuiaEnCursoError();
      throw error;
    }
  }

  /**
   * Reclama el envío incierto de la guía (PENDIENTE_REENVIO, o ENVIANDO con el reclamo vencido) para mandar
   * de nuevo EXACTAMENTE el mismo ZIP. FOR UPDATE SKIP LOCKED: si otro proceso lo tiene, devuelve null.
   */
  async reclamarReenvio(idGuia: number): Promise<EnvioParaReenvio | null> {
    const filas = filasDe<Record<string, any>>(
      await this.bd.query(
        `WITH objetivo AS (
           SELECT f.id_envio FROM fiscal_envios f
            WHERE f.id_guia = $1 AND ${FILTRO_ENVIO_GRE}
              AND f.estado IN ('PENDIENTE_REENVIO', 'ENVIANDO')
              AND (f.bloqueado_hasta IS NULL OR f.bloqueado_hasta < NOW())
            ORDER BY f.id_envio DESC
            LIMIT 1
            FOR UPDATE SKIP LOCKED
         ), tomado AS (
           UPDATE fiscal_envios f
              SET estado = 'ENVIANDO', intento = f.intento + 1, bloqueado_hasta = NOW() + $2::int * INTERVAL '1 second',
                  fecha_envio = NOW(), proximo_intento_en = NULL, actualizado_en = NOW()
             FROM objetivo o
            WHERE f.id_envio = o.id_envio
           RETURNING f.id_envio, f.identificador, f.nombre_archivo, f.respuesta_json
         )
         SELECT t.*,
                (SELECT a.contenido FROM fiscal_artifacts a WHERE a.id_envio = t.id_envio AND a.tipo_artifacto = 'zip'
                  AND a.contenido IS NOT NULL ORDER BY a.id_artifact DESC LIMIT 1) AS zip,
                (SELECT convert_from(a.contenido, 'UTF8') FROM fiscal_artifacts a WHERE a.id_envio = t.id_envio
                  AND a.tipo_artifacto = 'xml_firmado' AND a.contenido IS NOT NULL ORDER BY a.id_artifact DESC LIMIT 1) AS xml_firmado,
                (SELECT convert_from(a.contenido, 'UTF8') FROM fiscal_artifacts a WHERE a.id_envio = t.id_envio
                  AND a.tipo_artifacto = 'xml_original' AND a.contenido IS NOT NULL ORDER BY a.id_artifact DESC LIMIT 1) AS xml
           FROM tomado t`,
        [idGuia, SEGUNDOS_RECLAMO_ENVIO_GUIA],
      ),
    );
    const f = filas[0];
    if (!f) return null;
    const datos = objeto(f.respuesta_json) ?? {};
    return {
      id_envio: Number(f.id_envio),
      nombre_base: texto(f.identificador) ?? String(f.nombre_archivo ?? '').replace(/\.zip$/i, ''),
      documento: (objeto(datos.documento) as DocumentoGre | null) ?? null,
      digest: String(datos.digest ?? ''),
      advertencias: Array.isArray(datos.advertencias) ? datos.advertencias.map(String) : [],
      xml: typeof f.xml === 'string' ? f.xml : null,
      xml_firmado: typeof f.xml_firmado === 'string' ? f.xml_firmado : null,
      zip: Buffer.isBuffer(f.zip) ? f.zip : null,
    };
  }

  /**
   * Guarda el resultado del envío (D5.3: quien llama reintenta si la BD falla, con la respuesta en memoria).
   * Solo pisa un envío que sigue en ENVIANDO y una guía que sigue 'pendiente'; false si otro proceso ya lo cerró.
   */
  async cerrarEnvio(idEnvio: number, cierre: CierreEnvioGuia): Promise<boolean> {
    return this.transaccion(async (tx) => {
      const filas = filasDe<{ id_guia: number }>(
        await tx.query(
          `UPDATE fiscal_envios f
              SET estado = $2::varchar, sunat_ticket = COALESCE($3::varchar, f.sunat_ticket), codigo_sunat = $4::varchar,
                  mensaje_sunat = $5::text,
                  respuesta_json = COALESCE(f.respuesta_json, '{}'::jsonb) || jsonb_build_object('envio', $6::jsonb),
                  ultimo_error = CASE WHEN $2::varchar = 'TICKET_PENDIENTE' THEN NULL ELSE $5::text END,
                  fecha_respuesta = NOW(),
                  proximo_intento_en = CASE WHEN $7::int IS NULL THEN NULL ELSE NOW() + $7::int * INTERVAL '1 second' END,
                  bloqueado_hasta = NULL, actualizado_en = NOW()
            WHERE f.id_envio = $1 AND f.estado = 'ENVIANDO'
            RETURNING f.id_guia`,
          [idEnvio, cierre.estadoEnvio, cierre.ticket, cierre.codigo, cierre.mensaje, JSON.stringify(cierre.respuesta), cierre.proximoIntentoSeg],
        ),
      );
      const idGuia = filas[0]?.id_guia;
      if (idGuia === undefined || idGuia === null) return false;
      await tx.query(
        `UPDATE guias_remision
            SET estado = $2::varchar, sunat_ticket = COALESCE($3::varchar, sunat_ticket), sunat_responsecode = $4::varchar,
                sunat_description = $5::text, error_mensaje = $6::text, respuesta_sunat = $7::jsonb
          WHERE id_guia = $1 AND estado = 'pendiente'`,
        [Number(idGuia), cierre.estadoGuia, cierre.ticket, cierre.codigo, cierre.mensaje, cierre.errorGuia, JSON.stringify(cierre.respuesta)],
      );
      return true;
    });
  }

  // ── Consulta del ticket ────────────────────────────────────────────────────

  /** Envíos con el ticket pendiente cuyo turno de consulta llegó (para la tarea; cada uno se reclama después). */
  async candidatosConsulta(limite: number): Promise<number[]> {
    const filas = filasDe<{ id_envio: number }>(
      await this.bd.query(
        `SELECT f.id_envio
           FROM fiscal_envios f
          WHERE f.id_guia IS NOT NULL AND ${FILTRO_ENVIO_GRE} AND f.estado = 'TICKET_PENDIENTE'
            AND (f.proximo_intento_en IS NULL OR f.proximo_intento_en <= NOW())
            AND (f.bloqueado_hasta IS NULL OR f.bloqueado_hasta < NOW())
            AND COALESCE(f.respuesta_json ->> 'revision_manual', '') <> 'true'
          ORDER BY COALESCE(f.proximo_intento_en, f.actualizado_en), f.id_envio
          LIMIT $1`,
        [Math.max(1, Math.trunc(limite))],
      ),
    );
    return filas.map((f) => Number(f.id_envio));
  }

  /** Reclama el envío para consultar su ticket (FOR UPDATE SKIP LOCKED + plazo de reclamo); null si otro lo tiene. */
  async reclamarConsulta(idEnvio: number): Promise<EnvioParaConsulta | null> {
    const filas = filasDe<Record<string, any>>(
      await this.bd.query(
        `WITH objetivo AS (
           SELECT f.id_envio FROM fiscal_envios f
            WHERE f.id_envio = $1 AND f.id_guia IS NOT NULL AND ${FILTRO_ENVIO_GRE} AND f.estado = 'TICKET_PENDIENTE'
              AND (f.bloqueado_hasta IS NULL OR f.bloqueado_hasta < NOW())
            FOR UPDATE SKIP LOCKED
         )
         UPDATE fiscal_envios f
            SET bloqueado_hasta = NOW() + $2::int * INTERVAL '1 second', actualizado_en = NOW()
           FROM objetivo o
          WHERE f.id_envio = o.id_envio
         RETURNING f.id_envio, f.id_guia, f.sunat_ticket, f.identificador, f.respuesta_json`,
        [idEnvio, SEGUNDOS_RECLAMO_CONSULTA_GUIA],
      ),
    );
    const f = filas[0];
    if (!f) return null;
    const datos = objeto(f.respuesta_json) ?? {};
    const consultas = Number(datos.consultas);
    return {
      id_envio: Number(f.id_envio),
      id_guia: Number(f.id_guia),
      ticket: texto(f.sunat_ticket),
      nombre_base: texto(f.identificador) ?? '',
      documento: (objeto(datos.documento) as EnvioParaConsulta['documento']) ?? null,
      digest: texto(datos.digest),
      consultas: Number.isSafeInteger(consultas) && consultas > 0 ? consultas : 0,
    };
  }

  /** Guarda el resultado de la consulta: solo si el envío sigue con el ticket pendiente y la guía 'enviado'. */
  async cerrarConsulta(idEnvio: number, nombreBase: string, cierre: CierreConsultaGuia): Promise<boolean> {
    return this.transaccion(async (tx) => {
      const filas = filasDe<{ id_guia: number }>(
        await tx.query(
          `UPDATE fiscal_envios f
              SET estado = $2::varchar, codigo_sunat = COALESCE($3::varchar, f.codigo_sunat), mensaje_sunat = $4::text,
                  observaciones = COALESCE($5::text, f.observaciones),
                  respuesta_json = COALESCE(f.respuesta_json, '{}'::jsonb) || $6::jsonb,
                  ultimo_error = CASE WHEN $2::varchar IN ('ACEPTADO', 'ACEPTADO_OBS') THEN NULL ELSE $7::text END,
                  fecha_respuesta = NOW(),
                  proximo_intento_en = CASE WHEN $8::int IS NULL THEN NULL ELSE NOW() + $8::int * INTERVAL '1 second' END,
                  bloqueado_hasta = NULL, actualizado_en = NOW()
            WHERE f.id_envio = $1 AND f.estado = 'TICKET_PENDIENTE'
            RETURNING f.id_guia`,
          [
            idEnvio,
            cierre.estadoEnvio,
            cierre.codigo,
            cierre.mensaje,
            cierre.observaciones ? JSON.stringify(cierre.observaciones) : null,
            JSON.stringify(cierre.respuestaEnvio),
            cierre.errorGuia,
            cierre.proximoIntentoSeg,
          ],
        ),
      );
      const idGuia = filas[0]?.id_guia;
      if (idGuia === undefined || idGuia === null) return false;
      if (cierre.cdr) {
        await this.insertarArchivos(tx, idEnvio, [
          { tipo: 'cdr_xml', nombre: `R-${nombreBase}.xml`, contenido: cierre.cdr.xml },
          { tipo: 'cdr_zip', nombre: `R-${nombreBase}.zip`, contenido: cierre.cdr.zip },
        ]);
      }
      await tx.query(
        `UPDATE guias_remision
            SET estado = $2::varchar, sunat_responsecode = COALESCE($3::varchar, sunat_responsecode), sunat_description = $4::text,
                error_mensaje = $5::text, cadena_qr = COALESCE($6::text, cadena_qr), codigo_hash = COALESCE($7::varchar, codigo_hash),
                respuesta_sunat = $8::jsonb
          WHERE id_guia = $1 AND estado = 'enviado'`,
        [
          Number(idGuia),
          cierre.estadoGuia,
          cierre.codigo,
          cierre.mensaje,
          cierre.errorGuia,
          cierre.cadenaQr,
          cierre.codigoHash,
          JSON.stringify(cierre.respuestaGuia),
        ],
      );
      return true;
    });
  }

  // ── Archivos ───────────────────────────────────────────────────────────────

  /** Archivo del ÚLTIMO envío de la guía (el que vale: el aceptado, o el último rechazo o intento). */
  async archivo(idGuia: number, tipo: TipoArchivoGuia): Promise<ArchivoGuia | null> {
    const filas = filasDe<{ nombre: string | null; mime: string | null; contenido: Buffer | null }>(
      await this.bd.query(
        `SELECT a.nombre, a.mime, a.contenido
           FROM fiscal_artifacts a
          WHERE a.id_envio = (SELECT f.id_envio FROM fiscal_envios f
                               WHERE f.id_guia = $1 AND ${FILTRO_ENVIO_GRE}
                               ORDER BY f.id_envio DESC LIMIT 1)
            AND a.tipo_artifacto = $2 AND a.contenido IS NOT NULL
          ORDER BY a.id_artifact DESC
          LIMIT 1`,
        [idGuia, tipo],
      ),
    );
    const f = filas[0];
    if (!f || !Buffer.isBuffer(f.contenido)) return null;
    return { nombre: f.nombre ?? `guia-${idGuia}-${tipo}`, mime: f.mime ?? MIME_ARCHIVO[tipo] ?? 'application/octet-stream', contenido: f.contenido };
  }

  private async insertarArchivos(
    tx: EjecutorSql,
    idEnvio: number,
    archivos: Array<{ tipo: string; nombre: string; contenido: Buffer }>,
  ): Promise<void> {
    if (!archivos.length) return;
    const parametros: unknown[] = [idEnvio];
    const filas = archivos.map((archivo) => {
      const base = parametros.length;
      parametros.push(
        archivo.tipo,
        `bd:produccion:${idEnvio}:${archivo.tipo}`,
        archivo.nombre,
        MIME_ARCHIVO[archivo.tipo] ?? 'application/octet-stream',
        sha256(archivo.contenido),
        archivo.contenido.length,
        archivo.contenido,
      );
      const marcas = Array.from({ length: 7 }, (_, i) => `$${base + i + 1}`);
      return `($1, ${marcas.join(', ')})`;
    });
    await tx.query(
      `INSERT INTO fiscal_artifacts (id_envio, tipo_artifacto, storage_key, nombre, mime, hash, size, contenido)
       VALUES ${filas.join(', ')}`,
      parametros,
    );
  }
}

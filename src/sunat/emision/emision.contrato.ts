import { Logger } from '@nestjs/common';
import type { AmbienteFiscal } from '../config/fiscal-config.tipos';
import type { MaterialFirma } from '../certificado/material-firma';
import type { DocumentoCpe, EmisorCpe, EstadoSunat, ObservacionSunat } from '../nucleo/documento-fiscal.types';
import type { EnvioCpePreparado } from '../nucleo/preparador-envio-cpe';

/**
 * Contrato de la emisión directa a SUNAT (factura, boleta y notas), igual para BETA y PRODUCCIÓN.
 *
 * Lo implementa EmisionDirectaService (src/sunat/emision) y lo consume el negocio
 * (ComprobanteBussnies, NotaCreditoBussnies, VentaBussnies) por este token de DI, sin conocer
 * certificados, credenciales SOL, endpoints ni SQL de envíos. Es el único punto de unión entre
 * ambos lados: si hace falta un campo nuevo, agréguelo como OPCIONAL.
 *
 * Flujo de un comprobante nuevo (una sola transacción para que nunca quede un número reservado sin
 * su envío ni su ZIP):
 *   contexto() → armar DocumentoCpe con serie y número candidato → prepararDocumento()
 *   → BEGIN; candado de serie; INSERT comprobantes + ítems; registrarEnvio(tx, …); COMMIT
 *   → enviarRegistrado(idEnvio, preparado).
 * El ambiente de TODO el flujo es `preparado.ambiente` (certificado, emisor, serie, credenciales y
 * filas): si el ambiente vigente cambió entre preparar y registrar, registrarEnvio falla con
 * FISCAL_AMBIENTE_CAMBIO y el negocio no debe reintentar con el mismo documento.
 */

export const TIPOS_ARCHIVO_ENVIO = ['xml_original', 'xml_firmado', 'zip', 'cdr_xml', 'cdr_zip'] as const;
export type TipoArchivoEnvio = (typeof TIPOS_ARCHIVO_ENVIO)[number];

/** Tope de filas por página en los listados de envíos (la implementación lo aplica aunque pidan más). */
export const MAXIMO_ENVIOS_POR_PAGINA = 100;

/**
 * ¿Se puede emitir ahora? BETA: interruptor «POS en prueba BETA». PRODUCCIÓN: proveedor sunat_directo
 * activo. `codigo` del caso inactivo (lista abierta): FISCAL_BETA_POS_APAGADO, FISCAL_EMISION_INACTIVA,
 * FISCAL_EMISION_BLOQUEADA (SUNAT rechazó la credencial SOL o el certificado: se reanuda desde el
 * panel), FISCAL_MIGRACION_PENDIENTE, FISCAL_LECTURA_ERROR (no se pudo leer la configuración).
 */
export type ModoEmision =
  | { activo: true; ambiente: AmbienteFiscal }
  | { activo: false; ambiente: AmbienteFiscal; codigo: string; motivo: string };

export interface SeriesEmision {
  factura: string;
  boleta: string;
  nc_factura: string;
  nc_boleta: string;
  nd_factura: string;
  nd_boleta: string;
}

/** Lo que el negocio necesita saber del ambiente vigente (sin secretos). */
export interface ContextoEmision {
  ambiente: AmbienteFiscal;
  /** Emisor que figurará en el comprobante: de pruebas en BETA, el real en PRODUCCIÓN. */
  emisor: EmisorCpe;
  series: SeriesEmision;
  /** Aviso para el cajero/panel, p. ej. «Prueba SUNAT BETA: sin validez tributaria». Null en producción. */
  aviso: string | null;
  /**
   * Primer número que puede usar cada serie (por serie; las que no aparecen empiezan en 1). Lo fija el
   * administrador cuando la serie ya se usó fuera de este sistema (p. ej. con el proveedor anterior):
   * el siguiente número es el mayor entre MAX(local) + 1 y este valor.
   */
  correlativo_inicial: Record<string, number>;
}

/** Resultado de validar + armar XML + firmar + ZIP. No usa red ni base de datos. */
export interface DocumentoPreparado {
  ambiente: AmbienteFiscal;
  documento: DocumentoCpe;
  material: MaterialFirma;
  preparado: EnvioCpePreparado;
}

/**
 * Conexión de una transacción ya abierta por el negocio (EntityManager de TypeORM o QueryRunner).
 * La emisión solo usa query() con parámetros $n; nunca abre ni cierra la transacción.
 */
export interface ConsultorTx {
  query(sql: string, parametros?: unknown[]): Promise<any>;
}

export interface ResultadoEmision {
  ambiente: AmbienteFiscal;
  id_envio: number;
  nombre_base: string;
  estado: EstadoSunat;
  aceptado: boolean;
  codigo: string | null;
  mensaje: string | null;
  observaciones: ObservacionSunat[];
  /** DigestValue del XML firmado (valor resumen). */
  digest: string;
  cadena_qr: string;
  /** Qué hacer a continuación (AccionSunat del clasificador), si aplica. */
  accion?: string | null;
  archivos: TipoArchivoEnvio[];
  id_comprobante?: number | null;
  serie?: string;
  numero?: number;
  /** Último día (yyyy-mm-dd, Lima) para que SUNAT reciba el documento por envío individual. */
  fecha_limite_envio?: string | null;
}

export interface EnvioVista {
  id_envio: number;
  ambiente: AmbienteFiscal;
  tipo_documento: string;
  nombre_archivo: string;
  estado: string;
  codigo_sunat: string | null;
  mensaje_sunat: string | null;
  accion_sunat: string | null;
  id_comprobante: number | null;
  creado_en: string;
  archivos: TipoArchivoEnvio[];
  serie?: string | null;
  numero?: number | null;
  intento?: number;
  proximo_intento_en?: string | null;
  bloqueado_hasta?: string | null;
  actualizado_en?: string | null;
}

export interface FiltroEnvios {
  ambiente?: AmbienteFiscal;
  estado?: string;
  /** Catálogo 01: '01' | '03' | '07' | '08'. */
  tipo?: string;
  id_comprobante?: number;
  pagina?: number;
  /** Máximo MAXIMO_ENVIOS_POR_PAGINA. */
  por_pagina?: number;
}

export interface ArchivoEnvio {
  nombre: string;
  mime: string;
  contenido: Buffer;
}

/** Resultado final de un envío, ya guardado en la base de datos. */
export interface EventoEnvioCompletado {
  id_envio: number;
  id_comprobante: number | null;
  ambiente: AmbienteFiscal;
  /** Catálogo 01 del documento enviado. */
  tipo_documento: string;
  estado: EstadoSunat;
  aceptado: boolean;
  /** Quién cerró el envío: 'envio' | 'reintento' | 'recuperacion' | 'tarea' | 'manual'. */
  origen: string;
}

/**
 * Lo implementa el negocio que debe reaccionar cuando SUNAT resuelve un envío (p. ej. la nota de
 * crédito devuelve stock o anula la venta recién cuando queda ACEPTADA). Se registra en
 * OyentesEnvioFiscal al iniciar el módulo. DEBE ser idempotente (puede llamarse más de una vez por el
 * mismo envío: la tarea programada reprocesa los pendientes) y no debe lanzar.
 */
export abstract class OyenteEnvioFiscal {
  abstract alCompletarEnvio(evento: EventoEnvioCompletado): Promise<void>;
}

/** Registro en memoria de los oyentes (un singleton por proceso; lo provee el registro de emisión). */
export class OyentesEnvioFiscal {
  private readonly logger = new Logger(OyentesEnvioFiscal.name);
  private readonly oyentes: OyenteEnvioFiscal[] = [];

  registrar(oyente: OyenteEnvioFiscal): void {
    if (!this.oyentes.includes(oyente)) this.oyentes.push(oyente);
  }

  /** Avisa a todos; el fallo de uno no impide a los demás ni tumba el envío (queda en el log y la tarea lo reintenta). */
  async notificar(evento: EventoEnvioCompletado): Promise<void> {
    for (const oyente of this.oyentes) {
      try {
        await oyente.alCompletarEnvio(evento);
      } catch (error) {
        const detalle = error instanceof Error ? error.message : String(error);
        this.logger.error(`Oyente ${oyente.constructor.name} falló con el envío ${evento.id_envio}: ${detalle}`);
      }
    }
  }
}

export abstract class EmisionDirecta {
  /** Estado de la emisión en el ambiente vigente. Nunca lanza: cualquier fallo de lectura vuelve como inactivo con FISCAL_LECTURA_ERROR. */
  abstract modo(): Promise<ModoEmision>;

  /** Emisor, series, aviso y correlativos iniciales del ambiente vigente. Lanza FiscalConfigError si el ambiente no está listo para emitir. */
  abstract contexto(): Promise<ContextoEmision>;

  /**
   * Valida el documento, arma el XML UBL, lo firma con el certificado del ambiente y empaqueta el ZIP.
   * Falla (FiscalConfigError) ANTES de reservar número si el RUC del certificado o del usuario SOL no es el del emisor.
   */
  abstract prepararDocumento(documento: DocumentoCpe): Promise<DocumentoPreparado>;

  /**
   * Dentro de la transacción del negocio que acaba de insertar el comprobante: guarda el envío en
   * ENVIANDO (con plazo de bloqueo), el XML, el XML firmado y el ZIP, y los datos fiscales del
   * comprobante (estado_sunat, id_envio_ultimo, cadena_qr, codigo_hash, hora_emision, forma_pago,
   * cuotas, fecha_limite_envio). No usa la red. Devuelve el id del envío.
   */
  abstract registrarEnvio(
    consultor: ConsultorTx,
    preparado: DocumentoPreparado,
    idComprobante: number,
    idUsuario: number | null,
  ): Promise<number>;

  /**
   * Manda a SUNAT el envío ya registrado (después del COMMIT) y guarda la respuesta y el CDR. Si se pasa
   * `preparado` se usa el ZIP en memoria; si no, se lee el guardado. Nunca reintenta sendBill solo.
   */
  abstract enviarRegistrado(idEnvio: number, preparado?: DocumentoPreparado): Promise<ResultadoEmision>;

  /** Atajo para comprobantes ya guardados: registrarEnvio en su propia transacción + enviarRegistrado. */
  abstract emitirPreparado(
    preparado: DocumentoPreparado,
    idComprobante: number,
    idUsuario: number | null,
  ): Promise<ResultadoEmision>;

  /**
   * Reenvío seguro del MISMO ZIP (PENDIENTE_REENVIO, o ENVIANDO con el bloqueo vencido). Si el documento
   * admite getStatusCdr (producción, 01/07/08 serie F) recupera antes el CDR y solo reenvía si SUNAT no lo tiene.
   */
  abstract reintentar(idEnvio: number): Promise<ResultadoEmision>;

  /** Consulta el CDR a SUNAT (getStatusCdr: solo producción y documentos que lo admiten) sin reenviar nada. */
  abstract recuperarCdr(idEnvio: number): Promise<ResultadoEmision>;

  /**
   * Para boletas (o BETA) cuyo resultado quedó incierto y que el administrador verificó en SUNAT Operaciones
   * en Línea: marca el envío como aceptado con su usuario y nota en la auditoría. No llama a SUNAT.
   */
  abstract confirmarAceptadoManual(idEnvio: number, idUsuario: number, nota: string): Promise<ResultadoEmision>;

  abstract obtenerArchivo(idEnvio: number, tipo: TipoArchivoEnvio): Promise<ArchivoEnvio | null>;

  abstract listarEnvios(filtro: FiltroEnvios): Promise<{ datos: EnvioVista[]; total: number; pagina: number; por_pagina: number }>;

  abstract obtenerEnvio(idEnvio: number): Promise<EnvioVista | null>;
}

import type { CredencialesSol, MaterialFirma } from '../certificado/material-firma';
import type { CredencialesGre } from '../seguridad/credenciales-gre.service';
import type { ResultadoPreparacion } from './checklist-activacion';
import type { ActualizarConfigFiscalDto } from './fiscal-config.dto';
import type { ActorFiscal, AmbienteFiscal, EmisorFiscal } from './fiscal-config.tipos';
import type { ConfiguracionFiscalVista } from './vista-config-fiscal';

/**
 * Tokens para resolver de forma perezosa (ModuleRef) los servicios que
 * dependen de FiscalConfigService, sin crear dependencias circulares ni
 * importaciones cruzadas entre archivos.
 */
export const EVALUADOR_PREPARACION_FISCAL = Symbol('EVALUADOR_PREPARACION_FISCAL');
export const GESTOR_CONFIG_FISCAL = Symbol('GESTOR_CONFIG_FISCAL');

export interface EvaluadorPreparacionFiscal {
  listoParaProduccion(): Promise<ResultadoPreparacion>;
}

export interface ResultadoGuardadoFiscal extends ConfiguracionFiscalVista {
  advertencias: string[];
}

export interface GestorConfigFiscal {
  obtenerConfigCompleta(): Promise<ConfiguracionFiscalVista>;
  guardar(dto: ActualizarConfigFiscalDto, actor: ActorFiscal): Promise<ResultadoGuardadoFiscal>;
}

// ── Puntos de extensión para otros módulos SUNAT (opcionales) ───────────────
// Se registran con `{ provide: TOKEN, useClass/useExisting: ... }` en su propio
// *.registro.ts. Si no hay ninguno registrado, /fiscal/* sigue funcionando.

/** Envío de prueba de factura/boleta/notas (lo implementa el módulo de emisión en src/sunat/pruebas). */
export const PROBADOR_ENVIO_CPE = Symbol('PROBADOR_ENVIO_CPE');
export const EMISOR_PRUEBA_BETA = Symbol('EMISOR_PRUEBA_BETA');
export interface EmisorPruebaBeta {
  obtenerEmisor(): Promise<EmisorFiscal>;
}
/** Prueba de la GRE remitente: token OAuth2 y, en BETA, envío de una guía de prueba (módulo GRE). */
export const PROBADOR_ENVIO_GRE = Symbol('PROBADOR_ENVIO_GRE');
/** Cola, plazos y último envío para GET /fiscal/estado (módulo de documentos y tareas). */
export const FUENTE_ESTADO_OPERATIVO_FISCAL = Symbol('FUENTE_ESTADO_OPERATIVO_FISCAL');

export interface PasoPruebaFiscal {
  /** 'esquema' | 'cifrado' | 'certificado' | 'firma' | 'credenciales' | 'conexion' | 'respuesta' | 'envio' | … */
  paso: string;
  /** null = no se ejecutó (no aplica o no está disponible). */
  ok: boolean | null;
  detalle: string;
  codigo?: string;
  tiempo_ms?: number;
  observaciones?: Array<{ codigo: string; descripcion: string }>;
  envio_id?: number;
  archivos?: Array<'xml_original' | 'xml_firmado' | 'zip' | 'cdr_xml' | 'cdr_zip'>;
}

export interface ContextoPruebaEnvio {
  ambiente: AmbienteFiscal;
  documento: 'cpe' | 'gre';
  tipoCpe?: '01' | '03';
  material: MaterialFirma;
  emisor: EmisorFiscal;
  /** Siempre presente para cpe; para gre viene dentro de credencialesGre. */
  credencialesSol?: CredencialesSol;
  credencialesGre?: CredencialesGre;
  idUsuario: number | null;
}

export interface ProbadorEnvioFiscal {
  /**
   * Debe respetar el ambiente: en BETA puede enviar un documento de prueba con
   * numeración propia (siguienteCorrelativoBeta); en PRODUCCIÓN no emite nada
   * (solo autentica/consulta, p. ej. getStatusCdr o el token de la GRE).
   */
  probar(contexto: ContextoPruebaEnvio): Promise<PasoPruebaFiscal[]>;
}

export interface EstadoOperativoFiscal {
  cola?: Record<string, number> | null;
  plazos?: Record<string, number> | null;
  ultimo_envio_ok?: string | null;
  ultimo_error?: { codigo: string; mensaje: string; en: string } | null;
  tareas?: { activas: boolean; ultima_ejecucion: string | null } | null;
}

export interface FuenteEstadoOperativoFiscal {
  estadoOperativo(): Promise<EstadoOperativoFiscal>;
}

import type { EmisorCpe } from '../nucleo/documento-fiscal.types';
import type {
  AccionGre,
  DireccionGre,
  DocumentoGre,
  ErrorSunatGre,
  EstadoEnvioGre,
  ResultadoValidacionGre,
} from './gre.tipos';

/**
 * Contrato del motor de la Guía de Remisión Electrónica remitente (API REST de SUNAT).
 *
 * Es PURO respecto a la base de datos: no guarda nada. El negocio (guia-remision.bussnies) reserva el número,
 * guarda el ZIP ANTES de enviar y persiste el resultado; el motor valida, arma el XML, firma, empaqueta,
 * obtiene el token y habla con SUNAT. No hay ambiente BETA aislado para la GRE: enviar = emitir de verdad.
 * Se inyecta por este token de DI (lo implementa GreEmisionService en src/sunat/gre).
 */

export type ModoEmisionGre = { activo: true } | { activo: false; codigo: string; motivo: string };

export interface ContextoGre {
  emisor: EmisorCpe;
  /** Serie de la GRE remitente configurada (T001 por defecto). */
  serie: string;
  /** Punto de partida por defecto (domicilio fiscal o el configurado para GRE). */
  partidaPorDefecto: DireccionGre;
}

/** Resultado de validar + armar XML + firmar + ZIP. Sin red ni base de datos. */
export interface GrePreparada {
  documento: DocumentoGre;
  /** RUC-09-T001-00000001 (nombre del .xml y del .zip sin extensión). */
  nombreBase: string;
  xml: string;
  xmlFirmado: string;
  zip: Buffer;
  zipBase64: string;
  /** SHA-256 del ZIP (hashZip del envío). */
  sha256: string;
  /** DigestValue de la firma (valor resumen). */
  digestValue: string;
  advertencias: string[];
}

export interface ResultadoEnvioGre {
  estado: EstadoEnvioGre;
  /** numTicket que devuelve SUNAT al recibir el ZIP. */
  ticket: string | null;
  fechaRecepcion: string | null;
  codigo: string | null;
  mensaje: string;
  errores: ErrorSunatGre[];
  accion: AccionGre;
  /** Estado HTTP de la respuesta (null si no hubo respuesta: red, timeout o no se llegó a enviar). */
  httpStatus?: number | null;
  /** Respuesta de SUNAT para auditoría: sin secretos, sin el CDR en base64 y truncada a 20 KB. */
  crudo?: string | null;
}

/** La guía enviada, para comprobar que la constancia (CDR) que devuelve la consulta del ticket le corresponde. */
export interface GreEsperada {
  rucEmisor: string;
  serie: string;
  numero: number;
}

export interface CdrGre {
  nombre: string;
  /** XML de la constancia (ya extraído del ZIP). */
  xml: Buffer;
  zip: Buffer;
  /**
   * Texto de cac:DocumentResponse/cac:DocumentReference/cbc:DocumentDescription: SUNAT pone ahí el enlace
   * para el código QR de la guía aceptada (lo lee igual Greenter; [NO VERIFICADO] con un CDR real).
   */
  enlaceQr?: string | null;
}

export interface ResultadoConsultaGre {
  estado: EstadoEnvioGre;
  codigo: string | null;
  mensaje: string;
  errores: ErrorSunatGre[];
  accion: AccionGre;
  /** Presente cuando SUNAT generó la constancia (aceptada, o rechazada con CDR). */
  cdr: CdrGre | null;
  /** Observaciones de una constancia aceptada (cbc:Note, códigos 4000 en adelante). */
  observaciones?: ErrorSunatGre[];
  /** Si la constancia no corresponde a la guía esperada, por qué (no se da por aceptada ni rechazada). */
  cdrNoCorresponde?: string | null;
  httpStatus?: number | null;
  /** Respuesta de SUNAT para auditoría: sin secretos, sin el CDR en base64 y truncada a 20 KB. */
  crudo?: string | null;
}

export abstract class EmisionGre {
  /** ¿Se puede emitir GRE ahora? (GRE activa en la configuración fiscal, ambiente producción, credenciales API presentes). Nunca lanza: explica en `motivo`. */
  abstract modo(): Promise<ModoEmisionGre>;

  /** Emisor, serie y punto de partida por defecto. Lanza FiscalConfigError si la configuración fiscal no permite emitir. */
  abstract contexto(): Promise<ContextoGre>;

  /** Validación pura (formatos, catálogos, campos obligatorios según modalidad y motivo). Sirve también para «validar sin enviar». */
  abstract validar(documento: DocumentoGre): ResultadoValidacionGre;

  /** Valida, arma el XML DespatchAdvice 2.1, lo firma con el certificado de producción y arma el ZIP. Sin red ni BD. */
  abstract prepararDocumento(documento: DocumentoGre): Promise<GrePreparada>;

  /** Obtiene el token y envía el ZIP. NO reintenta solo. Nunca lanza por errores de SUNAT: los normaliza en el resultado. */
  abstract enviar(preparada: GrePreparada): Promise<ResultadoEnvioGre>;

  /**
   * Consulta el ticket. Con código 0 trae el CDR listo para guardar. Se puede repetir sin riesgo.
   * Si llega `esperada`, la constancia solo se da por buena cuando corresponde a esa guía (RUC, serie y número).
   */
  abstract consultarTicket(ticket: string, esperada?: GreEsperada): Promise<ResultadoConsultaGre>;
}

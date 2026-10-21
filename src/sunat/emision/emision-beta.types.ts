import type {
  EstadoSunat,
  ObservacionSunat,
} from '../nucleo/documento-fiscal.types';

export const TIPOS_ARCHIVO_BETA = [
  'xml_original',
  'xml_firmado',
  'zip',
  'cdr_xml',
  'cdr_zip',
] as const;
export type TipoArchivoBeta = (typeof TIPOS_ARCHIVO_BETA)[number];

export interface ArchivoEnvioBeta {
  tipo: TipoArchivoBeta;
  nombre: string;
  mime: string;
  contenido: Buffer;
}

export interface ResultadoEmisionBeta {
  ambiente: 'beta';
  id_envio: number;
  nombre_base: string;
  estado: EstadoSunat;
  aceptado: boolean;
  codigo: string;
  mensaje: string;
  observaciones: ObservacionSunat[];
  digest: string;
  cadena_qr: string;
  archivos: TipoArchivoBeta[];
}

export interface EnvioBetaVista {
  id_envio: number;
  tipo_documento: string;
  nombre_archivo: string;
  estado: string;
  codigo_sunat: string | null;
  mensaje_sunat: string | null;
  accion_sunat: string | null;
  creado_en: string;
  archivos: TipoArchivoBeta[];
}

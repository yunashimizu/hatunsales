/** Origen del dato: dónde se encontró el receptor. */
export type OrigenReceptor = 'base' | 'externo' | 'generico';

/**
 * Forma única con la que viaja el receptor de un comprobante, sea una persona
 * con DNI o una empresa con RUC. El frontend no necesita distinguir el caso.
 */
export interface ReceptorResponse {
  origen: OrigenReceptor;
  tipo: 'cliente' | 'empresa';

  id_cliente?: number;
  id_empresa?: number;

  /** Catálogo 06: 1 DNI, 6 RUC. */
  tipo_documento: number;
  numero_documento: string;
  denominacion: string;

  direccion: string;
  email: string;
  telefono: string;

  nombre_comercial?: string;
  estado?: string;
  condicion?: string;

  /**
   * Fase 3.5: ubicación del domicilio cuando la fuente la tiene (empresas: base local o consulta de RUC).
   * Ausentes en personas (la consulta de DNI no trae ubigeo) y en los borradores.
   */
  ubigeo?: string;
  departamento?: string;
  provincia?: string;
  distrito?: string;

  /** Solo con RUC activo y habido se puede emitir factura. */
  admite_factura: boolean;
  /** Aviso a mostrar en pantalla, por ejemplo si el RUC está de baja. */
  advertencia?: string;
}

export interface SugerenciaReceptor {
  tipo: 'cliente' | 'empresa';
  id_cliente?: number;
  id_empresa?: number;
  tipo_documento: number;
  numero_documento: string;
  denominacion: string;
}

export type TipoDocumentoFiscal = '01' | '03' | '07' | '09';
export type FiscalStatus =
  | 'PENDIENTE'
  | 'VALIDADO'
  | 'FIRMADO'
  | 'ENVIANDO'
  | 'ACEPTADO'
  | 'ACEPTADO_CON_OBSERVACIONES'
  | 'RECHAZADO'
  | 'EXCEPCION'
  | 'ERROR_TRANSPORTE'
  | 'TICKET_PENDIENTE'
  | 'ANULADO';

export type EstadoFiscal = FiscalStatus;

export interface ProveedorFiscalDatos {
  ruc: string;
  razonSocial: string;
  direccion?: string;
  ubigeo?: string;
}

export interface ClienteFiscalDatos {
  tipoDocumento?: string;
  numeroDocumento?: string;
  denominacion?: string;
  direccion?: string;
  email?: string;
}

export interface LineaFiscalDocumento {
  id?: string;
  descripcion: string;
  cantidad: number;
  unidad: string;
  precioUnitario: number;
  valorUnitario?: number;
  descuento?: number;
  subtotal?: number;
  igv?: number;
  total?: number;
  codigoProducto?: string;
  codigoSunat?: string;
  afectacionIgv?: '10' | '20' | '30' | '40';
}

export interface ImpuestosFiscalDocumento {
  igv: number;
  total: number;
}

export interface TotalesFiscalDocumento {
  gravada: number;
  exonerada: number;
  inafecta: number;
  descuento: number;
  igv: number;
  total: number;
}

export interface ReferenciaNotaCredito {
  documentoModificado: { tipoDocumento: '01' | '03'; series: string; number: number };
  motivo: string;
  sustento: string;
}

export interface DocumentoFiscalBase {
  documentType: TipoDocumentoFiscal;
  series: string;
  number: number;
  issueDate: string;
  issueTime: string;
  currency: 'PEN' | 'USD';
  supplier: ProveedorFiscalDatos;
  customer?: ClienteFiscalDatos;
  lines: LineaFiscalDocumento[];
  taxes: ImpuestosFiscalDocumento;
  totals: TotalesFiscalDocumento;
  /** Obligatorio cuando documentType === '07' (Nota de Crédito): a qué documento se refiere y por qué. */
  notaCredito?: ReferenciaNotaCredito;
}

export interface FiscalIssueResult {
  success: boolean;
  estado: FiscalStatus;
  idEnvio?: number;
  ticket?: string;
  codigoSunat?: string;
  mensajeSunat?: string;
  observaciones?: string[];
  hash?: string;
  xml?: Buffer;
  zip?: Buffer;
  cdr?: Buffer;
}

export interface ResultadoPreparacionFiscal {
  ok: boolean;
  estado: FiscalStatus;
  mensaje: string;
  codigo?: string;
  payload?: Record<string, any>;
}

export interface FiscalCpeDocument extends DocumentoFiscalBase {
  documentType: '01' | '03' | '07';
}

export interface FiscalGreDocument {
  documentType: '09';
  series: string;
  number: number;
  issueDate: string;
  issueTime: string;
  supplier: ProveedorFiscalDatos;
  customer?: ClienteFiscalDatos;
  lines: LineaFiscalDocumento[];
  totals: TotalesFiscalDocumento;
  motivoTraslado?: string;
  modalidadTraslado?: string;
  origenUbigeo?: string;
  destinoUbigeo?: string;
  origenDireccion?: string;
  destinoDireccion?: string;
  pesoBrutoTotalKg?: number;
  fechaInicioTraslado?: string;
  transportista?: { ruc: string; razonSocial: string };
  vehiculoPlaca?: string;
  conductorNumeroDocumento?: string;
  conductorLicencia?: string;
}

export interface CpeProvider {
  emitir(documento: FiscalCpeDocument): Promise<FiscalIssueResult>;
  consultar(idEnvio: number): Promise<FiscalIssueResult>;
  enviarResumen?(resumen: Record<string, any>): Promise<FiscalIssueResult>;
  enviarBaja?(baja: Record<string, any>): Promise<FiscalIssueResult>;
}

export interface GreProvider {
  emitir(documento: FiscalGreDocument): Promise<FiscalIssueResult>;
  consultar(idEnvio: number): Promise<FiscalIssueResult>;
}

export interface FiscalProvider {
  preparar(documento: DocumentoFiscalBase): Promise<ResultadoPreparacionFiscal>;
  consultarEstado?(idDocumento: string): Promise<ResultadoPreparacionFiscal>;
}

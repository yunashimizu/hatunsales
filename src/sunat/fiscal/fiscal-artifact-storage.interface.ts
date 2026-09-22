export type FiscalArtifactType =
  | 'XML_ORIGINAL'
  | 'XML_FIRMADO'
  | 'ZIP_ENVIADO'
  | 'CDR_XML'
  | 'CDR_ZIP'
  | 'PDF';

export interface GuardarArtifactInput {
  idEnvio: number;
  tipo: FiscalArtifactType;
  mime?: string;
  content: Buffer | Uint8Array | string;
  hash?: string;
}

export interface FiscalArtifactStorage {
  guardar(input: GuardarArtifactInput): Promise<{ storageKey: string; size: number; hash: string }>;
  leer(storageKey: string): Promise<Buffer>;
}

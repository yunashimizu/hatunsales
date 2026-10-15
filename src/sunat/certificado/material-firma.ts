/**
 * Material para firmar XML-DSig. Es estructuralmente idéntico a `MaterialFirma`
 * de src/sunat/nucleo/documento-fiscal.types.ts (contrato §12.1 del diseño),
 * así que ambos tipos son intercambiables.
 */
export interface MaterialFirma {
  privateKeyPem: string;
  certificatePem: string;
  huellaSha256: string;
  ruc?: string | null;
  vigenteHasta: Date;
  autofirmado: boolean;
}

/** Usuario y clave para el UsernameToken de los servicios SOAP de SUNAT. */
export interface CredencialesSol {
  /** RUC + usuario secundario (en BETA: RUC + MODDATOS). */
  usuario: string;
  clave: string;
}

import { EstadoFiscal, FiscalStatus } from './fiscal-provider.interface';

export class FiscalStatusMapper {
  static normalizar(estado?: string): FiscalStatus {
    const valor = (estado ?? '').toUpperCase().trim();

    const mapa: Record<string, FiscalStatus> = {
      PENDIENTE: 'PENDIENTE',
      VALIDADO: 'VALIDADO',
      FIRMADO: 'FIRMADO',
      ENVIANDO: 'ENVIANDO',
      ACEPTADO: 'ACEPTADO',
      ACEPTADO_CON_OBSERVACIONES: 'ACEPTADO_CON_OBSERVACIONES',
      RECHAZADO: 'RECHAZADO',
      EXCEPCION: 'EXCEPCION',
      ERROR_TRANSPORTE: 'ERROR_TRANSPORTE',
      TICKET_PENDIENTE: 'TICKET_PENDIENTE',
      ANULADO: 'ANULADO',
      ERROR: 'EXCEPCION',
      ENVIADO: 'ENVIANDO',
      EMITIDO: 'ACEPTADO',
    };

    return mapa[valor] ?? 'PENDIENTE';
  }

  static aEstadoInterno(estado: EstadoFiscal): string {
    return estado;
  }
}

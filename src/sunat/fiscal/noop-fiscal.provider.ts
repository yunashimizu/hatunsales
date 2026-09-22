import { FiscalProvider, DocumentoFiscalBase, ResultadoPreparacionFiscal } from './fiscal-provider.interface';

export class NoopFiscalProvider implements FiscalProvider {
  async preparar(documento: DocumentoFiscalBase): Promise<ResultadoPreparacionFiscal> {
    return {
      ok: false,
      estado: 'PENDIENTE',
      mensaje: 'Proveedor fiscal inactivo en la Fase 1: el documento queda pendiente sin emitir a SUNAT.',
      codigo: 'FASE1_PENDING',
      payload: {
        documentType: documento.documentType,
        series: documento.series,
        number: documento.number,
        supplier: documento.supplier,
      },
    };
  }
}

import { NoopFiscalProvider } from './noop-fiscal.provider';

describe('NoopFiscalProvider', () => {
  it('debe quedar pendiente sin intentar emitir a SUNAT', async () => {
    const provider = new NoopFiscalProvider();
    const result = await provider.preparar({
      documentType: '01',
      series: 'FFF1',
      number: 1,
      issueDate: '2026-09-21',
      issueTime: '12:00:00',
      currency: 'PEN',
      supplier: {
        ruc: '20123456789',
        razonSocial: 'Empresa Test',
        direccion: 'Av. Test 123',
        ubigeo: '150101',
      },
      customer: {
        tipoDocumento: '6',
        numeroDocumento: '20123456789',
        denominacion: 'Cliente Test',
      },
      lines: [],
      taxes: { igv: 0, total: 0 },
      totals: { gravada: 0, exonerada: 0, inafecta: 0, descuento: 0, igv: 0, total: 0 },
    });

    expect(result.ok).toBe(false);
    expect(result.estado).toBe('PENDIENTE');
    expect(result.mensaje.toLowerCase()).toContain('fase 1');
  });
});

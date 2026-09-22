import { FiscalProviderService } from './fiscal-provider.service';

describe('FiscalProviderService', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('usa el provider seguro por defecto cuando no está habilitado', async () => {
    delete process.env.SUNAT_DIRECT_ENABLED;
    delete process.env.SUNAT_FISCAL_PROVIDER;

    const service = new FiscalProviderService();
    const result = await service.preparar({
      documentType: '01',
      series: 'FFF1',
      number: 1,
      issueDate: '2026-09-21',
      issueTime: '12:00:00',
      currency: 'PEN',
      supplier: {
        ruc: '20123456789',
        razonSocial: 'Empresa Test',
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
    expect(result.codigo).toBe('FASE1_PENDING');
  });

  it('selecciona el provider directo solo cuando está activado explícitamente', async () => {
    process.env.SUNAT_FISCAL_PROVIDER = 'sunat-direct';
    process.env.SUNAT_DIRECT_ENABLED = 'true';
    process.env.SUNAT_PASSWORD = 'MODDATOS';
    process.env.SUNAT_USERNAME_SUFFIX = 'MODDATOS';
    process.env.SUNAT_BILL_ENDPOINT = 'https://e-beta.sunat.gob.pe/ol-ti-itcpfegem-beta/billService';

    const service = new FiscalProviderService();
    const result = await service.preparar({
      documentType: '01',
      series: 'FFF1',
      number: 1,
      issueDate: '2026-09-21',
      issueTime: '12:00:00',
      currency: 'PEN',
      supplier: {
        ruc: '20123456789',
        razonSocial: 'Empresa Test',
      },
      customer: {
        tipoDocumento: '6',
        numeroDocumento: '20123456789',
        denominacion: 'Cliente Test',
      },
      lines: [{
        descripcion: 'Caja',
        cantidad: 1,
        unidad: 'NIU',
        precioUnitario: 10,
        descuento: 0,
        afectacionIgv: '10',
      }],
      taxes: { igv: 1.8, total: 10 },
      totals: { gravada: 10, exonerada: 0, inafecta: 0, descuento: 0, igv: 1.8, total: 11.8 },
    });

    expect(result.payload).toBeDefined();
    expect(result.payload?.provider).toBe('sunat-direct');
    expect(['ERROR_TRANSPORTE', 'ACEPTADO', 'ACEPTADO_CON_OBSERVACIONES', 'RECHAZADO']).toContain(result.estado);
  });
});

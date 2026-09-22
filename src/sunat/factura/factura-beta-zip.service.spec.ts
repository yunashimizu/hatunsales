import { FacturaBetaZipService } from './factura-beta-zip.service';

describe('FacturaBetaZipService', () => {
  it('genera el zip con el nombre y el contenido del XML firmado', () => {
    const service = new FacturaBetaZipService();
    const xml = `<?xml version="1.0" encoding="UTF-8"?><Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"></Invoice>`;

    const result = service.generarZip(xml, '20123456789', '01', 'F001', 1);

    expect(result.ok).toBe(true);
    expect(result.fileName).toBe('20123456789-01-F001-00000001.zip');
    expect(result.zipBase64.length).toBeGreaterThan(10);
    expect(result.mensaje).toContain('ZIP SUNAT');
  });
});

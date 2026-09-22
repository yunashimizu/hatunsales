import { CdrParserService } from './cdr-parser.service';

describe('CdrParserService', () => {
  it('parsea una ApplicationResponse aceptada con observaciones o aceptada', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ApplicationResponse xmlns="urn:oasis:names:specification:ubl:schema:xsd:ApplicationResponse-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
  <cbc:ResponseCode>0</cbc:ResponseCode>
  <cbc:Description>La Factura numero F001-1 ha sido aceptada.</cbc:Description>
</ApplicationResponse>`;

    const result = new CdrParserService().parse(xml);

    expect(result.codigo).toBe('0');
    expect(result.descripcion).toContain('aceptada');
    expect(result.estado).toBe('ACEPTADO');
  });

  it('detecta una respuesta rechazada o sin estructura', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?><ApplicationResponse><ResponseCode>4000</ResponseCode><Description>Rechazado</Description></ApplicationResponse>`;

    const result = new CdrParserService().parse(xml);

    expect(result.estado).toBe('RECHAZADO');
    expect(result.codigo).toBe('4000');
  });
});

import { armarCorreoComprobante, DatosPlantillaCorreo, PREFIJO_BETA } from './plantilla-comprobante-correo';

const base: DatosPlantillaCorreo = {
  tipoNombre: 'Boleta electrónica',
  numeroFormateado: 'B001-00000012',
  fechaEmision: '2026-10-27',
  total: 118,
  simboloMoneda: 'S/',
  monedaNombre: 'Soles',
  receptor: 'Ana <Pérez>',
  emisor: { razon_social: 'HATUNSALES S.A.C.', ruc: '20610206337', direccion: 'Av. Lima 123', telefono: null, email: 'ventas@hatunsales.pe' },
  esBeta: false,
};

describe('armarCorreoComprobante', () => {
  it('arma asunto, texto y html con número, fecha, total y emisor', () => {
    const c = armarCorreoComprobante(base);
    expect(c.asunto).toBe('Boleta electrónica B001-00000012 – HATUNSALES S.A.C.');
    expect(c.texto).toContain('B001-00000012');
    expect(c.texto).toContain('Total: S/ 118.00 (Soles)');
    expect(c.texto).toContain('RUC 20610206337');
    expect(c.texto).not.toContain(PREFIJO_BETA);
    expect(c.html).toContain('2026-10-27');
  });

  it('escapa el HTML de los datos del cliente', () => {
    const c = armarCorreoComprobante(base);
    expect(c.html).toContain('Ana &lt;Pérez&gt;');
    expect(c.html).not.toContain('<Pérez>');
  });

  it('en BETA antepone el aviso de prueba al asunto y lo repite en el cuerpo', () => {
    const c = armarCorreoComprobante({ ...base, esBeta: true, receptor: null });
    expect(c.asunto.startsWith(`${PREFIJO_BETA} – Boleta electrónica`)).toBe(true);
    expect(c.texto.startsWith(PREFIJO_BETA)).toBe(true);
    expect(c.html).toContain(PREFIJO_BETA);
    expect(c.texto).toContain('Estimado(a) cliente:');
  });
});

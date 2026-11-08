import { armarCorreoAlerta } from './plantilla-alerta-fiscal';

const ALERTA = { tipo: 'envios_revision', titulo: '2 comprobante(s) requieren revisión', detalle: 'Abra <Envíos> & reintente', ruta: '/dashboard/facturacion-sunat' };

describe('armarCorreoAlerta', () => {
  it('con una sola alerta el asunto es el título y el enlace va al panel', () => {
    const correo = armarCorreoAlerta([ALERTA], 'https://panel.hatunsales.pe');
    expect(correo.asunto).toBe('HATUNSALES: 2 comprobante(s) requieren revisión');
    expect(correo.html).toContain('href="https://panel.hatunsales.pe/dashboard/facturacion-sunat"');
    expect(correo.texto).toContain('https://panel.hatunsales.pe/dashboard/facturacion-sunat');
  });

  it('escapa el HTML del detalle', () => {
    const correo = armarCorreoAlerta([ALERTA], '');
    expect(correo.html).toContain('Abra &lt;Envíos&gt; &amp; reintente');
    expect(correo.html).not.toContain('<Envíos>');
  });

  it('sin URL del panel no pone enlaces; con varias alertas cuenta cuántas son', () => {
    const correo = armarCorreoAlerta([ALERTA, { ...ALERTA, tipo: 'x' }], '');
    expect(correo.asunto).toContain('2 avisos');
    expect(correo.html).not.toContain('<a ');
    expect(correo.texto).not.toContain('http');
  });
});

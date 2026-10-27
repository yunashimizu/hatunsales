import { correoValido, fabricarEnviador, leerConfigCorreo } from './correo.config';
import { EnviadorArchivo } from './enviador-archivo';
import { EnviadorBrevo } from './enviador-brevo';
import { EnviadorResend } from './enviador-resend';

describe('correo.config', () => {
  it('sin CORREO_PROVEEDOR (o con uno desconocido) usa «archivo»', () => {
    expect(leerConfigCorreo({}).proveedor).toBe('archivo');
    expect(leerConfigCorreo({ CORREO_PROVEEDOR: 'smtp' }).proveedor).toBe('archivo');
    expect(fabricarEnviador({})).toBeInstanceOf(EnviadorArchivo);
  });

  it('lee las variables CORREO_* y elige Brevo o Resend sin distinguir mayúsculas', () => {
    const env = {
      CORREO_PROVEEDOR: ' Brevo ',
      CORREO_API_KEY: 'k',
      CORREO_REMITENTE: 'a@b.pe',
      CORREO_REMITENTE_NOMBRE: 'Mi tienda',
      CORREO_DESTINO_PRUEBAS: 'qa@b.pe',
    };
    expect(leerConfigCorreo(env)).toEqual({ proveedor: 'brevo', apiKey: 'k', remitente: 'a@b.pe', remitenteNombre: 'Mi tienda', destinoPruebas: 'qa@b.pe' });
    expect(fabricarEnviador(env)).toBeInstanceOf(EnviadorBrevo);
    expect(fabricarEnviador({ ...env, CORREO_PROVEEDOR: 'resend' })).toBeInstanceOf(EnviadorResend);
    expect(leerConfigCorreo({ CORREO_API_KEY: '  ' }).apiKey).toBeNull();
  });

  it('correoValido acepta formatos razonables y rechaza el resto', () => {
    expect(correoValido('cliente@ejemplo.pe')).toBe(true);
    expect(correoValido(' cliente@ejemplo.pe ')).toBe(true);
    for (const malo of ['', 'sin-arroba', 'a@b', 'a b@c.pe', 'a@@c.pe', null, undefined, 12, `${'a'.repeat(250)}@b.pe`]) {
      expect(correoValido(malo)).toBe(false);
    }
  });
});

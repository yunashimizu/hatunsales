import axios from 'axios';
import { EnviadorBrevo, URL_BREVO } from './enviador-brevo';
import { ErrorEnvioCorreo, MensajeCorreo } from './enviador-correo.contrato';

jest.mock('axios');
const post = axios.post as unknown as jest.Mock;

const mensaje: MensajeCorreo = {
  para: 'cliente@ejemplo.pe',
  asunto: 'Boleta electrónica B001-00000012',
  html: '<p>hola</p>',
  texto: 'hola',
  adjuntos: [{ nombre: 'B001-00000012.pdf', mime: 'application/pdf', contenido: Buffer.from('PDF') }],
};
const config = { apiKey: 'clave-falsa', remitente: 'ventas@hatunsales.pe', remitenteNombre: 'HATUNSALES S.A.C.' };

describe('EnviadorBrevo', () => {
  beforeEach(() => post.mockReset());

  it('envía a la API de Brevo con api-key y adjuntos en base64, y devuelve el messageId', async () => {
    post.mockResolvedValue({ data: { messageId: '<abc@brevo>' } });
    const resultado = await new EnviadorBrevo(config).enviar(mensaje);
    expect(resultado).toEqual({ id_mensaje: '<abc@brevo>' });
    const [url, cuerpo, opciones] = post.mock.calls[0];
    expect(url).toBe(URL_BREVO);
    expect(opciones.headers['api-key']).toBe('clave-falsa');
    expect(opciones.timeout).toBe(15_000);
    expect(cuerpo.sender).toEqual({ name: 'HATUNSALES S.A.C.', email: 'ventas@hatunsales.pe' });
    expect(cuerpo.to).toEqual([{ email: 'cliente@ejemplo.pe' }]);
    expect(cuerpo.attachment).toEqual([{ name: 'B001-00000012.pdf', content: Buffer.from('PDF').toString('base64') }]);
  });

  it('clasifica los fallos: 5xx, 429 y red son reintentables; 400 no', async () => {
    const enviador = new EnviadorBrevo(config);
    post.mockRejectedValueOnce({ response: { status: 503, data: { message: 'caído' } } });
    await expect(enviador.enviar(mensaje)).rejects.toMatchObject({ reintentable: true, estadoHttp: 503 });
    post.mockRejectedValueOnce({ response: { status: 429, data: {} } });
    await expect(enviador.enviar(mensaje)).rejects.toMatchObject({ reintentable: true });
    post.mockRejectedValueOnce({ message: 'ECONNRESET' });
    await expect(enviador.enviar(mensaje)).rejects.toMatchObject({ reintentable: true, estadoHttp: null });
    post.mockRejectedValueOnce({ response: { status: 400, data: { message: 'destinatario inválido' } } });
    const error = await enviador.enviar(mensaje).catch((e) => e);
    expect(error).toBeInstanceOf(ErrorEnvioCorreo);
    expect(error.reintentable).toBe(false);
    expect(error.message).toContain('destinatario inválido');
  });

  it('sin clave o remitente falla sin llamar a la red', async () => {
    await expect(new EnviadorBrevo({ ...config, apiKey: null }).enviar(mensaje)).rejects.toBeInstanceOf(ErrorEnvioCorreo);
    expect(post).not.toHaveBeenCalled();
  });
});

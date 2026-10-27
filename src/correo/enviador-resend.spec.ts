import axios from 'axios';
import { ErrorEnvioCorreo, MensajeCorreo } from './enviador-correo.contrato';
import { EnviadorResend, URL_RESEND } from './enviador-resend';

jest.mock('axios');
const post = axios.post as unknown as jest.Mock;

const mensaje: MensajeCorreo = {
  para: 'cliente@ejemplo.pe',
  asunto: 'Factura electrónica F001-00000003',
  html: '<p>hola</p>',
  texto: 'hola',
  adjuntos: [{ nombre: 'F001-00000003.xml', mime: 'application/xml', contenido: Buffer.from('<xml/>') }],
};
const config = { apiKey: 're_falsa', remitente: 'ventas@hatunsales.pe', remitenteNombre: null };

describe('EnviadorResend', () => {
  beforeEach(() => post.mockReset());

  it('envía con Bearer, remitente «Nombre <correo>» y adjuntos en base64', async () => {
    post.mockResolvedValue({ data: { id: 'res-1' } });
    const resultado = await new EnviadorResend(config).enviar({ ...mensaje, remitenteNombre: 'HATUNSALES S.A.C.' });
    expect(resultado).toEqual({ id_mensaje: 'res-1' });
    const [url, cuerpo, opciones] = post.mock.calls[0];
    expect(url).toBe(URL_RESEND);
    expect(opciones.headers.Authorization).toBe('Bearer re_falsa');
    expect(cuerpo.from).toBe('HATUNSALES S.A.C. <ventas@hatunsales.pe>');
    expect(cuerpo.to).toEqual(['cliente@ejemplo.pe']);
    expect(cuerpo.attachments).toEqual([{ filename: 'F001-00000003.xml', content: Buffer.from('<xml/>').toString('base64') }]);
  });

  it('clasifica los fallos como reintentables o definitivos', async () => {
    const enviador = new EnviadorResend(config);
    post.mockRejectedValueOnce({ response: { status: 500, data: 'error interno' } });
    await expect(enviador.enviar(mensaje)).rejects.toMatchObject({ reintentable: true });
    post.mockRejectedValueOnce({ response: { status: 422, data: { message: 'from inválido' } } });
    await expect(enviador.enviar(mensaje)).rejects.toMatchObject({ reintentable: false, estadoHttp: 422 });
  });

  it('sin configuración falla sin llamar a la red', async () => {
    await expect(new EnviadorResend({ ...config, remitente: null }).enviar(mensaje)).rejects.toBeInstanceOf(ErrorEnvioCorreo);
    expect(post).not.toHaveBeenCalled();
  });
});

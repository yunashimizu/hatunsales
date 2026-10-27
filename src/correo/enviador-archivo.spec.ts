import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { EnviadorArchivo } from './enviador-archivo';

describe('EnviadorArchivo', () => {
  let carpeta: string;
  beforeEach(() => {
    carpeta = mkdtempSync(join(tmpdir(), 'correos-spec-'));
  });
  afterEach(() => rmSync(carpeta, { recursive: true, force: true }));

  it('escribe el correo como JSON con los adjuntos en base64 y devuelve su id', async () => {
    const enviador = new EnviadorArchivo(join(carpeta, 'sub'));
    const resultado = await enviador.enviar({
      para: 'cliente@ejemplo.pe',
      asunto: 'Asunto',
      html: '<p>x</p>',
      texto: 'x',
      adjuntos: [{ nombre: 'a.pdf', mime: 'application/pdf', contenido: Buffer.from('PDF') }],
    });
    const archivos = readdirSync(join(carpeta, 'sub'));
    expect(archivos).toHaveLength(1);
    expect(archivos[0]).toContain(resultado.id_mensaje as string);
    const json = JSON.parse(readFileSync(join(carpeta, 'sub', archivos[0]), 'utf8'));
    expect(json).toMatchObject({ para: 'cliente@ejemplo.pe', asunto: 'Asunto' });
    expect(json.adjuntos[0]).toEqual({ nombre: 'a.pdf', mime: 'application/pdf', bytes: 3, base64: Buffer.from('PDF').toString('base64') });
  });
});

import { randomUUID } from 'crypto';
import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { EnviadorCorreo, ErrorEnvioCorreo, MensajeCorreo, ResultadoEnvioCorreo } from './enviador-correo.contrato';

/** Desarrollo y pruebas: en lugar de enviar, escribe cada correo como JSON (adjuntos en base64) en .tmp/correos/. */
export class EnviadorArchivo extends EnviadorCorreo {
  readonly nombre = 'archivo';

  constructor(private readonly carpeta: string = join(process.cwd(), '.tmp', 'correos')) {
    super();
  }

  async enviar(mensaje: MensajeCorreo): Promise<ResultadoEnvioCorreo> {
    const id = randomUUID();
    const fecha = new Date().toISOString().replace(/[:.]/g, '-');
    const archivo = join(this.carpeta, `${fecha}-${id}.json`);
    try {
      await mkdir(this.carpeta, { recursive: true });
      await writeFile(
        archivo,
        JSON.stringify(
          {
            id,
            para: mensaje.para,
            asunto: mensaje.asunto,
            remitente_nombre: mensaje.remitenteNombre ?? null,
            texto: mensaje.texto,
            html: mensaje.html,
            adjuntos: mensaje.adjuntos.map((a) => ({
              nombre: a.nombre,
              mime: a.mime,
              bytes: a.contenido.length,
              base64: a.contenido.toString('base64'),
            })),
          },
          null,
          2,
        ),
        'utf8',
      );
    } catch (error) {
      throw new ErrorEnvioCorreo(`No se pudo escribir el correo en ${this.carpeta}: ${error instanceof Error ? error.message : String(error)}`, true);
    }
    return { id_mensaje: id };
  }
}

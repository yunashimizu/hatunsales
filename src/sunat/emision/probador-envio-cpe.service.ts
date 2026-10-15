import { Injectable } from '@nestjs/common';
import { FiscalConfigService } from '../config/fiscal-config.service';
import { FiscalEsquemaService } from '../config/fiscal-esquema.service';
import type {
  ContextoPruebaEnvio,
  PasoPruebaFiscal,
  ProbadorEnvioFiscal,
} from '../config/fiscal-tokens';
import { RelojFiscal } from '../config/reloj-fiscal';
import { crearDocumentoPruebaBeta } from './documento-prueba-beta';
import { SunatEmisionBetaService } from './sunat-emision-beta.service';

@Injectable()
export class ProbadorEnvioCpeService implements ProbadorEnvioFiscal {
  constructor(
    private readonly emision: SunatEmisionBetaService,
    private readonly config: FiscalConfigService,
    private readonly esquema: FiscalEsquemaService,
    private readonly reloj: RelojFiscal,
  ) {}

  async probar(ctx: ContextoPruebaEnvio): Promise<PasoPruebaFiscal[]> {
    if (ctx.ambiente !== 'beta')
      return [
        {
          paso: 'envio',
          ok: null,
          detalle:
            'El envío de prueba está habilitado exclusivamente en SUNAT BETA.',
        },
      ];
    await this.esquema.exigir('emision', 'secretos');
    const numero = await this.config.siguienteCorrelativoBeta();
    const documento = crearDocumentoPruebaBeta(
      ctx.emisor,
      ctx.tipoCpe ?? '01',
      numero,
      this.reloj.ahora(),
    );
    const resultado = await this.emision.emitir(
      documento,
      ctx.material,
      ctx.idUsuario,
    );
    return [
      {
        paso: 'xml',
        ok: true,
        detalle: `UBL 2.1 ${resultado.nombre_base}.xml generado por el backend con importes calculados localmente.`,
      },
      {
        paso: 'firma_xml',
        ok: true,
        detalle:
          'XML firmado con el certificado cargado; digest y firma verificados localmente.',
      },
      {
        paso: 'zip',
        ok: true,
        detalle: `${resultado.nombre_base}.zip guardado en la base de datos antes del envío.`,
      },
      {
        paso: 'respuesta_sunat',
        ok: resultado.aceptado,
        codigo: resultado.codigo,
        detalle: resultado.mensaje,
        observaciones: resultado.observaciones,
        envio_id: resultado.id_envio,
        archivos: resultado.archivos,
      },
    ];
  }
}

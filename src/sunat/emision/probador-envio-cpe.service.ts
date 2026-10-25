import { Injectable } from '@nestjs/common';
import { FiscalEsquemaService } from '../config/fiscal-esquema.service';
import type {
  ContextoPruebaEnvio,
  PasoPruebaFiscal,
  ProbadorEnvioFiscal,
} from '../config/fiscal-tokens';
import { RelojFiscal } from '../config/reloj-fiscal';
import { crearDocumentoPruebaBeta } from './documento-prueba-beta';
import { SERIES_BETA } from './emision.tipos';
import { EnvioFiscalRepository } from './envio-fiscal.repository';
import { SunatEmisionService } from './sunat-emision.service';

/**
 * «Probar conexión» de factura/boleta en SUNAT BETA: envía un documento de prueba (S/ 1.18) sin crear
 * ventas ni comprobantes, con un número posterior a todo lo ya enviado en esa serie de BETA. En
 * PRODUCCIÓN no envía nada (cada comprobante sería real).
 */
@Injectable()
export class ProbadorEnvioCpeService implements ProbadorEnvioFiscal {
  constructor(
    private readonly emision: SunatEmisionService,
    private readonly envios: EnvioFiscalRepository,
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
    const tipo = ctx.tipoCpe ?? '01';
    const numero = await this.envios.siguienteNumeroPruebaBeta(tipo === '01' ? SERIES_BETA.factura : SERIES_BETA.boleta);
    const documento = crearDocumentoPruebaBeta(
      ctx.emisor,
      tipo,
      numero,
      this.reloj.ahora(),
    );
    const resultado = await this.emision.emitirPrueba(
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
        codigo: resultado.codigo ?? undefined,
        detalle: resultado.mensaje ?? '',
        observaciones: resultado.observaciones,
        envio_id: resultado.id_envio,
        archivos: resultado.archivos,
      },
    ];
  }
}

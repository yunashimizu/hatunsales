import { Injectable } from '@nestjs/common';
import { FiscalEsquemaService } from '../config/fiscal-esquema.service';
import type {
  ContextoPruebaEnvio,
  PasoPruebaFiscal,
  ProbadorEnvioFiscal,
} from '../config/fiscal-tokens';
import type { ReferenciaNotaCpe } from '../nucleo/documento-fiscal.types';
import { RelojFiscal } from '../config/reloj-fiscal';
import { crearDocumentoPruebaBeta, serieBetaDe } from './documento-prueba-beta';
import { EnvioFiscalRepository } from './envio-fiscal.repository';
import { SunatEmisionService } from './sunat-emision.service';

/**
 * «Probar conexión» de factura, boleta y notas de crédito/débito en SUNAT BETA: envía un documento de prueba (S/ 1.18) sin crear
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
    const esNota = tipo === '07' || tipo === '08';
    const pasosBase: PasoPruebaFiscal[] = [];
    let referencia: ReferenciaNotaCpe | undefined;
    if (esNota) {
      // SUNAT BETA exige que la nota modifique un comprobante real: se envía antes una factura de prueba.
      const numeroBase = await this.envios.siguienteNumeroPruebaBeta(serieBetaDe('01'));
      const base = crearDocumentoPruebaBeta(ctx.emisor, '01', numeroBase, this.reloj.ahora());
      const enviado = await this.emision.emitirPrueba(base, ctx.material, ctx.idUsuario);
      pasosBase.push({
        paso: 'comprobante_base',
        ok: enviado.aceptado,
        codigo: enviado.codigo ?? undefined,
        detalle: `Factura ${base.serie}-${numeroBase} enviada como comprobante a modificar: ${enviado.mensaje ?? ''}`,
        envio_id: enviado.id_envio,
      });
      if (!enviado.aceptado) return pasosBase;
      referencia = {
        tipoDoc: '01',
        serie: base.serie,
        numero: numeroBase,
        motivo: '01',
        sustento: tipo === '07' ? 'PRUEBA BETA - ANULACION DE LA OPERACION' : 'PRUEBA BETA - INTERESES POR MORA',
      };
    }
    const serie = serieBetaDe(tipo, referencia ? referencia.tipoDoc === '01' : true);
    const numero = await this.envios.siguienteNumeroPruebaBeta(serie);
    const documento = crearDocumentoPruebaBeta(
      ctx.emisor,
      tipo,
      numero,
      this.reloj.ahora(),
      referencia,
    );
    const resultado = await this.emision.emitirPrueba(
      documento,
      ctx.material,
      ctx.idUsuario,
    );
    return [
      ...pasosBase,
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

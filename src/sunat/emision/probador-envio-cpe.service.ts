import { Injectable } from '@nestjs/common';
import { FiscalEsquemaService } from '../config/fiscal-esquema.service';
import type {
  ContextoPruebaEnvio,
  PasoPruebaFiscal,
  ProbadorEnvioFiscal,
} from '../config/fiscal-tokens';
import type { ReferenciaNotaCpe, TipoCpe } from '../nucleo/documento-fiscal.types';
import { RelojFiscal } from '../config/reloj-fiscal';
import type { ResultadoEmision } from './emision.contrato';
import { crearDocumentoPruebaBeta, serieBetaDe } from './documento-prueba-beta';
import { EnvioFiscalRepository } from './envio-fiscal.repository';
import { SunatEmisionService } from './sunat-emision.service';

type TipoPrueba = '01' | '03' | '07' | '08';

const NOMBRE_DOCUMENTO: Readonly<Record<TipoPrueba, string>> = {
  '01': 'Factura',
  '03': 'Boleta',
  '07': 'Nota de crédito',
  '08': 'Nota de débito',
};

/** El documento de prueba ya enviado (o el motivo por el que no se pudo). */
interface EnvioPrueba {
  tipo: TipoPrueba;
  serie: string;
  numero: number;
  resultado: ResultadoEmision;
}

function tiempoDe(resultado: ResultadoEmision): number | undefined {
  return typeof resultado.tiempo_sunat_ms === 'number' ? resultado.tiempo_sunat_ms : undefined;
}

/**
 * «Probar conexión» de factura, boleta y notas de crédito/débito en SUNAT BETA: envía un documento de prueba (S/ 1.18) sin crear
 * ventas ni comprobantes, con un número posterior a todo lo ya enviado en esa serie de BETA. En
 * PRODUCCIÓN no envía nada (cada comprobante sería real).
 *
 * Con `tipoCpe = 'todos'` manda los cuatro EN SERIE (la numeración de prueba no admite concurrencia y BETA
 * responde 401 a los envíos pegados): factura → boleta → nota de crédito y nota de débito que modifican esa
 * misma factura. 4 sendBill en total; si la factura no es aceptada, las notas no se intentan.
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
    if (tipo === 'todos') return this.probarTodos(ctx);

    const esNota = tipo === '07' || tipo === '08';
    const pasosBase: PasoPruebaFiscal[] = [];
    let referencia: ReferenciaNotaCpe | undefined;
    if (esNota) {
      // SUNAT BETA exige que la nota modifique un comprobante real: se envía antes una factura de prueba.
      const base = await this.enviarPrueba(ctx, '01');
      pasosBase.push(this.pasoBase(base));
      if (!base.resultado.aceptado) return pasosBase;
      referencia = this.referenciaA(base, tipo);
    }
    const enviado = await this.enviarPrueba(ctx, tipo, referencia);
    const resultado = enviado.resultado;
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
      this.pasoRespuesta(enviado, 'respuesta_sunat', resultado.mensaje ?? ''),
    ];
  }

  /**
   * Los cuatro documentos en serie; las notas modifican la factura recién aceptada. Un error de un documento
   * (p. ej. no se pudo guardar la respuesta) queda en su paso y no borra lo que ya respondió SUNAT.
   */
  private async probarTodos(ctx: ContextoPruebaEnvio): Promise<PasoPruebaFiscal[]> {
    const pasos: PasoPruebaFiscal[] = [];
    const factura = await this.intentar(ctx, '01', pasos);
    await this.intentar(ctx, '03', pasos);

    if (!factura?.resultado.aceptado) {
      const cual = factura ? `la factura ${factura.serie}-${factura.numero}` : 'la factura';
      const motivo = `No se intentó: SUNAT no aceptó ${cual} que la nota debía modificar.`;
      for (const tipo of ['07', '08'] as const) {
        pasos.push({ paso: 'respuesta_sunat', ok: null, documento: tipo, detalle: `${NOMBRE_DOCUMENTO[tipo]}: ${motivo}` });
      }
      return pasos;
    }
    for (const tipo of ['07', '08'] as const) {
      await this.intentar(ctx, tipo, pasos, factura);
    }
    return pasos;
  }

  private async intentar(
    ctx: ContextoPruebaEnvio,
    tipo: TipoPrueba,
    pasos: PasoPruebaFiscal[],
    modifica?: EnvioPrueba,
  ): Promise<EnvioPrueba | null> {
    try {
      const enviado = await this.enviarPrueba(ctx, tipo, modifica ? this.referenciaA(modifica, tipo) : undefined);
      pasos.push(this.pasoRespuesta(enviado, 'respuesta_sunat', this.detalleDe(enviado, modifica)));
      return enviado;
    } catch (error) {
      const e = error as { message?: string; codigo?: string; getResponse?: () => unknown };
      const cuerpo = e?.getResponse?.() as { id_envio?: number } | undefined;
      pasos.push({
        paso: 'respuesta_sunat',
        ok: false,
        documento: tipo,
        detalle: `${NOMBRE_DOCUMENTO[tipo]}: ${String(e?.message ?? error).slice(0, 500)}`,
        ...(e?.codigo ? { codigo: e.codigo } : {}),
        ...(cuerpo?.id_envio ? { envio_id: cuerpo.id_envio } : {}),
      });
      return null;
    }
  }

  /** Numera después de lo ya enviado en la serie BETA, arma, firma, registra y envía (espera hasta 30 s). */
  private async enviarPrueba(ctx: ContextoPruebaEnvio, tipo: TipoPrueba, referencia?: ReferenciaNotaCpe): Promise<EnvioPrueba> {
    const serie = serieBetaDe(tipo as TipoCpe, referencia ? referencia.tipoDoc === '01' : true);
    const numero = await this.envios.siguienteNumeroPruebaBeta(serie);
    const documento = crearDocumentoPruebaBeta(ctx.emisor, tipo as TipoCpe, numero, this.reloj.ahora(), referencia);
    const resultado = await this.emision.emitirPrueba(documento, ctx.material, ctx.idUsuario);
    return { tipo, serie: documento.serie, numero, resultado };
  }

  private referenciaA(base: EnvioPrueba, tipo: TipoPrueba): ReferenciaNotaCpe {
    return {
      tipoDoc: '01',
      serie: base.serie,
      numero: base.numero,
      motivo: '01',
      sustento: tipo === '07' ? 'PRUEBA BETA - ANULACION DE LA OPERACION' : 'PRUEBA BETA - INTERESES POR MORA',
    };
  }

  private pasoBase(base: EnvioPrueba): PasoPruebaFiscal {
    return this.pasoRespuesta(
      base,
      'comprobante_base',
      `Factura ${base.serie}-${base.numero} enviada como comprobante a modificar: ${base.resultado.mensaje ?? ''}`,
    );
  }

  private pasoRespuesta(enviado: EnvioPrueba, paso: string, detalle: string): PasoPruebaFiscal {
    const { resultado } = enviado;
    const tiempo = tiempoDe(resultado);
    return {
      paso,
      ok: resultado.aceptado,
      codigo: resultado.codigo ?? undefined,
      detalle,
      observaciones: resultado.observaciones,
      envio_id: resultado.id_envio,
      archivos: resultado.archivos,
      documento: enviado.tipo,
      ...(tiempo === undefined ? {} : { tiempo_ms: tiempo }),
    };
  }

  private detalleDe(enviado: EnvioPrueba, modifica?: EnvioPrueba): string {
    const sobre = modifica ? ` (modifica ${modifica.serie}-${modifica.numero})` : '';
    return `${NOMBRE_DOCUMENTO[enviado.tipo]} ${enviado.serie}-${enviado.numero}${sobre}: ${enviado.resultado.mensaje ?? ''}`.trim();
  }
}

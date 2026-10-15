import { FiscalConfigError } from '../config/fiscal-errores';
import type { AmbienteFiscal } from '../config/fiscal-config.tipos';
import { fechaEnLima } from '../config/reloj-fiscal';
import { advertenciasCertificado } from './certificado-info';
import { BITS_MINIMOS_SUNAT, InfoCertificado } from './certificado-digital.util';

/**
 * Política de aceptación de un certificado al subirlo (función pura):
 * lo que impide usarlo es un error de dominio; lo demás, una advertencia.
 */

export interface ContextoValidacionCertificado {
  ambiente: AmbienteFiscal;
  rucEmisor: string;
  ahora: Date;
  /** Solo en beta: aceptar aunque el RUC no coincida. */
  forzar: boolean;
}

/** Tolerancia para relojes desfasados: un certificado emitido «mañana» (UTC) se acepta. */
const TOLERANCIA_INICIO_MS = 24 * 3600 * 1000;

function fechaCorta(fecha: Date): string {
  const [anio, mes, dia] = fechaEnLima(fecha).split('-');
  return `${dia}/${mes}/${anio}`;
}

export function validarCertificadoParaUso(info: InfoCertificado, ctx: ContextoValidacionCertificado): { advertencias: string[] } {
  if (info.bitsClave < BITS_MINIMOS_SUNAT) {
    throw new FiscalConfigError(
      'FISCAL_CERT_CLAVE_DEBIL',
      `La clave del certificado tiene ${info.bitsClave} bits; SUNAT exige al menos ${BITS_MINIMOS_SUNAT} (se recomienda 2048).`,
    );
  }
  if (info.vigenteHasta.getTime() <= ctx.ahora.getTime()) {
    throw new FiscalConfigError(
      'FISCAL_CERT_VENCIDO',
      `El certificado está vencido (venció el ${fechaCorta(info.vigenteHasta)}). Renuévelo y súbalo de nuevo.`,
      { vigente_hasta: info.vigenteHasta.toISOString() },
    );
  }
  if (info.vigenteDesde.getTime() > ctx.ahora.getTime() + TOLERANCIA_INICIO_MS) {
    throw new FiscalConfigError(
      'FISCAL_CERT_VENCIDO',
      `El certificado todavía no es válido: rige desde el ${fechaCorta(info.vigenteDesde)}.`,
      { vigente_desde: info.vigenteDesde.toISOString() },
    );
  }
  if (ctx.ambiente === 'produccion' && info.autofirmado) {
    throw new FiscalConfigError(
      'FISCAL_CERT_AUTOFIRMADO',
      'Un certificado autofirmado solo sirve para pruebas en BETA. Para producción suba el CDT de SUNAT o uno comprado.',
    );
  }

  const advertencias: string[] = [];
  if (info.ruc && info.ruc !== ctx.rucEmisor) {
    if (!(ctx.ambiente === 'beta' && ctx.forzar)) {
      throw new FiscalConfigError(
        'FISCAL_CERT_RUC_NO_COINCIDE',
        `El certificado pertenece al RUC ${info.ruc} y la empresa configurada es ${ctx.rucEmisor}.`,
        { ruc_certificado: info.ruc, ruc_emisor: ctx.rucEmisor },
      );
    }
  }
  if (info.permiteFirma === false) {
    advertencias.push('El certificado no declara el uso «firma digital»: SUNAT podría rechazar la firma.');
  }
  advertencias.push(
    ...advertenciasCertificado(
      {
        ruc: info.ruc,
        vigenteHasta: info.vigenteHasta,
        bitsClave: info.bitsClave,
        autofirmado: info.autofirmado,
        ambiente: ctx.ambiente,
      },
      { ahora: ctx.ahora, rucEmisor: ctx.rucEmisor },
    ),
  );
  return { advertencias };
}

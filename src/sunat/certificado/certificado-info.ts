import { DIAS_AVISO_VENCIMIENTO } from '../config/checklist-activacion';
import type { AmbienteFiscal } from '../config/fiscal-config.tipos';
import { diasHasta } from '../config/reloj-fiscal';
import type { MetadatosCertificadoFiscal } from './certificado-fiscal.repository';
import { BITS_MINIMOS_SUNAT, BITS_RECOMENDADOS } from './certificado-digital.util';

/** Forma pública de un certificado en el API (respuesta de GET/POST /fiscal/certificado). Sin secretos. */
export interface CertificadoInfoVista {
  id: number;
  ambiente: AmbienteFiscal;
  titular: string | null;
  ruc: string | null;
  numero_serie: string | null;
  emisor: string | null;
  vigente_desde: string;
  vigente_hasta: string;
  dias_para_vencer: number;
  vencido: boolean;
  /** Vence en 30 días o menos. */
  por_vencer: boolean;
  autofirmado: boolean;
  bits_clave: number | null;
  huella_sha256: string;
  nombre_archivo: string | null;
  subido_en: string;
  advertencias: string[];
}

export interface ContextoInfoCertificado {
  ahora: Date;
  /** RUC del emisor configurado, para avisar si no coincide. */
  rucEmisor: string;
}

/** Avisos (no bloqueantes) sobre un certificado ya validado. */
export function advertenciasCertificado(
  datos: { ruc: string | null; vigenteHasta: Date; bitsClave: number | null; autofirmado: boolean; ambiente: AmbienteFiscal },
  contexto: ContextoInfoCertificado,
): string[] {
  const lista: string[] = [];
  const dias = diasHasta(datos.vigenteHasta, contexto.ahora);
  if (dias < 0) {
    lista.push('El certificado está vencido: suba uno vigente.');
  } else if (dias <= DIAS_AVISO_VENCIMIENTO) {
    lista.push(`El certificado vence en ${dias} día(s): renuévelo (CDT en SOL) y súbalo antes de esa fecha.`);
  }
  if (datos.bitsClave !== null && datos.bitsClave >= BITS_MINIMOS_SUNAT && datos.bitsClave < BITS_RECOMENDADOS) {
    lista.push(`La clave es de ${datos.bitsClave} bits: SUNAT la acepta, pero se recomienda 2048 bits al renovarlo.`);
  }
  if (datos.ruc === null) {
    lista.push(`No se encontró el RUC dentro del certificado: verifique que pertenezca a ${contexto.rucEmisor}.`);
  } else if (datos.ruc !== contexto.rucEmisor) {
    lista.push(`El certificado es del RUC ${datos.ruc} y el emisor configurado es ${contexto.rucEmisor}.`);
  }
  if (datos.autofirmado) {
    lista.push(
      datos.ambiente === 'produccion'
        ? 'Es un certificado autofirmado: SUNAT producción lo rechazará.'
        : 'Certificado autofirmado de pruebas: sirve solo para SUNAT BETA.',
    );
  }
  return lista;
}

export function describirCertificado(meta: MetadatosCertificadoFiscal, contexto: ContextoInfoCertificado): CertificadoInfoVista {
  const dias = diasHasta(meta.vigente_hasta, contexto.ahora);
  return {
    id: meta.id_certificado,
    ambiente: meta.ambiente,
    titular: meta.titular,
    ruc: meta.ruc,
    numero_serie: meta.numero_serie,
    emisor: meta.emisor,
    vigente_desde: meta.vigente_desde.toISOString(),
    vigente_hasta: meta.vigente_hasta.toISOString(),
    dias_para_vencer: dias,
    vencido: meta.vigente_hasta.getTime() <= contexto.ahora.getTime(),
    por_vencer: dias >= 0 && dias <= DIAS_AVISO_VENCIMIENTO,
    autofirmado: meta.autofirmado,
    bits_clave: meta.bits_clave,
    huella_sha256: meta.huella_sha256,
    nombre_archivo: meta.nombre_archivo,
    subido_en: meta.subido_en.toISOString(),
    advertencias: advertenciasCertificado(
      {
        ruc: meta.ruc,
        vigenteHasta: meta.vigente_hasta,
        bitsClave: meta.bits_clave,
        autofirmado: meta.autofirmado,
        ambiente: meta.ambiente,
      },
      contexto,
    ),
  };
}

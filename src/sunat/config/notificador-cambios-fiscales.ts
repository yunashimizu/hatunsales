import { Injectable, Logger } from '@nestjs/common';

export type TipoCambioFiscal = 'config' | 'certificado' | 'credenciales';
export type OyenteCambioFiscal = (tipo: TipoCambioFiscal) => void;

/**
 * Observador en proceso: quien guarda algo fiscal avisa y cada caché se limpia
 * sola, sin que el que escribe conozca a los que leen. Otras fases (emisión,
 * documentos) pueden suscribirse igual.
 */
@Injectable()
export class NotificadorCambiosFiscales {
  private readonly logger = new Logger(NotificadorCambiosFiscales.name);
  private readonly oyentes = new Set<OyenteCambioFiscal>();

  /** Devuelve la función para desuscribirse. */
  suscribir(oyente: OyenteCambioFiscal): () => void {
    this.oyentes.add(oyente);
    return () => this.oyentes.delete(oyente);
  }

  notificar(tipo: TipoCambioFiscal): void {
    for (const oyente of this.oyentes) {
      try {
        oyente(tipo);
      } catch (error: any) {
        this.logger.warn(`Un oyente de cambios fiscales falló (${tipo}): ${error?.message ?? error}`);
      }
    }
  }
}

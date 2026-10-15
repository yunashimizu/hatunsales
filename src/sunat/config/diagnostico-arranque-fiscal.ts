import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { esProduccion } from '../../config/runtime.config';
import { tokenApiPeruDeEntorno } from '../../config/sunat.config';
import { CifradoFiscalService } from '../seguridad/cifrado-fiscal.service';
import { RepositorioConfigFiscal } from './config-fiscal.repository';

/**
 * Avisos de arranque (solo log, nunca detienen la API): llave de cifrado
 * fiscal y token de la consulta DNI/RUC. Nunca imprime valores.
 */
@Injectable()
export class DiagnosticoArranqueFiscal implements OnApplicationBootstrap {
  private readonly logger = new Logger('ConfiguracionFiscal');

  constructor(
    private readonly cifrado: CifradoFiscalService,
    private readonly repositorio: RepositorioConfigFiscal,
  ) {}

  onApplicationBootstrap(): void {
    this.revisarLlave();
    void this.revisarTokenConsulta().catch(() => undefined);
  }

  private revisarLlave(): void {
    const diagnostico = this.cifrado.diagnostico();
    if (!diagnostico.disponible) {
      const mensaje = `${diagnostico.problema ?? 'FISCAL_SECRET_KEY no es válida.'} SUNAT directo deshabilitado; Nubefact sigue operando.`;
      if (esProduccion() || diagnostico.configurada) this.logger.warn(mensaje);
      else this.logger.log(mensaje);
      return;
    }
    if (diagnostico.problema) this.logger.warn(diagnostico.problema);
    if (diagnostico.rotacion) {
      this.logger.log('FISCAL_SECRET_KEY_ANTERIOR presente: los secretos se re-cifran con la llave nueva al usarse.');
    }
  }

  private async revisarTokenConsulta(): Promise<void> {
    if (tokenApiPeruDeEntorno()) return;
    const valores = await this.repositorio.leer(['sunat_token']);
    if (valores.sunat_token) return;
    const mensaje =
      'No hay token de ApiPeru (SUNAT_TOKEN en Railway ni sunat_token en configuraciones): '
      + 'el autocompletado de DNI/RUC del POS responderá 503 y habrá que escribir los datos a mano.';
    if (esProduccion()) this.logger.warn(mensaje);
    else this.logger.log(mensaje);
  }
}

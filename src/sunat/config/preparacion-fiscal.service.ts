import { Injectable } from '@nestjs/common';
import { CertificadoFiscalService } from '../certificado/certificado-fiscal.service';
import { CifradoFiscalService } from '../seguridad/cifrado-fiscal.service';
import { CredencialesGreService } from '../seguridad/credenciales-gre.service';
import { CredencialesSolService } from '../seguridad/credenciales-sol.service';
import { evaluarPreparacion, HechosPreparacion, ResultadoPreparacion } from './checklist-activacion';
import { FiscalConfigService } from './fiscal-config.service';
import { SnapshotConfigFiscal } from './fiscal-config.tipos';
import { FiscalEsquemaService } from './fiscal-esquema.service';
import { EvaluadorPreparacionFiscal } from './fiscal-tokens';
import { RelojFiscal } from './reloj-fiscal';

/** Supuestos de un cambio que todavía no se guardó (se evalúa el estado futuro). */
export interface SupuestosPreparacion {
  /** En el mismo PUT viene una clave SOL nueva (ya validada). */
  claveSolNueva?: boolean;
}

/**
 * Reúne los hechos (esquema, llave, certificados, secretos) y evalúa el
 * checklist por tipo de documento con la función pura `evaluarPreparacion`.
 */
@Injectable()
export class PreparacionFiscalService implements EvaluadorPreparacionFiscal {
  constructor(
    private readonly config: FiscalConfigService,
    private readonly esquema: FiscalEsquemaService,
    private readonly cifrado: CifradoFiscalService,
    private readonly certificados: CertificadoFiscalService,
    private readonly credencialesSol: CredencialesSolService,
    private readonly credencialesGre: CredencialesGreService,
    private readonly reloj: RelojFiscal,
  ) {}

  async listoParaProduccion(): Promise<ResultadoPreparacion> {
    return this.evaluar(await this.config.snapshot());
  }

  async evaluar(snapshot: SnapshotConfigFiscal, supuestos: SupuestosPreparacion = {}): Promise<ResultadoPreparacion> {
    const hechos = await this.hechos(snapshot);
    if (supuestos.claveSolNueva && hechos.cifradoDisponible && hechos.esquema.listo) hechos.claveSol = 'ok';
    return evaluarPreparacion(hechos);
  }

  async hechos(snapshot: SnapshotConfigFiscal): Promise<HechosPreparacion> {
    const [esquema, certificados, claveSol, credencialesGre] = await Promise.all([
      this.esquema.estado(),
      this.certificados.estadoParaChecklist(),
      this.credencialesSol.diagnosticoClave(),
      this.credencialesGre.diagnostico(),
    ]);
    return {
      snapshot,
      ahora: this.reloj.ahora(),
      esquema: { listo: esquema.listo, faltantes: esquema.faltantes },
      cifradoDisponible: this.cifrado.disponible(),
      certificados,
      claveSol,
      credencialesGre,
    };
  }
}

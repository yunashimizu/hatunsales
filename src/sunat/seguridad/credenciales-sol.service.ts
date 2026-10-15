import { Injectable } from '@nestjs/common';
import { FiscalConfigError } from '../config/fiscal-errores';
import { FiscalConfigService } from '../config/fiscal-config.service';
import { AmbienteFiscal } from '../config/fiscal-config.tipos';
import { EjecutorSql } from '../config/transacciones-fiscales';
import { CredencialesSol } from '../certificado/material-firma';
import { BovedaSecretosFiscales, DiagnosticoSecreto, SECRETOS_FISCALES } from './boveda-secretos.service';

export interface EstadoCredencialesSol {
  usuario: string | null;
  tiene_clave: boolean;
  actualizado_en: string | null;
}

/** Resultado de intentar leer la clave SOL guardada (sin exponerla). */
export type DiagnosticoClaveSol = DiagnosticoSecreto;

const USUARIO_SOL = /^[A-Z0-9]{8}$/;

/**
 * Normaliza el usuario secundario SOL: mayúsculas y, si lo escribieron con el
 * RUC delante (20610206337USUARIO1), se quita el RUC.
 */
export function normalizarUsuarioSol(usuario: string, ruc: string): string {
  let limpio = (usuario ?? '').trim().toUpperCase().replace(/\s+/g, '');
  if (limpio.length === 19 && ruc && limpio.startsWith(ruc)) limpio = limpio.slice(ruc.length);
  if (!USUARIO_SOL.test(limpio)) {
    throw new FiscalConfigError(
      'FISCAL_CONFIG_INVALIDA',
      'El usuario secundario SOL debe tener 8 caracteres (letras y números), sin el RUC.',
    );
  }
  return limpio;
}

/** SOL acepta de 8 a 12 caracteres; se rechazan espacios en los extremos y caracteres de control. */
export function validarClaveSol(clave: string): string {
  const valor = clave ?? '';
  if (valor.length < 8 || valor.length > 12 || valor !== valor.trim() || /[\u0000-\u001f\u007f]/.test(valor)) {
    throw new FiscalConfigError(
      'FISCAL_CONFIG_INVALIDA',
      'La clave SOL debe tener entre 8 y 12 caracteres, sin espacios al inicio o al final.',
    );
  }
  return valor;
}

/**
 * Credenciales del usuario secundario SOL para los servicios de SUNAT
 * (SOAP de comprobantes y token OAuth de la GRE).
 * El usuario va en claro en `configuraciones` (fiscal_sol_usuario); la clave,
 * cifrada en `fiscal_secretos` y nunca sale del servidor.
 */
@Injectable()
export class CredencialesSolService {
  static readonly SECRETO_CLAVE_SOL = SECRETOS_FISCALES.claveSol;
  static readonly CONTEXTO_CLAVE_SOL = BovedaSecretosFiscales.contexto(SECRETOS_FISCALES.claveSol);
  /** Credenciales públicas de SUNAT BETA (orientacion.sunat.gob.pe/12-pautas-servicio-beta). */
  static readonly SUFIJO_BETA = 'MODDATOS';
  static readonly CLAVE_BETA = 'MODDATOS';

  constructor(
    private readonly boveda: BovedaSecretosFiscales,
    private readonly config: FiscalConfigService,
  ) {}

  /** En BETA siempre RUC+MODDATOS / MODDATOS; en producción las del panel o un error claro. */
  async obtener(ambiente: AmbienteFiscal): Promise<CredencialesSol> {
    const snapshot = await this.config.snapshot();
    const ruc = snapshot.emisor.ruc;
    if (ambiente === 'beta') {
      return { usuario: `${ruc}${CredencialesSolService.SUFIJO_BETA}`, clave: CredencialesSolService.CLAVE_BETA };
    }

    if (!snapshot.solUsuario) {
      throw new FiscalConfigError('FISCAL_CREDENCIALES_SOL_FALTAN', 'Registre el usuario secundario SOL en el panel de facturación.');
    }
    const clave = await this.boveda.leer(CredencialesSolService.SECRETO_CLAVE_SOL);
    if (!clave) {
      throw new FiscalConfigError('FISCAL_CREDENCIALES_SOL_FALTAN', 'Registre la clave del usuario secundario SOL en el panel de facturación.');
    }
    return { usuario: `${ruc}${snapshot.solUsuario}`, clave };
  }

  async estado(): Promise<EstadoCredencialesSol> {
    const [snapshot, metadatos] = await Promise.all([
      this.config.snapshot(),
      this.boveda.metadatos(CredencialesSolService.SECRETO_CLAVE_SOL),
    ]);
    return {
      usuario: snapshot.solUsuario,
      tiene_clave: !!metadatos,
      actualizado_en: metadatos ? metadatos.actualizado_en.toISOString() : null,
    };
  }

  /** Para el checklist: ¿hay clave y se puede descifrar con la llave actual? */
  diagnosticoClave(): Promise<DiagnosticoClaveSol> {
    return this.boveda.diagnostico(CredencialesSolService.SECRETO_CLAVE_SOL);
  }

  /** Cifra y guarda la clave (dentro de la transacción del llamador). */
  async guardarClave(clave: string, idUsuario: number | null, ejecutor: EjecutorSql): Promise<void> {
    await this.boveda.guardar(CredencialesSolService.SECRETO_CLAVE_SOL, validarClaveSol(clave), idUsuario, ejecutor);
  }

  eliminarClave(ejecutor: EjecutorSql): Promise<boolean> {
    return this.boveda.eliminar(CredencialesSolService.SECRETO_CLAVE_SOL, ejecutor);
  }

  invalidar(): void {
    this.boveda.invalidar(CredencialesSolService.SECRETO_CLAVE_SOL);
  }
}

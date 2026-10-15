import { Injectable } from '@nestjs/common';
import { FiscalConfigError } from '../config/fiscal-errores';
import { AmbienteFiscal } from '../config/fiscal-config.tipos';
import { EjecutorSql } from '../config/transacciones-fiscales';
import { BovedaSecretosFiscales, DiagnosticoSecreto, SECRETOS_FISCALES } from './boveda-secretos.service';
import { CredencialesSolService } from './credenciales-sol.service';

export interface EstadoCredencialesGre {
  tiene_credenciales: boolean;
  /** Primeros y últimos 4 caracteres del client_id (para reconocerlo sin exponerlo). */
  client_id_mascara: string | null;
  actualizado_en: string | null;
}

/** Todo lo que pide el token OAuth2 de api-seguridad.sunat.gob.pe para la GRE (grant_type=password). */
export interface CredencialesGre {
  clientId: string;
  clientSecret: string;
  /** RUC + usuario secundario SOL (en BETA: RUC + MODDATOS). */
  usuarioSol: string;
  claveSol: string;
}

const CLIENT_ID = /^[A-Za-z0-9-]{8,100}$/;

export function validarClientIdGre(valor: string): string {
  const limpio = (valor ?? '').trim();
  if (!CLIENT_ID.test(limpio)) {
    throw new FiscalConfigError(
      'FISCAL_CONFIG_INVALIDA',
      'El client_id tiene solo letras, números y guiones, tal como lo muestra SOL en «Credenciales de API SUNAT».',
    );
  }
  return limpio;
}

export function validarClientSecretGre(valor: string): string {
  const texto = valor ?? '';
  if (texto.length < 8 || texto.length > 200 || /\s/.test(texto) || /[\u0000-\u001f\u007f]/.test(texto)) {
    throw new FiscalConfigError('FISCAL_CONFIG_INVALIDA', 'El client_secret debe tener entre 8 y 200 caracteres, sin espacios.');
  }
  return texto;
}

export function enmascararIdentificador(valor: string | null): string | null {
  if (!valor) return null;
  return valor.length <= 8 ? `${valor.slice(0, 2)}…` : `${valor.slice(0, 4)}…${valor.slice(-4)}`;
}

/** El peor diagnóstico manda (en este orden). */
const PRIORIDAD: readonly DiagnosticoSecreto[] = ['sin_esquema', 'falta', 'sin_cifrado', 'ilegible', 'ok'];

export function combinarDiagnosticos(...diagnosticos: DiagnosticoSecreto[]): DiagnosticoSecreto {
  return PRIORIDAD.find((d) => diagnosticos.includes(d)) ?? 'ok';
}

/**
 * Credenciales de la API REST de SUNAT para la GRE: client_id y client_secret
 * que el dueño genera en SOL › «Credenciales de API SUNAT». Ambos van cifrados
 * igual que la clave SOL (fiscal_secretos) y nunca se devuelven en claro.
 */
@Injectable()
export class CredencialesGreService {
  constructor(
    private readonly boveda: BovedaSecretosFiscales,
    private readonly credencialesSol: CredencialesSolService,
  ) {}

  /**
   * Para el módulo GRE. En BETA el usuario SOL es RUC+MODDATOS; las
   * credenciales API siempre son las registradas en el panel.
   */
  async obtener(ambiente: AmbienteFiscal): Promise<CredencialesGre> {
    const [clientId, clientSecret] = await Promise.all([
      this.boveda.leer(SECRETOS_FISCALES.greClientId),
      this.boveda.leer(SECRETOS_FISCALES.greClientSecret),
    ]);
    if (!clientId || !clientSecret) {
      throw new FiscalConfigError(
        'FISCAL_CREDENCIALES_GRE_FALTAN',
        'Registre el client_id y el client_secret de «Credenciales de API SUNAT» en el panel de facturación.',
      );
    }
    const sol = await this.credencialesSol.obtener(ambiente);
    return { clientId, clientSecret, usuarioSol: sol.usuario, claveSol: sol.clave };
  }

  async estado(): Promise<EstadoCredencialesGre> {
    const [id, secreto] = await Promise.all([
      this.boveda.metadatos(SECRETOS_FISCALES.greClientId),
      this.boveda.metadatos(SECRETOS_FISCALES.greClientSecret),
    ]);
    const tiene = !!id && !!secreto;
    let mascara: string | null = null;
    if (id) {
      try {
        mascara = enmascararIdentificador(await this.boveda.leer(SECRETOS_FISCALES.greClientId));
      } catch {
        mascara = null; // sin llave o ilegible: el checklist lo informa
      }
    }
    const fechas = [id?.actualizado_en, secreto?.actualizado_en].filter((f): f is Date => !!f);
    const ultima = fechas.length ? new Date(Math.max(...fechas.map((f) => f.getTime()))) : null;
    return { tiene_credenciales: tiene, client_id_mascara: mascara, actualizado_en: ultima ? ultima.toISOString() : null };
  }

  async diagnostico(): Promise<DiagnosticoSecreto> {
    const [id, secreto] = await Promise.all([
      this.boveda.diagnostico(SECRETOS_FISCALES.greClientId),
      this.boveda.diagnostico(SECRETOS_FISCALES.greClientSecret),
    ]);
    return combinarDiagnosticos(id, secreto);
  }

  /** Cifra y guarda ambas (en la transacción del llamador). Devuelve la máscara del client_id. */
  async guardar(clientId: string, clientSecret: string, idUsuario: number | null, ejecutor: EjecutorSql): Promise<string | null> {
    const id = validarClientIdGre(clientId);
    const secreto = validarClientSecretGre(clientSecret);
    await this.boveda.guardar(SECRETOS_FISCALES.greClientId, id, idUsuario, ejecutor);
    await this.boveda.guardar(SECRETOS_FISCALES.greClientSecret, secreto, idUsuario, ejecutor);
    return enmascararIdentificador(id);
  }

  async eliminar(ejecutor: EjecutorSql): Promise<boolean> {
    const id = await this.boveda.eliminar(SECRETOS_FISCALES.greClientId, ejecutor);
    const secreto = await this.boveda.eliminar(SECRETOS_FISCALES.greClientSecret, ejecutor);
    return id || secreto;
  }
}

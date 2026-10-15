import { Injectable, Logger } from '@nestjs/common';
import { CacheTtl } from '../config/cache-ttl';
import { FiscalConfigError } from '../config/fiscal-errores';
import { FiscalEsquemaService } from '../config/fiscal-esquema.service';
import { NotificadorCambiosFiscales } from '../config/notificador-cambios-fiscales';
import { RelojFiscal } from '../config/reloj-fiscal';
import { EjecutorSql } from '../config/transacciones-fiscales';
import { CifradoFiscalService } from './cifrado-fiscal.service';
import { RepositorioSecretosFiscales } from './secretos-fiscales.repository';

/**
 * Resultado de revisar un secreto guardado sin exponerlo:
 * - ok: existe y abre con la llave actual (o la anterior);
 * - falta: no se ha registrado;
 * - ilegible: existe pero no abre (cambió FISCAL_SECRET_KEY);
 * - sin_cifrado: no hay FISCAL_SECRET_KEY válida para abrirlo;
 * - sin_esquema: falta la tabla fiscal_secretos (sql/fase9 pendiente).
 */
export type DiagnosticoSecreto = 'ok' | 'falta' | 'ilegible' | 'sin_cifrado' | 'sin_esquema';

export interface MetadatosSecreto {
  actualizado_en: Date;
  actualizado_por: number | null;
}

/** Nombres de los secretos que guarda la bóveda (clave primaria de fiscal_secretos). */
export const SECRETOS_FISCALES = {
  claveSol: 'sol_clave',
  greClientId: 'gre_client_id',
  greClientSecret: 'gre_client_secret',
} as const;
export type NombreSecretoFiscal = (typeof SECRETOS_FISCALES)[keyof typeof SECRETOS_FISCALES];

/**
 * Bóveda de secretos de texto (clave SOL, client_id y client_secret de la API
 * de SUNAT para la GRE) cifrados con AES-256-GCM en `fiscal_secretos`.
 *
 * - El contexto de cifrado (AAD) es `secreto:<nombre>`: un valor cifrado solo
 *   abre en su propia fila.
 * - Lo descifrado vive solo en memoria (30 s) y se invalida al guardar.
 * - Si algo se abrió con FISCAL_SECRET_KEY_ANTERIOR se vuelve a cifrar con la
 *   actual en segundo plano (rotación sin intervención del dueño).
 * Nunca registra valores en el log.
 */
@Injectable()
export class BovedaSecretosFiscales {
  static readonly TTL_MS = 30_000;

  private readonly logger = new Logger(BovedaSecretosFiscales.name);
  private readonly cache: CacheTtl<string | null>;

  constructor(
    private readonly secretos: RepositorioSecretosFiscales,
    private readonly cifrado: CifradoFiscalService,
    private readonly esquema: FiscalEsquemaService,
    reloj: RelojFiscal,
    notificador: NotificadorCambiosFiscales,
  ) {
    this.cache = new CacheTtl<string | null>(BovedaSecretosFiscales.TTL_MS, () => reloj.ms());
    notificador.suscribir((tipo) => {
      if (tipo === 'credenciales') this.invalidar();
    });
  }

  static contexto(nombre: NombreSecretoFiscal): string {
    return `secreto:${nombre}`;
  }

  /** Valor en claro o null si no existe. Lanza FISCAL_SECRETO_ILEGIBLE / FISCAL_CLAVE_MAESTRA_NO_CONFIGURADA. */
  async leer(nombre: NombreSecretoFiscal): Promise<string | null> {
    await this.esquema.exigir('secretos');
    return this.cache.obtener(nombre, () => this.leerDeBd(nombre));
  }

  /** Solo fecha y autor (nunca el valor). null si no existe o falta la tabla. */
  async metadatos(nombre: NombreSecretoFiscal): Promise<MetadatosSecreto | null> {
    if (!(await this.esquema.tiene('secretos'))) return null;
    return this.secretos.metadatos(nombre);
  }

  async diagnostico(nombre: NombreSecretoFiscal): Promise<DiagnosticoSecreto> {
    if (!(await this.esquema.tiene('secretos'))) return 'sin_esquema';
    if (!this.cifrado.disponible()) {
      return (await this.secretos.metadatos(nombre)) ? 'sin_cifrado' : 'falta';
    }
    try {
      return (await this.leer(nombre)) ? 'ok' : 'falta';
    } catch (error) {
      if (FiscalConfigError.es(error, 'FISCAL_SECRETO_ILEGIBLE')) return 'ilegible';
      throw error;
    }
  }

  /** Cifra y guarda (dentro de la transacción del llamador). El llamador avisa al notificador tras el commit. */
  async guardar(nombre: NombreSecretoFiscal, valor: string, idUsuario: number | null, ejecutor: EjecutorSql): Promise<void> {
    await this.esquema.exigir('secretos');
    this.cifrado.exigirDisponible();
    const cifrado = this.cifrado.cifrarTexto(valor, BovedaSecretosFiscales.contexto(nombre));
    await this.secretos.guardar(nombre, cifrado, idUsuario, ejecutor);
    this.invalidar(nombre);
  }

  /** true si había algo que borrar. */
  async eliminar(nombre: NombreSecretoFiscal, ejecutor: EjecutorSql): Promise<boolean> {
    await this.esquema.exigir('secretos');
    const borrado = await this.secretos.eliminar(nombre, ejecutor);
    this.invalidar(nombre);
    return borrado;
  }

  invalidar(nombre?: NombreSecretoFiscal): void {
    this.cache.invalidar(nombre);
  }

  private async leerDeBd(nombre: NombreSecretoFiscal): Promise<string | null> {
    const guardado = await this.secretos.leer(nombre);
    if (!guardado?.valor_cifrado?.length) return null;

    const { plano, conLlaveAnterior } = this.cifrado.descifrarDetallado(
      guardado.valor_cifrado,
      BovedaSecretosFiscales.contexto(nombre),
    );
    const valor = plano.toString('utf8');
    plano.fill(0);
    if (conLlaveAnterior) void this.recifrar(nombre, valor, guardado.actualizado_por);
    return valor;
  }

  /** Rotación de FISCAL_SECRET_KEY: lo que abrió con la llave anterior se vuelve a cifrar con la actual. */
  private async recifrar(nombre: NombreSecretoFiscal, valor: string, idUsuario: number | null): Promise<void> {
    try {
      const cifrado = this.cifrado.cifrarTexto(valor, BovedaSecretosFiscales.contexto(nombre));
      await this.secretos.guardar(nombre, cifrado, idUsuario);
      this.logger.log(`Secreto fiscal «${nombre}» re-cifrado con la FISCAL_SECRET_KEY actual.`);
    } catch (error: any) {
      this.logger.warn(`No se pudo re-cifrar el secreto fiscal «${nombre}»: ${error?.message ?? error}`);
    }
  }
}

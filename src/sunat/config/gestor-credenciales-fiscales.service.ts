import { Injectable } from '@nestjs/common';
import { ACCIONES_AUDITORIA_FISCAL, FiscalAuditoriaRepository } from '../auditoria/fiscal-auditoria.repository';
import { CifradoFiscalService } from '../seguridad/cifrado-fiscal.service';
import { CredencialesGreService, EstadoCredencialesGre } from '../seguridad/credenciales-gre.service';
import { CredencialesSolService, EstadoCredencialesSol } from '../seguridad/credenciales-sol.service';
import { RepositorioConfigFiscal } from './config-fiscal.repository';
import { FiscalConfigError } from './fiscal-errores';
import { FiscalConfigService } from './fiscal-config.service';
import { ActorFiscal, CLAVES_CONFIG_FISCAL } from './fiscal-config.tipos';
import { FiscalEsquemaService } from './fiscal-esquema.service';
import { CANDADO_CONFIG_FISCAL, GestorConfigFiscalService } from './gestor-config-fiscal.service';
import { NotificadorCambiosFiscales } from './notificador-cambios-fiscales';
import { EjecutorSql, TransaccionesFiscales } from './transacciones-fiscales';

/**
 * Alta, reemplazo y baja de credenciales (clave SOL y credenciales API de la
 * GRE). Nunca devuelve valores en claro: solo `tiene_clave` / `tiene_credenciales`.
 */
@Injectable()
export class GestorCredencialesFiscalesService {
  constructor(
    private readonly config: FiscalConfigService,
    private readonly gestorConfig: GestorConfigFiscalService,
    private readonly repositorio: RepositorioConfigFiscal,
    private readonly credencialesSol: CredencialesSolService,
    private readonly credencialesGre: CredencialesGreService,
    private readonly transacciones: TransaccionesFiscales,
    private readonly auditoria: FiscalAuditoriaRepository,
    private readonly esquema: FiscalEsquemaService,
    private readonly cifrado: CifradoFiscalService,
    private readonly notificador: NotificadorCambiosFiscales,
  ) {}

  /** Mismo flujo (validaciones, reglas y auditoría) que `sol` en el PUT de configuración. */
  async guardarSol(usuario: string, clave: string | undefined, actor: ActorFiscal): Promise<EstadoCredencialesSol> {
    await this.gestorConfig.guardar({ sol: { usuario, clave } }, actor);
    return this.credencialesSol.estado();
  }

  async eliminarSol(actor: ActorFiscal): Promise<EstadoCredencialesSol> {
    await this.esquema.exigir('secretos');
    await this.transacciones.ejecutar(async (tx) => {
      await this.exigirSinUso(tx, (s) => s.proveedor === 'sunat_directo' || s.gre.activa, 'las credenciales SOL');
      const borrada = await this.credencialesSol.eliminarClave(tx);
      await this.repositorio.guardar({ [CLAVES_CONFIG_FISCAL.solUsuario]: '' }, tx);
      await this.auditoria.registrar(
        {
          accion: ACCIONES_AUDITORIA_FISCAL.CRED_SOL_ELIMINADA,
          id_usuario: actor.id_usuario,
          entidad: 'fiscal_secretos',
          id_entidad: CredencialesSolService.SECRETO_CLAVE_SOL,
          detalle: { usuario: actor.nombre, habia_clave: borrada },
          ip: actor.ip,
        },
        tx,
      );
    });
    this.notificador.notificar('credenciales');
    this.notificador.notificar('config');
    return this.credencialesSol.estado();
  }

  async guardarGre(clientId: string, clientSecret: string, actor: ActorFiscal): Promise<EstadoCredencialesGre> {
    await this.esquema.exigir('secretos');
    this.cifrado.exigirDisponible();
    await this.transacciones.ejecutar(async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [CANDADO_CONFIG_FISCAL]);
      const mascara = await this.credencialesGre.guardar(clientId, clientSecret, actor.id_usuario, tx);
      await this.auditoria.registrar(
        {
          accion: ACCIONES_AUDITORIA_FISCAL.CRED_GRE_ACTUALIZADA,
          id_usuario: actor.id_usuario,
          entidad: 'fiscal_secretos',
          id_entidad: 'gre',
          detalle: { usuario: actor.nombre, client_id_mascara: mascara },
          ip: actor.ip,
        },
        tx,
      );
    });
    this.notificador.notificar('credenciales');
    return this.credencialesGre.estado();
  }

  async eliminarGre(actor: ActorFiscal): Promise<EstadoCredencialesGre> {
    await this.esquema.exigir('secretos');
    await this.transacciones.ejecutar(async (tx) => {
      await this.exigirSinUso(tx, (s) => s.gre.activa, 'las credenciales API de la GRE');
      const borradas = await this.credencialesGre.eliminar(tx);
      await this.auditoria.registrar(
        {
          accion: ACCIONES_AUDITORIA_FISCAL.CRED_GRE_ELIMINADA,
          id_usuario: actor.id_usuario,
          entidad: 'fiscal_secretos',
          id_entidad: 'gre',
          detalle: { usuario: actor.nombre, habia_credenciales: borradas },
          ip: actor.ip,
        },
        tx,
      );
    });
    this.notificador.notificar('credenciales');
    return this.credencialesGre.estado();
  }

  /** Toma el candado de la configuración y rechaza si lo que se borra está en uso. */
  private async exigirSinUso(
    tx: EjecutorSql,
    enUso: (snapshot: Awaited<ReturnType<FiscalConfigService['snapshotFresco']>>) => boolean,
    que: string,
  ): Promise<void> {
    await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [CANDADO_CONFIG_FISCAL]);
    const snapshot = await this.config.snapshotFresco();
    if (enUso(snapshot)) {
      throw new FiscalConfigError(
        'FISCAL_CREDENCIALES_EN_USO',
        `No se pueden eliminar ${que} mientras SUNAT directo o la GRE electrónica están activos. Primero vuelva a Nubefact o desactive la GRE; para cambiarlas, simplemente regístrelas de nuevo.`,
      );
    }
  }
}

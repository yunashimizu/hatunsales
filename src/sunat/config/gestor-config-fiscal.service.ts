import { Injectable } from '@nestjs/common';
import { tokenApiPeruDeEntorno } from '../../config/sunat.config';
import { FiscalAuditoriaRepository } from '../auditoria/fiscal-auditoria.repository';
import { CertificadoFiscalService } from '../certificado/certificado-fiscal.service';
import { CifradoFiscalService } from '../seguridad/cifrado-fiscal.service';
import { CredencialesGreService } from '../seguridad/credenciales-gre.service';
import { CredencialesSolService } from '../seguridad/credenciales-sol.service';
import { RepositorioConfigFiscal } from './config-fiscal.repository';
import type { ActualizarConfigFiscalDto } from './fiscal-config.dto';
import { FiscalConfigService } from './fiscal-config.service';
import { ActorFiscal, ConfirmacionNoOse } from './fiscal-config.tipos';
import { FiscalEsquemaService } from './fiscal-esquema.service';
import { GestorConfigFiscal, ResultadoGuardadoFiscal } from './fiscal-tokens';
import { InterruptorEmisionFiscal } from './interruptor-emision.service';
import { NotificadorCambiosFiscales } from './notificador-cambios-fiscales';
import { PreparacionFiscalService } from './preparacion-fiscal.service';
import {
  cambiosDesdeDto,
  eventosAuditoria,
  hayCambios,
  paresParaGuardar,
  proyectarSnapshot,
  validarCambios,
  validarTransicion,
} from './reglas-transicion-fiscal';
import { RelojFiscal } from './reloj-fiscal';
import { TransaccionesFiscales } from './transacciones-fiscales';
import { ConfiguracionFiscalVista, construirVistaConfigFiscal } from './vista-config-fiscal';

/** Clave existente en producción con el token de ApiPeru (consulta DNI/RUC). */
const CLAVE_TOKEN_CONSULTA = 'sunat_token';

/** Candado global de la configuración fiscal (también lo toma la eliminación del certificado). */
export const CANDADO_CONFIG_FISCAL = 'fiscal:config';

/**
 * Lectura completa y guardado de la configuración fiscal (GET/PUT /fiscal/configuracion).
 *
 * El guardado es una transacción corta con orden de bloqueo fijo:
 * candado 'fiscal:config' → claves de configuraciones (orden alfabético) →
 * fiscal_secretos → interruptor de emisión → fiscal_auditoria. Antes de escribir
 * se evalúa el checklist del estado FUTURO y se aplican las reglas de transición (§5.3).
 * Guardar credenciales SOL reanuda la emisión de producción si estaba detenida (D5.4).
 */
@Injectable()
export class GestorConfigFiscalService implements GestorConfigFiscal {
  constructor(
    private readonly config: FiscalConfigService,
    private readonly repositorio: RepositorioConfigFiscal,
    private readonly transacciones: TransaccionesFiscales,
    private readonly preparacion: PreparacionFiscalService,
    private readonly certificados: CertificadoFiscalService,
    private readonly credencialesSol: CredencialesSolService,
    private readonly credencialesGre: CredencialesGreService,
    private readonly auditoria: FiscalAuditoriaRepository,
    private readonly esquema: FiscalEsquemaService,
    private readonly cifrado: CifradoFiscalService,
    private readonly notificador: NotificadorCambiosFiscales,
    private readonly reloj: RelojFiscal,
    private readonly interruptor: InterruptorEmisionFiscal,
  ) {}

  async obtenerConfigCompleta(): Promise<ConfiguracionFiscalVista> {
    const snapshot = await this.config.snapshot();
    const [proveedorEfectivo, sol, gre, certificados, preparacion, esquema, consulta] = await Promise.all([
      this.config.proveedorActivo(),
      this.credencialesSol.estado(),
      this.credencialesGre.estado(),
      this.certificados.infoTodos(),
      this.preparacion.evaluar(snapshot),
      this.esquema.estado(),
      this.consultaDocumentosConfigurada(),
    ]);
    const diagnostico = this.cifrado.diagnostico();
    return construirVistaConfigFiscal({
      snapshot,
      proveedorEfectivo,
      sol,
      gre,
      certificados,
      preparacion,
      esquema,
      scriptEsquema: FiscalEsquemaService.SCRIPT,
      cifrado: { disponible: diagnostico.disponible, problema: diagnostico.problema },
      consultaDocumentosConfigurada: consulta,
    });
  }

  async guardar(dto: ActualizarConfigFiscalDto, actor: ActorFiscal): Promise<ResultadoGuardadoFiscal> {
    const pideClaveSol = !!dto?.sol?.clave;
    if (pideClaveSol) {
      // Antes de abrir la transacción: sin llave o sin tabla no hay dónde guardar la clave.
      await this.esquema.exigir('secretos');
      this.cifrado.exigirDisponible();
    }

    const resultado = await this.transacciones.ejecutar(async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [CANDADO_CONFIG_FISCAL]);
      const actual = await this.config.snapshotFresco();
      const cambios = cambiosDesdeDto(dto ?? {}, actual.emisor.ruc);
      if (!hayCambios(cambios)) return { advertencias: [] as string[], credenciales: false, cambio: false };

      const confirmacion: ConfirmacionNoOse | null = cambios.confirmoNoOse
        ? { id_usuario: actor.id_usuario, nombre: actor.nombre, fecha: this.reloj.ahora().toISOString(), ip: actor.ip }
        : null;
      const futuro = proyectarSnapshot(actual, cambios, confirmacion);
      validarCambios(cambios, futuro);

      const preparacion = await this.preparacion.evaluar(futuro, { claveSolNueva: cambios.solClave !== undefined });
      const { advertencias } = validarTransicion(actual, futuro, preparacion);

      await this.repositorio.guardar(paresParaGuardar(cambios, futuro), tx);
      if (cambios.solClave !== undefined) {
        await this.credencialesSol.guardarClave(cambios.solClave, actor.id_usuario, tx);
      }
      if (cambios.solUsuario !== undefined || cambios.solClave !== undefined) {
        // Las credenciales SOL son de producción: corregirlas reanuda esa emisión si SUNAT las había rechazado.
        if (await this.interruptor.limpiar('produccion', 'credenciales SOL actualizadas', actor, tx)) {
          advertencias.push('La emisión de producción estaba detenida por un rechazo de las credenciales SOL y se reanudó con las nuevas.');
        }
      }
      for (const evento of eventosAuditoria(actual, futuro, cambios)) {
        await this.auditoria.registrar(
          { ...evento, id_usuario: actor.id_usuario, ip: actor.ip, detalle: { ...(evento.detalle ?? {}), usuario: actor.nombre } },
          tx,
        );
      }
      return {
        advertencias,
        credenciales: cambios.solUsuario !== undefined || cambios.solClave !== undefined,
        cambio: true,
      };
    });

    if (resultado.cambio) this.notificador.notificar('config');
    if (resultado.credenciales) this.notificador.notificar('credenciales');
    const vista = await this.obtenerConfigCompleta();
    return { ...vista, advertencias: resultado.advertencias };
  }

  /** El token de ApiPeru está en variables o en configuraciones (sin leerlo hacia afuera). */
  private async consultaDocumentosConfigurada(): Promise<boolean> {
    if (tokenApiPeruDeEntorno()) return true;
    try {
      const valores = await this.repositorio.leer([CLAVE_TOKEN_CONSULTA]);
      return !!valores[CLAVE_TOKEN_CONSULTA];
    } catch {
      return false;
    }
  }
}

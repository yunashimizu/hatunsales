import { Injectable } from '@nestjs/common';
import { ACCIONES_AUDITORIA_FISCAL, FiscalAuditoriaRepository } from '../auditoria/fiscal-auditoria.repository';
import { RepositorioConfigFiscal } from './config-fiscal.repository';
import { FiscalConfigService } from './fiscal-config.service';
import { ActorFiscal, ACTOR_SISTEMA, AmbienteFiscal, BloqueoEmision, CLAVES_BLOQUEO_EMISION } from './fiscal-config.tipos';
import { NotificadorCambiosFiscales } from './notificador-cambios-fiscales';
import { RelojFiscal } from './reloj-fiscal';
import { leerBloqueoEmision } from './snapshot-config-fiscal';
import { EjecutorSql, TransaccionesFiscales } from './transacciones-fiscales';

export interface ResultadoReanudacion {
  ambiente: AmbienteFiscal;
  /** false si la emisión no estaba detenida (no se cambió nada). */
  reanudada: boolean;
  bloqueo_anterior: BloqueoEmision | null;
}

/**
 * Interruptor de emisión por ambiente (D5.4). Cuando SUNAT rechaza la credencial SOL o el certificado
 * (la clasificación trae `bloqueaEmision`), la emisión de ese ambiente se detiene: así una clave mala no
 * se vuelve a probar en cada venta (SUNAT bloquea al usuario SOL tras varios intentos) y las ventas se
 * registran sin comprobante con el motivo a la vista. Solo se reanuda al corregir la causa (credenciales
 * SOL o certificado de ese ambiente) o con «Reanudar emisión» en el panel; todo queda auditado.
 */
@Injectable()
export class InterruptorEmisionFiscal {
  constructor(
    private readonly repositorio: RepositorioConfigFiscal,
    private readonly transacciones: TransaccionesFiscales,
    private readonly auditoria: FiscalAuditoriaRepository,
    private readonly notificador: NotificadorCambiosFiscales,
    private readonly config: FiscalConfigService,
    private readonly reloj: RelojFiscal,
  ) {}

  /** Lectura directa de la BD (sin caché): decide si se puede llamar a SUNAT ahora. */
  async leer(ambiente: AmbienteFiscal, ejecutor?: EjecutorSql): Promise<BloqueoEmision | null> {
    const clave = CLAVES_BLOQUEO_EMISION[ambiente];
    const valores = await this.repositorio.leer([clave], ejecutor);
    return leerBloqueoEmision(valores[clave]);
  }

  /** Detiene la emisión del ambiente (lo decide la clasificación de la respuesta de SUNAT). */
  async abrir(
    ambiente: AmbienteFiscal,
    causa: { codigo: string; motivo: string },
    contexto: Record<string, unknown> = {},
  ): Promise<BloqueoEmision> {
    const clave = CLAVES_BLOQUEO_EMISION[ambiente];
    const bloqueo: BloqueoEmision = {
      codigo: String(causa.codigo ?? '').slice(0, 20),
      motivo: String(causa.motivo ?? '').slice(0, 500),
      fecha: this.reloj.ahora().toISOString(),
    };
    await this.transacciones.ejecutar(async (tx) => {
      await this.repositorio.guardar({ [clave]: JSON.stringify(bloqueo) }, tx);
      await this.auditoria.registrar(
        {
          accion: ACCIONES_AUDITORIA_FISCAL.EMISION_BLOQUEADA,
          id_usuario: ACTOR_SISTEMA.id_usuario,
          entidad: 'configuraciones',
          id_entidad: clave,
          detalle: { ambiente, ...bloqueo, ...contexto },
        },
        tx,
      );
    });
    this.notificador.notificar('config');
    return bloqueo;
  }

  /** «Reanudar emisión» del panel: limpia el interruptor del ambiente vigente. */
  async reanudar(actor: ActorFiscal): Promise<ResultadoReanudacion> {
    const ambiente = (await this.config.snapshotFresco()).ambiente;
    const anterior = await this.transacciones.ejecutar((tx) => this.limpiar(ambiente, 'reanudada desde el panel', actor, tx));
    if (anterior) this.notificador.notificar('config');
    return { ambiente, reanudada: anterior !== null, bloqueo_anterior: anterior };
  }

  /**
   * Dentro de la transacción de quien corrigió la causa (credenciales SOL o certificado del ambiente):
   * si estaba detenida, la reanuda y lo audita. Devuelve el bloqueo retirado (null si no había).
   * Quien llama avisa el cambio de configuración después del COMMIT.
   */
  async limpiar(ambiente: AmbienteFiscal, motivo: string, actor: ActorFiscal, ejecutor: EjecutorSql): Promise<BloqueoEmision | null> {
    const anterior = await this.leer(ambiente, ejecutor);
    if (!anterior) return null;
    const clave = CLAVES_BLOQUEO_EMISION[ambiente];
    await this.repositorio.guardar({ [clave]: '' }, ejecutor);
    await this.auditoria.registrar(
      {
        accion: ACCIONES_AUDITORIA_FISCAL.EMISION_REANUDADA,
        id_usuario: actor.id_usuario,
        entidad: 'configuraciones',
        id_entidad: clave,
        detalle: { ambiente, motivo, bloqueo: anterior, usuario: actor.nombre },
        ip: actor.ip,
      },
      ejecutor,
    );
    return anterior;
  }
}

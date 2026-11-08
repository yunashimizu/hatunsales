import { Injectable, Logger } from '@nestjs/common';
import { ACCIONES_AUDITORIA_FISCAL, FiscalAuditoriaRepository } from '../auditoria/fiscal-auditoria.repository';
import { CertificadoFiscalService } from '../certificado/certificado-fiscal.service';
import { ActorFiscal } from '../config/fiscal-config.tipos';
import { NotificadorCambiosFiscales } from '../config/notificador-cambios-fiscales';
import { BovedaSecretosFiscales, EstadoLlaveSecreto } from './boveda-secretos.service';
import { CifradoFiscalService } from './cifrado-fiscal.service';

/** Lo que GET /fiscal/estado dice de la llave maestra (sin valores ni huellas). */
export interface EstadoLlaveFiscal {
  /** FISCAL_SECRET_KEY_ANTERIOR está definida y es válida (hay una rotación en curso). */
  anterior_definida: boolean;
  /** Cuántos secretos todavía solo abren con la llave anterior: mientras sea > 0 no se puede quitar. */
  secretos_con_llave_anterior: number;
}

export interface ElementoRecifrado {
  /** Nombre en español llano. */
  secreto: string;
  estado: EstadoLlaveSecreto;
}

export interface ResultadoRecifrado {
  revisados: number;
  recifrados: number;
  ya_vigentes: number;
  ilegibles: number;
  /** true si ya se puede quitar FISCAL_SECRET_KEY_ANTERIOR sin perder nada. */
  puede_quitar_llave_anterior: boolean;
  detalle: ElementoRecifrado[];
}

const NOMBRES: Record<string, string> = {
  sol_clave: 'Clave SOL',
  gre_client_id: 'Credenciales de la guía de remisión (id)',
  gre_client_secret: 'Credenciales de la guía de remisión (clave)',
};

/**
 * Re-cifrado completo de los secretos fiscales (S7): la rotación de FISCAL_SECRET_KEY era perezosa (cada secreto
 * se re-cifraba solo al leerlo), y quitar la llave anterior antes de tiempo dejaba ilegible un secreto no leído
 * (p. ej. las credenciales de la guía). Aquí se recorren TODOS (clave SOL, credenciales GRE y certificados por
 * ambiente) y se vuelven a cifrar con la llave vigente. Nunca expone valores.
 */
@Injectable()
export class RecifradoFiscalService {
  private readonly log = new Logger(RecifradoFiscalService.name);

  constructor(
    private readonly boveda: BovedaSecretosFiscales,
    private readonly certificados: CertificadoFiscalService,
    private readonly cifrado: CifradoFiscalService,
    private readonly auditoria: FiscalAuditoriaRepository,
    private readonly notificador: NotificadorCambiosFiscales,
  ) {}

  /** Barato cuando no hay rotación: sin llave anterior no toca la base de datos. */
  async estadoLlave(): Promise<EstadoLlaveFiscal> {
    const anteriorDefinida = this.cifrado.diagnostico().rotacion;
    if (!anteriorDefinida) return { anterior_definida: false, secretos_con_llave_anterior: 0 };
    try {
      const elementos = await this.revisar(false);
      return {
        anterior_definida: true,
        secretos_con_llave_anterior: elementos.filter((e) => e.estado === 'con_llave_anterior').length,
      };
    } catch (error: any) {
      this.log.warn(`No se pudo revisar la llave de los secretos: ${error?.message ?? error}`);
      return { anterior_definida: true, secretos_con_llave_anterior: 0 };
    }
  }

  /** Re-cifra todo con la llave vigente. Audita (`FISCAL_SECRETOS_RECIFRADOS`) aunque no haya nada que cambiar. */
  async recifrarTodo(actor: ActorFiscal): Promise<ResultadoRecifrado> {
    this.cifrado.exigirDisponible();
    const detalle = await this.revisar(true);
    const resultado: ResultadoRecifrado = {
      revisados: detalle.filter((e) => e.estado !== 'falta').length,
      recifrados: detalle.filter((e) => e.estado === 'recifrado').length,
      ya_vigentes: detalle.filter((e) => e.estado === 'al_dia').length,
      ilegibles: detalle.filter((e) => e.estado === 'ilegible').length,
      puede_quitar_llave_anterior: detalle.every((e) => e.estado !== 'con_llave_anterior' && e.estado !== 'ilegible'),
      detalle,
    };
    await this.auditoria.registrar({
      accion: ACCIONES_AUDITORIA_FISCAL.SECRETOS_RECIFRADOS,
      id_usuario: actor.id_usuario ?? null,
      ip: actor.ip ?? null,
      detalle: {
        revisados: resultado.revisados,
        recifrados: resultado.recifrados,
        ya_vigentes: resultado.ya_vigentes,
        ilegibles: resultado.ilegibles,
        llave_anterior_definida: this.cifrado.diagnostico().rotacion,
      },
    });
    // La salud del panel (caché de 10 s) debe reflejar el cambio al instante.
    this.notificador.notificar('credenciales');
    return resultado;
  }

  private async revisar(aplicar: boolean): Promise<ElementoRecifrado[]> {
    const secretos = await this.boveda.revisarLlaves(aplicar);
    const certs = await this.certificados.revisarLlaves(aplicar);
    return [
      ...secretos.map((s) => ({ secreto: NOMBRES[s.nombre] ?? s.nombre, estado: s.estado })),
      ...certs.map((c) => ({ secreto: `Certificado digital de ${c.ambiente === 'produccion' ? 'producción' : 'BETA'}`, estado: c.estado })),
    ];
  }
}

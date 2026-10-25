import { Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { CertificadoFiscalService } from '../certificado/certificado-fiscal.service';
import type { CertificadoInfoVista } from '../certificado/certificado-info';
import { CifradoFiscalService } from '../seguridad/cifrado-fiscal.service';
import { CacheTtl } from './cache-ttl';
import { DIAS_AVISO_VENCIMIENTO } from './checklist-activacion';
import { FiscalConfigService } from './fiscal-config.service';
import { AmbienteFiscal, BloqueoEmision, ProveedorFiscal } from './fiscal-config.tipos';
import { FiscalEsquemaService } from './fiscal-esquema.service';
import { EstadoOperativoFiscal, FUENTE_ESTADO_OPERATIVO_FISCAL, FuenteEstadoOperativoFiscal } from './fiscal-tokens';
import { NotificadorCambiosFiscales } from './notificador-cambios-fiscales';
import { PreparacionFiscalService } from './preparacion-fiscal.service';
import { RelojFiscal } from './reloj-fiscal';

export type Semaforo = 'verde' | 'amarillo' | 'rojo';

/** Respuesta de GET /fiscal/estado (sin secretos; la ven también vendedor, caja y consulta). */
export interface EstadoFiscalVista {
  proveedor: ProveedorFiscal;
  proveedor_efectivo: ProveedorFiscal;
  ambiente: AmbienteFiscal;
  semaforo: Semaforo;
  /** Factura/boleta/notas listas para producción por SUNAT directo. */
  listo: boolean;
  faltantes: string[];
  advertencias: string[];
  certificado: {
    cargado: boolean;
    ambiente: AmbienteFiscal | null;
    /** Días que le quedan al certificado del ambiente vigente (igual que vence_en_dias). */
    dias_para_vencer: number | null;
    vence_en_dias: number | null;
    vencido: boolean;
    autofirmado: boolean | null;
    alerta: string | null;
  };
  gre: { activa: boolean; activa_efectiva: boolean; listo: boolean; faltantes: string[] };
  esquema: { listo: boolean; mensaje: string | null };
  cifrado_disponible: boolean;
  /** ¿Se emite ahora en el ambiente vigente? (lo aporta el módulo de emisión; null si no está registrado). */
  emision: { activa: boolean; ambiente: AmbienteFiscal; codigo?: string; motivo?: string } | null;
  /** Interruptor abierto del ambiente vigente: SUNAT rechazó la credencial SOL o el certificado. */
  bloqueo: BloqueoEmision | null;
  /** {pendientes, inciertos} de la cola de envíos del ambiente vigente; null mientras no esté registrado. */
  cola: Record<string, number> | null;
  /** {vencen_hoy, vencidos}: comprobantes no aceptados según su fecha límite de envío. */
  plazos: Record<string, number> | null;
  ultimo_envio_ok: string | null;
  ultimo_error: { codigo: string; mensaje: string; en: string } | null;
  tareas: { activas: boolean; ultima_ejecucion: string | null } | null;
  evaluado_en: string;
}

/**
 * Semáforo de la facturación electrónica para el panel. Se cachea 10 s (lo
 * consultan varios roles) y se invalida con cualquier cambio fiscal.
 */
@Injectable()
export class SaludFiscalService {
  static readonly TTL_MS = 10_000;
  private readonly logger = new Logger(SaludFiscalService.name);
  private readonly cache: CacheTtl<EstadoFiscalVista>;

  constructor(
    private readonly config: FiscalConfigService,
    private readonly preparacion: PreparacionFiscalService,
    private readonly certificados: CertificadoFiscalService,
    private readonly esquema: FiscalEsquemaService,
    private readonly cifrado: CifradoFiscalService,
    private readonly reloj: RelojFiscal,
    private readonly moduleRef: ModuleRef,
    notificador: NotificadorCambiosFiscales,
  ) {
    this.cache = new CacheTtl<EstadoFiscalVista>(SaludFiscalService.TTL_MS, () => this.reloj.ms());
    notificador.suscribir(() => this.cache.invalidar());
  }

  estado(): Promise<EstadoFiscalVista> {
    return this.cache.obtener('estado', () => this.calcular());
  }

  private async calcular(): Promise<EstadoFiscalVista> {
    const snapshot = await this.config.snapshot();
    const [proveedorEfectivo, greEfectiva, preparacion, certificados, esquema, operativo] = await Promise.all([
      this.config.proveedorActivo(),
      this.config.greActiva(),
      this.preparacion.evaluar(snapshot),
      this.certificados.infoTodos(),
      this.esquema.estado(),
      this.operativo(),
    ]);

    const cert = this.certificadoRelevante(snapshot.ambiente, certificados);
    const alerta = !cert
      ? null
      : cert.vencido
        ? 'El certificado digital está vencido.'
        : cert.dias_para_vencer <= DIAS_AVISO_VENCIMIENTO
          ? `El certificado digital vence en ${cert.dias_para_vencer} día(s).`
          : null;

    const gre = preparacion.checklist.gre;
    const bloqueo = snapshot.bloqueos[snapshot.ambiente];
    const errorConfig = Number(operativo?.cola?.error_config ?? 0);
    const vencidos = Number(operativo?.plazos?.vencidos ?? 0);
    const porAtender = Number(operativo?.plazos?.vencen_hoy ?? 0) + Number(operativo?.cola?.inciertos ?? 0);
    const semaforo: Semaforo =
      (proveedorEfectivo === 'sunat_directo' && !preparacion.listo) || (greEfectiva && !gre.listo) || errorConfig > 0 || bloqueo !== null
        ? 'rojo'
        : preparacion.advertencias.length > 0 ||
            vencidos > 0 ||
            porAtender > 0 ||
            alerta !== null ||
            snapshot.proveedor !== proveedorEfectivo
          ? 'amarillo'
          : 'verde';

    return {
      proveedor: snapshot.proveedor,
      proveedor_efectivo: proveedorEfectivo,
      ambiente: snapshot.ambiente,
      semaforo,
      listo: preparacion.listo,
      faltantes: [...preparacion.faltantes],
      advertencias: [...preparacion.advertencias],
      certificado: {
        cargado: !!cert,
        ambiente: cert?.ambiente ?? null,
        dias_para_vencer: cert?.dias_para_vencer ?? null,
        vence_en_dias: cert?.dias_para_vencer ?? null,
        vencido: cert?.vencido ?? false,
        autofirmado: cert ? cert.autofirmado : null,
        alerta,
      },
      gre: { activa: snapshot.gre.activa, activa_efectiva: greEfectiva, listo: gre.listo, faltantes: [...gre.faltantes] },
      esquema: { listo: esquema.listo, mensaje: esquema.mensaje },
      cifrado_disponible: this.cifrado.disponible(),
      emision: operativo?.emision ?? null,
      bloqueo: bloqueo ? { ...bloqueo } : null,
      cola: operativo?.cola ?? null,
      plazos: operativo?.plazos ?? null,
      ultimo_envio_ok: operativo?.ultimo_envio_ok ?? null,
      ultimo_error: operativo?.ultimo_error ?? null,
      tareas: operativo?.tareas ?? null,
      evaluado_en: this.reloj.ahora().toISOString(),
    };
  }

  /** En producción importa el de producción; en BETA el de pruebas o, si no hay, el de producción (el que se mostraría). */
  private certificadoRelevante(
    ambiente: AmbienteFiscal,
    certificados: Record<AmbienteFiscal, CertificadoInfoVista | null>,
  ): CertificadoInfoVista | null {
    return ambiente === 'produccion' ? certificados.produccion : (certificados.beta ?? certificados.produccion);
  }

  private async operativo(): Promise<EstadoOperativoFiscal | null> {
    let fuente: FuenteEstadoOperativoFiscal;
    try {
      fuente = this.moduleRef.get<FuenteEstadoOperativoFiscal>(FUENTE_ESTADO_OPERATIVO_FISCAL, { strict: false });
    } catch {
      return null; // el módulo de documentos aún no lo registró
    }
    try {
      return await fuente.estadoOperativo();
    } catch (error: any) {
      this.logger.warn(`No se pudo leer el estado operativo fiscal: ${error?.message ?? error}`);
      return null;
    }
  }
}

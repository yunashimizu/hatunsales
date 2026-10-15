import { Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { CacheTtl } from './cache-ttl';
import type { ResultadoPreparacion } from './checklist-activacion';
import { RepositorioConfigFiscal } from './config-fiscal.repository';
import type { ActualizarConfigFiscalDto } from './fiscal-config.dto';
import {
  ActorFiscal,
  AmbienteFiscal,
  CLAVES_CONFIG_FISCAL,
  CLAVES_SNAPSHOT_FISCAL,
  ConfigGreFiscal,
  EmisorFiscal,
  ModoBoletas,
  ProveedorFiscal,
  SeriesFiscales,
  SnapshotConfigFiscal,
} from './fiscal-config.tipos';
import {
  EVALUADOR_PREPARACION_FISCAL,
  EvaluadorPreparacionFiscal,
  GESTOR_CONFIG_FISCAL,
  GestorConfigFiscal,
  ResultadoGuardadoFiscal,
} from './fiscal-tokens';
import { NotificadorCambiosFiscales } from './notificador-cambios-fiscales';
import { RelojFiscal } from './reloj-fiscal';
import { construirSnapshot, defectosDesdeEntorno, DefectosEntornoFiscal } from './snapshot-config-fiscal';
import type { ConfiguracionFiscalVista } from './vista-config-fiscal';

/** Tipos de documento SUNAT para elegir la serie (09 = guía de remisión remitente). */
export type TipoDocumentoFiscal = '01' | '03' | '07' | '08' | '09';

/**
 * Configuración fiscal leída en caliente de la BD (sin redeploy).
 *
 * Todas las claves se leen con UNA consulta y se guardan 10 s en memoria
 * (single flight): con mucho tráfico cada instancia consulta la BD a lo sumo
 * una vez cada 10 s. Al guardar se invalida al instante en esta instancia; las
 * demás lo ven en ≤ 10 s.
 */
@Injectable()
export class FiscalConfigService {
  static readonly TTL_MS = 10_000;
  private static readonly FECHA_REGLAS_2027 = '2027-01-01';

  private readonly logger = new Logger(FiscalConfigService.name);
  private readonly cache: CacheTtl<SnapshotConfigFiscal>;
  private readonly defectos: DefectosEntornoFiscal = defectosDesdeEntorno();
  private avisoInconsistencia = false;

  constructor(
    private readonly repositorio: RepositorioConfigFiscal,
    private readonly reloj: RelojFiscal,
    private readonly moduleRef: ModuleRef,
    notificador: NotificadorCambiosFiscales,
  ) {
    this.cache = new CacheTtl<SnapshotConfigFiscal>(FiscalConfigService.TTL_MS, () => this.reloj.ms());
    notificador.suscribir((tipo) => {
      if (tipo === 'config' || tipo === 'credenciales') this.invalidar();
    });
  }

  snapshot(): Promise<SnapshotConfigFiscal> {
    return this.cache.obtener('snapshot', () => this.leerSnapshot());
  }

  /** Lectura directa de la BD, sin caché (antes de validar un cambio). */
  snapshotFresco(): Promise<SnapshotConfigFiscal> {
    return this.leerSnapshot();
  }

  invalidar(): void {
    this.cache.invalidar();
  }

  /**
   * Proveedor con el que se emiten las ventas. 'sunat_directo' solo si además el
   * ambiente es producción: una venta real jamás debe ir a SUNAT BETA.
   */
  async proveedorActivo(): Promise<ProveedorFiscal> {
    const snapshot = await this.snapshot();
    if (snapshot.proveedor === 'sunat_directo' && snapshot.ambiente !== 'produccion') {
      if (!this.avisoInconsistencia) {
        this.avisoInconsistencia = true;
        this.logger.warn('fiscal_proveedor=sunat_directo con ambiente beta: se emite con Nubefact hasta corregirlo en el panel.');
      }
      return 'nubefact';
    }
    return snapshot.proveedor;
  }

  async ambiente(): Promise<AmbienteFiscal> {
    return (await this.snapshot()).ambiente;
  }

  async emisor(): Promise<EmisorFiscal> {
    return { ...(await this.snapshot()).emisor };
  }

  async series(): Promise<SeriesFiscales> {
    return { ...(await this.snapshot()).series };
  }

  /** Serie de SUNAT directo para un tipo; en notas depende del documento que modifican ('01' o '03'). */
  async serieParaTipo(tipo: TipoDocumentoFiscal, tipoModificado?: '01' | '03'): Promise<string> {
    const series = await this.series();
    const deBoleta = tipoModificado === '03';
    switch (tipo) {
      case '01':
        return series.factura;
      case '03':
        return series.boleta;
      case '07':
        return deBoleta ? series.nc_boleta : series.nc_factura;
      case '08':
        return deBoleta ? series.nd_boleta : series.nd_factura;
      case '09':
        return series.gre_remitente;
    }
  }

  /** Configuración de la GRE remitente (serie, correlativo inicial y punto de partida por defecto). */
  async gre(): Promise<ConfigGreFiscal> {
    const gre = (await this.snapshot()).gre;
    return { ...gre, partida: { ...gre.partida }, partidaHeredada: { ...gre.partidaHeredada } };
  }

  /**
   * ¿Se envían las GRE remitente a SUNAT? Solo si se activó en el panel Y el
   * ambiente es producción (igual que proveedorActivo). Si no, como hoy: solo
   * se guardan en el sistema.
   */
  async greActiva(): Promise<boolean> {
    const snapshot = await this.snapshot();
    return snapshot.gre.activa && snapshot.ambiente === 'produccion';
  }

  async boletasModo(): Promise<ModoBoletas> {
    return (await this.snapshot()).boletasModo;
  }

  async envioEnLinea(): Promise<boolean> {
    return (await this.snapshot()).envioEnLinea;
  }

  async codigoProductoDefecto(): Promise<string | null> {
    return (await this.snapshot()).codigoProductoDefecto;
  }

  /** Las tareas programadas no corren en pruebas ni con FISCAL_TAREAS_DESACTIVADAS=true. */
  async tareasActivas(): Promise<boolean> {
    if ((process.env.NODE_ENV ?? '').toLowerCase() === 'test') return false;
    if ((process.env.FISCAL_TAREAS_DESACTIVADAS ?? '').trim().toLowerCase() === 'true') return false;
    return (await this.snapshot()).tareasActivas;
  }

  /** Reglas de validación postergadas al 01/01/2027 (RS 000143-2026); 'auto' decide por la fecha de Lima. */
  async aplicarReglas2027(): Promise<boolean> {
    const modo = (await this.snapshot()).reglas2027;
    if (modo === 'true') return true;
    if (modo === 'false') return false;
    return this.reloj.fechaLima() >= FiscalConfigService.FECHA_REGLAS_2027;
  }

  /** Numeración propia de las pruebas BETA: nunca consume correlativos reales. */
  siguienteCorrelativoBeta(): Promise<number> {
    return this.repositorio.incrementarContador(CLAVES_CONFIG_FISCAL.betaCorrelativo);
  }

  // ── Contrato §12.2 del diseño: se delega en los servicios especializados ──

  listoParaProduccion(): Promise<ResultadoPreparacion> {
    return this.resolver<EvaluadorPreparacionFiscal>(EVALUADOR_PREPARACION_FISCAL).listoParaProduccion();
  }

  obtenerConfigCompleta(): Promise<ConfiguracionFiscalVista> {
    return this.resolver<GestorConfigFiscal>(GESTOR_CONFIG_FISCAL).obtenerConfigCompleta();
  }

  guardar(dto: ActualizarConfigFiscalDto, actor: ActorFiscal): Promise<ResultadoGuardadoFiscal> {
    return this.resolver<GestorConfigFiscal>(GESTOR_CONFIG_FISCAL).guardar(dto, actor);
  }

  private resolver<T>(token: symbol): T {
    return this.moduleRef.get<T>(token, { strict: false });
  }

  private async leerSnapshot(): Promise<SnapshotConfigFiscal> {
    const valores = await this.repositorio.leer(CLAVES_SNAPSHOT_FISCAL);
    return construirSnapshot(valores, this.defectos);
  }
}

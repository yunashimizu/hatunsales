import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { ConfiguracionRepository } from '../../repository/Repository/configuracion.repository';
import {
  CLAVES_EMISOR,
  CLAVE_CONDICIONES_PROFORMA,
  emisorConfig,
} from '../../config/emisor.config';
import { TIPO_BOLETA, TIPO_FACTURA } from '../../util/fiscal/tipos-comprobante';
import { CodigoError, cuerpoError } from '../../util/errores-operativos';
import { whatsappCloudListo } from '../../config/whatsapp.config';
import { FiscalConfigService } from '../../sunat/config/fiscal-config.service';
import { CLAVES_EMISOR_FISCAL, SERIES_FISCALES_POR_DEFECTO } from '../../sunat/config/fiscal-config.tipos';
import { NotificadorCambiosFiscales } from '../../sunat/config/notificador-cambios-fiscales';
import { partirUbicacion } from '../../sunat/config/snapshot-config-fiscal';
import { EmisionDirecta } from '../../sunat/emision/emision.contrato';
import type { ContextoEmision } from '../../sunat/emision/emision.contrato';

/** Series que muestra el POS (solo lectura) y en qué estado está la emisión. */
export interface SeriesPosResponse {
  serie_boleta: string;
  serie_factura: string;
  por_tipo: Record<number, string>;
  editable_en_pos: false;
  /** Las series salen de la configuración fiscal (Facturación SUNAT), no de una clave suelta. */
  fuente: 'fiscal';
  ambiente: 'beta' | 'produccion';
  emision_activa: boolean;
  /** Compatibilidad con el POS: emisión activa en el ambiente de pruebas. */
  beta_pos_directo: boolean;
  /** Código del motivo cuando la emisión no está activa. */
  codigo?: string;
  aviso: string | null;
  mensaje: string;
}

@Injectable()
export class ConfiguracionFiscalBussnies {
  private readonly logger = new Logger(ConfiguracionFiscalBussnies.name);

  constructor(
    private readonly config: ConfiguracionRepository,
    private readonly fiscal: FiscalConfigService,
    private readonly cambiosFiscales: NotificadorCambiosFiscales,
    private readonly emision: EmisionDirecta,
  ) {}

  /**
   * Series efectivas para el POS (solo lectura en mostrador) y el estado de la emisión. Nunca
   * falla porque la emisión esté inactiva: lo informa en `mensaje` (la venta se registra igual).
   */
  async seriesPos(): Promise<SeriesPosResponse> {
    const modo = await this.emision.modo();
    let contexto: ContextoEmision | null = null;
    try {
      contexto = await this.emision.contexto();
    } catch (error) {
      if (modo.activo) {
        this.logger.warn(`No se pudo leer el contexto de emisión: ${(error as Error)?.message ?? error}`);
      }
    }
    const series = contexto?.series ?? (await this.seriesConfiguradas());
    const ambiente = contexto?.ambiente ?? modo.ambiente;

    return {
      serie_boleta: series.boleta,
      serie_factura: series.factura,
      por_tipo: {
        [TIPO_BOLETA]: series.boleta,
        [TIPO_FACTURA]: series.factura,
      },
      editable_en_pos: false,
      fuente: 'fiscal',
      ambiente,
      emision_activa: modo.activo,
      beta_pos_directo: modo.activo && modo.ambiente === 'beta',
      ...(modo.activo ? {} : { codigo: modo.codigo }),
      aviso: contexto?.aviso ?? null,
      mensaje: modo.activo
        ? ambiente === 'beta'
          ? `${contexto?.aviso ?? 'Prueba SUNAT BETA: sin validez tributaria.'} Series ${series.factura} (factura) y ${series.boleta} (boleta).`
          : `Emisión electrónica activa en SUNAT (producción): series ${series.factura} (factura) y ${series.boleta} (boleta).`
        : `La emisión electrónica no está activa: ${modo.motivo}. Las ventas se registran sin comprobante y se puede emitir después desde Ventas.`,
    };
  }

  /** Series de producción configuradas; si ni eso se puede leer, las de fábrica (solo para mostrar). */
  private async seriesConfiguradas(): Promise<{ factura: string; boleta: string }> {
    try {
      const series = await this.fiscal.series();
      return { factura: series.factura, boleta: series.boleta };
    } catch (error) {
      this.logger.warn(`No se pudieron leer las series fiscales configuradas: ${(error as Error)?.message ?? error}`);
      return { factura: SERIES_FISCALES_POR_DEFECTO.factura, boleta: SERIES_FISCALES_POR_DEFECTO.boleta };
    }
  }

  async obtenerAdmin() {
    const claves = [
      ...CLAVES_EMISOR,
      CLAVE_CONDICIONES_PROFORMA,
      'caja_modo',
    ];
    const valores = await this.config.obtenerVarias([...claves]);
    const series = await this.seriesPos();
    const fiscal = await this.estadoFiscal();

    return {
      emisor: {
        ruc: valores.emisor_ruc ?? emisorConfig.ruc,
        razon_social: valores.emisor_razon_social ?? emisorConfig.razon_social,
        direccion: valores.emisor_direccion ?? emisorConfig.direccion,
        ubicacion: valores.emisor_ubicacion ?? emisorConfig.ubicacion,
        logo_url: valores.emisor_logo_url ?? emisorConfig.logo_url,
        telefono: valores.emisor_telefono ?? emisorConfig.telefono,
        email: valores.emisor_email ?? emisorConfig.email,
        web: valores.emisor_web ?? emisorConfig.web,
      },
      proforma: {
        condiciones: valores[CLAVE_CONDICIONES_PROFORMA] ?? '',
      },
      // Solo lectura: se configuran en Facturación SUNAT (las del ambiente vigente).
      series: {
        serie_boleta: series.serie_boleta,
        serie_factura: series.serie_factura,
        editable: false,
        fuente: series.fuente,
        mensaje: 'Las series se configuran en Facturación SUNAT (configuración fiscal).',
      },
      estados: {
        whatsapp_cloud: whatsappCloudListo(),
        caja_modo: (valores.caja_modo || 'blando').toLowerCase() === 'estricto' ? 'estricto' : 'blando',
        // Facturación electrónica directa (detalle completo en GET /fiscal/configuracion).
        proveedor_fiscal: fiscal.proveedor,
        ambiente_fiscal: fiscal.ambiente,
        sunat_directo_listo: fiscal.listo,
        emision_activa: series.emision_activa,
      },
    };
  }

  private async estadoFiscal(): Promise<{ proveedor: string; ambiente: string; listo: boolean }> {
    const [proveedor, ambiente, preparacion] = await Promise.all([
      this.fiscal.proveedorActivo(),
      this.fiscal.ambiente(),
      this.fiscal.listoParaProduccion(),
    ]);
    return { proveedor, ambiente, listo: preparacion.listo };
  }

  /** Con SUNAT directo o la GRE electrónica activos, el RUC está atado al certificado. */
  private async exigirRucEditable(rucNuevo: string): Promise<void> {
    const snapshot = await this.fiscal.snapshotFresco();
    if (rucNuevo === snapshot.emisor.ruc) return;
    if (snapshot.proveedor === 'sunat_directo' || snapshot.gre.activa) {
      throw new ConflictException(
        cuerpoError(
          CodigoError.FISCAL_CONFIG_INVALIDA,
          'No se puede cambiar el RUC mientras SUNAT directo o la guía electrónica están activos.',
        ),
      );
    }
  }

  /**
   * Guarda emisor y condiciones de la proforma. `series` se acepta por compatibilidad con el
   * panel anterior y se ignora: las series de emisión se configuran en Facturación SUNAT.
   */
  async guardarAdmin(body: {
    emisor?: {
      ruc?: string;
      razon_social?: string;
      direccion?: string;
      ubicacion?: string;
      logo_url?: string;
      telefono?: string;
      email?: string;
      web?: string;
    };
    proforma?: { condiciones?: string };
    series?: { serie_boleta?: string; serie_factura?: string };
  }) {
    if (body.emisor) {
      const e = body.emisor;
      if (e.ruc != null) {
        const ruc = String(e.ruc).trim();
        await this.exigirRucEditable(ruc);
        await this.config.guardar('emisor_ruc', ruc);
      }
      if (e.razon_social != null) {
        await this.config.guardar('emisor_razon_social', String(e.razon_social).trim());
      }
      if (e.direccion != null) {
        await this.config.guardar('emisor_direccion', String(e.direccion).trim());
      }
      if (e.ubicacion != null) {
        const ubicacion = String(e.ubicacion).trim();
        await this.config.guardar('emisor_ubicacion', ubicacion);
        // Mantiene coherentes los datos del emisor de SUNAT directo (distrito/provincia/departamento).
        const partes = partirUbicacion(ubicacion);
        if (partes.distrito && partes.provincia && partes.departamento) {
          await this.config.guardar(CLAVES_EMISOR_FISCAL.distrito, partes.distrito);
          await this.config.guardar(CLAVES_EMISOR_FISCAL.provincia, partes.provincia);
          await this.config.guardar(CLAVES_EMISOR_FISCAL.departamento, partes.departamento);
        }
      }
      if (e.logo_url != null) {
        await this.config.guardar('emisor_logo_url', String(e.logo_url).trim());
      }
      if (e.telefono != null) {
        await this.config.guardar('emisor_telefono', String(e.telefono).trim());
      }
      if (e.email != null) {
        await this.config.guardar('emisor_email', String(e.email).trim());
      }
      if (e.web != null) {
        await this.config.guardar('emisor_web', String(e.web).trim());
      }
    }

    if (body.proforma?.condiciones != null) {
      await this.config.guardar(
        CLAVE_CONDICIONES_PROFORMA,
        String(body.proforma.condiciones).replace(/\r\n?/g, '\n').trim().slice(0, 1500),
      );
    }

    this.config.limpiarCache();
    // El emisor también lo usa SUNAT directo: su caché (y la del estado) se renuevan al instante.
    this.cambiosFiscales.notificar('config');
    return this.obtenerAdmin();
  }
}

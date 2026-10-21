import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { ConfiguracionRepository } from '../../repository/Repository/configuracion.repository';
import {
  CLAVES_EMISOR,
  CLAVE_CONDICIONES_PROFORMA,
  CLAVES_SERIES,
  SERIES_POR_DEFECTO,
  emisorConfig,
} from '../../config/emisor.config';
import {
  TIPO_BOLETA,
  TIPO_FACTURA,
  normalizarSerie,
  seriePorDefecto,
} from '../../util/fiscal/nubefact.catalogo';
import { CodigoError, cuerpoError } from '../../util/errores-operativos';
import { whatsappCloudListo } from '../../config/whatsapp.config';
import { FiscalConfigService } from '../../sunat/config/fiscal-config.service';
import { CLAVES_EMISOR_FISCAL } from '../../sunat/config/fiscal-config.tipos';
import { NotificadorCambiosFiscales } from '../../sunat/config/notificador-cambios-fiscales';
import { partirUbicacion } from '../../sunat/config/snapshot-config-fiscal';
import { PosBetaService } from '../../sunat/emision/pos-beta.service';

@Injectable()
export class ConfiguracionFiscalBussnies {
  constructor(
    private readonly config: ConfiguracionRepository,
    private readonly fiscal: FiscalConfigService,
    private readonly cambiosFiscales: NotificadorCambiosFiscales,
    private readonly posBeta: PosBetaService,
  ) {}

  /** Series efectivas para el POS (solo lectura en mostrador). */
  async seriesPos() {
    const betaPos = await this.posBeta.activoEnBeta();
    const serieBoleta = betaPos ? 'BB01' : await this.serieEfectiva(TIPO_BOLETA);
    const serieFactura = betaPos ? 'FB01' : await this.serieEfectiva(TIPO_FACTURA);
    return {
      serie_boleta: serieBoleta,
      serie_factura: serieFactura,
      por_tipo: {
        [TIPO_BOLETA]: serieBoleta,
        [TIPO_FACTURA]: serieFactura,
      },
      editable_en_pos: false,
      beta_pos_directo: betaPos,
      mensaje: betaPos
        ? 'Prueba SUNAT BETA activa: el POS usará el emisor BETA y las series FB01/BB01. No tiene validez tributaria.'
        : 'Emisión directa SUNAT BETA desactivada. Las ventas con comprobante no se enviarán a ningún proveedor alternativo.',
    };
  }

  /**
   * Serie configurada + normalizada para el tipo.
   * El POS y la emisión usan esta fuente (no localStorage).
   */
  async serieEfectiva(idTipo: number): Promise<string> {
    if (idTipo === TIPO_FACTURA) {
      const cfg = await this.config.obtenerTexto(
        CLAVES_SERIES.factura,
        SERIES_POR_DEFECTO.factura,
      );
      return normalizarSerie(cfg, TIPO_FACTURA);
    }
    if (idTipo === TIPO_BOLETA) {
      const cfg = await this.config.obtenerTexto(
        CLAVES_SERIES.boleta,
        SERIES_POR_DEFECTO.boleta,
      );
      return normalizarSerie(cfg, TIPO_BOLETA);
    }
    return seriePorDefecto(idTipo);
  }

  async obtenerAdmin() {
    const claves = [
      ...CLAVES_EMISOR,
      CLAVES_SERIES.boleta,
      CLAVES_SERIES.factura,
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
      series: {
        serie_boleta: series.serie_boleta,
        serie_factura: series.serie_factura,
      },
      estados: {
        whatsapp_cloud: whatsappCloudListo(),
        caja_modo: (valores.caja_modo || 'blando').toLowerCase() === 'estricto' ? 'estricto' : 'blando',
        // Facturación electrónica directa (detalle completo en GET /fiscal/configuracion).
        proveedor_fiscal: fiscal.proveedor,
        ambiente_fiscal: fiscal.ambiente,
        sunat_directo_listo: fiscal.listo,
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

    if (body.series?.serie_boleta != null) {
      const s = this.validarSerieGuardar(body.series.serie_boleta, TIPO_BOLETA);
      await this.config.guardar(CLAVES_SERIES.boleta, s);
    }
    if (body.series?.serie_factura != null) {
      const s = this.validarSerieGuardar(body.series.serie_factura, TIPO_FACTURA);
      await this.config.guardar(CLAVES_SERIES.factura, s);
    }

    this.config.limpiarCache();
    // El emisor también lo usa SUNAT directo: su caché (y la del estado) se renuevan al instante.
    this.cambiosFiscales.notificar('config');
    return this.obtenerAdmin();
  }

  private validarSerieGuardar(serie: string, idTipo: number): string {
    const normalizada = normalizarSerie(serie, idTipo);
    const limpia = (serie ?? '').toString().trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (limpia.length !== 4) {
      throw new BadRequestException(
        cuerpoError(
          CodigoError.SERIE_INVALIDA,
          'La serie debe tener 4 caracteres (por ejemplo, BBB1 o FFF1).',
        ),
      );
    }
    const esperado = idTipo === TIPO_FACTURA ? 'F' : 'B';
    if (limpia[0] !== esperado) {
      throw new BadRequestException(
        cuerpoError(
          CodigoError.SERIE_INVALIDA,
          idTipo === TIPO_FACTURA
            ? 'La serie de factura debe empezar con F (ej. FFF1).'
            : 'La serie de boleta debe empezar con B (ej. BBB1).',
        ),
      );
    }
    return normalizada;
  }
}

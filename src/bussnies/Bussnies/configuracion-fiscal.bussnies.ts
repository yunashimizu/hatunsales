import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfiguracionRepository } from '../../repository/Repository/configuracion.repository';
import {
  CLAVES_EMISOR,
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
import { nubefactConfig } from '../../config/nubefact.config';

@Injectable()
export class ConfiguracionFiscalBussnies {
  constructor(private readonly config: ConfiguracionRepository) {}

  /** Series efectivas para el POS (solo lectura en mostrador). */
  async seriesPos() {
    const serieBoleta = await this.serieEfectiva(TIPO_BOLETA);
    const serieFactura = await this.serieEfectiva(TIPO_FACTURA);
    return {
      serie_boleta: serieBoleta,
      serie_factura: serieFactura,
      por_tipo: {
        [TIPO_BOLETA]: serieBoleta,
        [TIPO_FACTURA]: serieFactura,
      },
      editable_en_pos: false,
      mensaje: 'La serie se asigna sola según boleta o factura. No es editable en el POS.',
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
      'caja_modo',
    ];
    const valores = await this.config.obtenerVarias([...claves]);
    const series = await this.seriesPos();

    return {
      emisor: {
        ruc: valores.emisor_ruc ?? emisorConfig.ruc,
        razon_social: valores.emisor_razon_social ?? emisorConfig.razon_social,
        direccion: valores.emisor_direccion ?? emisorConfig.direccion,
        ubicacion: valores.emisor_ubicacion ?? emisorConfig.ubicacion,
        logo_url: valores.emisor_logo_url ?? emisorConfig.logo_url,
      },
      series: {
        serie_boleta: series.serie_boleta,
        serie_factura: series.serie_factura,
      },
      estados: {
        nubefact_configurado: !!(nubefactConfig.url && nubefactConfig.token),
        whatsapp_cloud: whatsappCloudListo(),
        caja_modo: (valores.caja_modo || 'blando').toLowerCase() === 'estricto' ? 'estricto' : 'blando',
      },
    };
  }

  async guardarAdmin(body: {
    emisor?: {
      ruc?: string;
      razon_social?: string;
      direccion?: string;
      ubicacion?: string;
      logo_url?: string;
    };
    series?: { serie_boleta?: string; serie_factura?: string };
  }) {
    if (body.emisor) {
      const e = body.emisor;
      if (e.ruc != null) await this.config.guardar('emisor_ruc', String(e.ruc).trim());
      if (e.razon_social != null) {
        await this.config.guardar('emisor_razon_social', String(e.razon_social).trim());
      }
      if (e.direccion != null) {
        await this.config.guardar('emisor_direccion', String(e.direccion).trim());
      }
      if (e.ubicacion != null) {
        await this.config.guardar('emisor_ubicacion', String(e.ubicacion).trim());
      }
      if (e.logo_url != null) {
        await this.config.guardar('emisor_logo_url', String(e.logo_url).trim());
      }
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
    return this.obtenerAdmin();
  }

  private validarSerieGuardar(serie: string, idTipo: number): string {
    const normalizada = normalizarSerie(serie, idTipo);
    const limpia = (serie ?? '').toString().trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (limpia.length !== 4) {
      throw new BadRequestException(
        cuerpoError(
          CodigoError.SERIE_INVALIDA,
          'La serie debe tener 4 caracteres (ej. BBB1 o FFF1), igual que en Nubefact.',
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

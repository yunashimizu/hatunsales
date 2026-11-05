import { Injectable } from '@nestjs/common';
import { FiscalAuditoriaRepository } from '../auditoria/fiscal-auditoria.repository';
import { CertificadoFiscalService } from '../certificado/certificado-fiscal.service';
import { CacheTtl } from '../config/cache-ttl';
import { RepositorioConfigFiscal } from '../config/config-fiscal.repository';
import { FiscalConfigService } from '../config/fiscal-config.service';
import type { ActorFiscal, EmisorFiscal } from '../config/fiscal-config.tipos';
import { FiscalConfigError } from '../config/fiscal-errores';
import type { EmisorPruebaBeta } from '../config/fiscal-tokens';
import { esRucValido } from '../nucleo/documentos-identidad';
import type { EmisorBetaDto } from './emisor-beta.dto';

export const CLAVE_EMISOR_BETA = 'fiscal_beta_emisor';

/** Vigencia del emisor BETA leído (igual que el snapshot fiscal): cada vista previa y cada venta en BETA lo pide. */
const TTL_EMISOR_BETA_MS = 10_000;

@Injectable()
export class EmisorBetaService implements EmisorPruebaBeta {
  /** JSON guardado del emisor BETA ('' si no hay): se cachea el texto, no el objeto, para devolver siempre una copia nueva. */
  private readonly cache = new CacheTtl<string>(TTL_EMISOR_BETA_MS);

  constructor(
    private readonly repo: RepositorioConfigFiscal,
    private readonly config: FiscalConfigService,
    private readonly certificados: CertificadoFiscalService,
    private readonly auditoria: FiscalAuditoriaRepository,
  ) {}

  async obtenerEmisor(): Promise<EmisorFiscal> {
    const crudo = await this.cache.obtener(CLAVE_EMISOR_BETA, async () => (await this.repo.leer([CLAVE_EMISOR_BETA]))[CLAVE_EMISOR_BETA] ?? '');
    if (!crudo) return this.config.emisor();
    let d: EmisorBetaDto;
    try {
      d = JSON.parse(crudo);
    } catch {
      throw new FiscalConfigError(
        'FISCAL_CONFIG_INVALIDA',
        'El emisor BETA guardado no es válido; vuelva a guardarlo desde el panel.',
      );
    }
    if (!d || !esRucValido(d.ruc))
      throw new FiscalConfigError(
        'FISCAL_CONFIG_INVALIDA',
        'El RUC del emisor BETA no es válido.',
      );
    return {
      ruc: d.ruc,
      razonSocial: d.razon_social,
      nombreComercial: d.nombre_comercial ?? '',
      direccion: d.direccion,
      ubigeo: d.ubigeo,
      distrito: d.distrito,
      provincia: d.provincia,
      departamento: d.departamento,
      codigoEstablecimiento: d.codigo_establecimiento,
    };
  }

  async vista() {
    const e = await this.obtenerEmisor();
    const certificado = await this.certificados.infoActivo('beta');
    return {
      emisor: {
        ruc: e.ruc,
        razon_social: e.razonSocial,
        nombre_comercial: e.nombreComercial ?? '',
        direccion: e.direccion,
        ubigeo: e.ubigeo,
        distrito: e.distrito,
        provincia: e.provincia,
        departamento: e.departamento,
        codigo_establecimiento: e.codigoEstablecimiento,
      },
      ruc_certificado_beta: certificado?.ruc ?? null,
    };
  }

  async guardar(dto: EmisorBetaDto, actor: ActorFiscal) {
    if (!esRucValido(dto.ruc))
      throw new FiscalConfigError(
        'FISCAL_CONFIG_INVALIDA',
        'El RUC BETA no tiene un dígito verificador válido.',
      );
    await this.repo.guardar({ [CLAVE_EMISOR_BETA]: JSON.stringify(dto) });
    this.cache.invalidar();
    await this.auditoria.registrar({
      accion: 'CONFIG_EMISOR_BETA',
      id_usuario: actor.id_usuario,
      entidad: 'fiscal_beta',
      detalle: { ruc: dto.ruc, razon_social: dto.razon_social },
      ip: actor.ip,
    });
    return this.vista();
  }
}

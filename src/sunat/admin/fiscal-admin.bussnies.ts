import { Injectable } from '@nestjs/common';
import { FiscalAuditoriaRepository, RegistroAuditoriaFiscal } from '../auditoria/fiscal-auditoria.repository';
import {
  ArchivoCertificado,
  CertificadoFiscalService,
  CertificadoSubido,
  DescargaCertificadoPublico,
} from '../certificado/certificado-fiscal.service';
import { CertificadoInfoVista } from '../certificado/certificado-info';
import {
  ActualizarConfigFiscalDto,
  AuditoriaConsultaDto,
  CredencialesGreDto,
  CredencialesSolDto,
  FormatoDescargaCertificado,
  GenerarAutofirmadoDto,
  ProbarConexionDto,
  SubirCertificadoDto,
} from '../config/fiscal-config.dto';
import { FiscalConfigError } from '../config/fiscal-errores';
import { ActorFiscal, AmbienteFiscal } from '../config/fiscal-config.tipos';
import { ResultadoGuardadoFiscal } from '../config/fiscal-tokens';
import { GestorConfigFiscalService } from '../config/gestor-config-fiscal.service';
import { GestorCredencialesFiscalesService } from '../config/gestor-credenciales-fiscales.service';
import { PruebaConexionFiscalService, ResultadoPruebaConexion } from '../config/prueba-conexion-fiscal.service';
import { EstadoFiscalVista, SaludFiscalService } from '../config/salud-fiscal.service';
import { ConfiguracionFiscalVista } from '../config/vista-config-fiscal';
import { EstadoCredencialesGre } from '../seguridad/credenciales-gre.service';
import { EstadoCredencialesSol } from '../seguridad/credenciales-sol.service';
import { IFiscalAdminBussnies } from './ifiscal-admin.bussnies';

/**
 * Fachada de casos de uso para FiscalAdminController: el controlador solo
 * adapta HTTP (usuario, IP, archivos) y aquí se delega en los servicios.
 */
@Injectable()
export class FiscalAdminBussnies implements IFiscalAdminBussnies {
  constructor(
    private readonly gestorConfig: GestorConfigFiscalService,
    private readonly gestorCredenciales: GestorCredencialesFiscalesService,
    private readonly certificadosFiscales: CertificadoFiscalService,
    private readonly pruebaConexion: PruebaConexionFiscalService,
    private readonly salud: SaludFiscalService,
    private readonly auditoriaFiscal: FiscalAuditoriaRepository,
  ) {}

  obtenerConfiguracion(): Promise<ConfiguracionFiscalVista> {
    return this.gestorConfig.obtenerConfigCompleta();
  }

  actualizarConfiguracion(dto: ActualizarConfigFiscalDto, actor: ActorFiscal): Promise<ResultadoGuardadoFiscal> {
    return this.gestorConfig.guardar(dto, actor);
  }

  certificados(): Promise<Record<AmbienteFiscal, CertificadoInfoVista | null>> {
    return this.certificadosFiscales.infoTodos();
  }

  async certificado(ambiente: AmbienteFiscal): Promise<CertificadoInfoVista> {
    const info = await this.certificadosFiscales.infoActivo(ambiente);
    if (!info) throw new FiscalConfigError('FISCAL_CERT_NO_CARGADO', `No hay un certificado de ${ambiente} cargado.`);
    return info;
  }

  subirCertificado(archivo: ArchivoCertificado | undefined, dto: SubirCertificadoDto, actor: ActorFiscal): Promise<CertificadoSubido> {
    return this.certificadosFiscales.subir(archivo, dto.clave, { ambiente: dto.ambiente, forzar: dto.forzar }, actor);
  }

  eliminarCertificado(ambiente: AmbienteFiscal, actor: ActorFiscal) {
    return this.certificadosFiscales.eliminar(ambiente, actor);
  }

  /** Por omisión el de producción: es el que se registra en SOL. */
  descargarCertificadoPublico(
    ambiente: AmbienteFiscal | undefined,
    formato: FormatoDescargaCertificado | undefined,
  ): Promise<DescargaCertificadoPublico> {
    return this.certificadosFiscales.exportarPublico(ambiente ?? 'produccion', formato === 'pem' ? 'pem' : 'cer');
  }

  generarCertificadoAutofirmado(dto: GenerarAutofirmadoDto, actor: ActorFiscal): Promise<CertificadoSubido> {
    return this.certificadosFiscales.generarAutofirmadoBeta(actor, dto.dias ?? 365);
  }

  guardarCredencialesSol(dto: CredencialesSolDto, actor: ActorFiscal): Promise<EstadoCredencialesSol> {
    return this.gestorCredenciales.guardarSol(dto.usuario, dto.clave, actor);
  }

  eliminarCredencialesSol(actor: ActorFiscal): Promise<EstadoCredencialesSol> {
    return this.gestorCredenciales.eliminarSol(actor);
  }

  guardarCredencialesGre(dto: CredencialesGreDto, actor: ActorFiscal): Promise<EstadoCredencialesGre> {
    return this.gestorCredenciales.guardarGre(dto.client_id, dto.client_secret, actor);
  }

  eliminarCredencialesGre(actor: ActorFiscal): Promise<EstadoCredencialesGre> {
    return this.gestorCredenciales.eliminarGre(actor);
  }

  probarConexion(dto: ProbarConexionDto, actor: ActorFiscal): Promise<ResultadoPruebaConexion> {
    return this.pruebaConexion.probar({ ambiente: dto.ambiente, documento: dto.documento, tipoCpe: dto.tipo_cpe }, actor);
  }

  estado(): Promise<EstadoFiscalVista> {
    return this.salud.estado();
  }

  async auditoria(dto: AuditoriaConsultaDto): Promise<{ registros: RegistroAuditoriaFiscal[]; siguiente: number | null }> {
    const limite = dto.limite ?? 50;
    const registros = await this.auditoriaFiscal.listar(limite, dto.antes_de ?? null);
    const ultimo = registros[registros.length - 1];
    return { registros, siguiente: registros.length === limite && ultimo ? ultimo.id_auditoria : null };
  }
}

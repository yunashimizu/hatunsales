import type { RegistroAuditoriaFiscal } from '../auditoria/fiscal-auditoria.repository';
import type {
  ArchivoCertificado,
  CertificadoSubido,
  DescargaCertificadoPublico,
} from '../certificado/certificado-fiscal.service';
import type { CertificadoInfoVista } from '../certificado/certificado-info';
import type {
  ActualizarConfigFiscalDto,
  AuditoriaConsultaDto,
  CredencialesGreDto,
  CredencialesSolDto,
  FormatoDescargaCertificado,
  GenerarAutofirmadoDto,
  ProbarConexionDto,
  SubirCertificadoDto,
} from '../config/fiscal-config.dto';
import type { ActorFiscal, AmbienteFiscal } from '../config/fiscal-config.tipos';
import type { ResultadoGuardadoFiscal } from '../config/fiscal-tokens';
import type { ResultadoPruebaConexion } from '../config/prueba-conexion-fiscal.service';
import type { EstadoFiscalVista } from '../config/salud-fiscal.service';
import type { ConfiguracionFiscalVista } from '../config/vista-config-fiscal';
import type { EstadoCredencialesGre } from '../seguridad/credenciales-gre.service';
import type { EstadoCredencialesSol } from '../seguridad/credenciales-sol.service';

/** Casos de uso de la administración de la facturación electrónica (/fiscal/*). */
export interface IFiscalAdminBussnies {
  obtenerConfiguracion(): Promise<ConfiguracionFiscalVista>;
  actualizarConfiguracion(dto: ActualizarConfigFiscalDto, actor: ActorFiscal): Promise<ResultadoGuardadoFiscal>;

  certificados(): Promise<Record<AmbienteFiscal, CertificadoInfoVista | null>>;
  certificado(ambiente: AmbienteFiscal): Promise<CertificadoInfoVista>;
  subirCertificado(archivo: ArchivoCertificado | undefined, dto: SubirCertificadoDto, actor: ActorFiscal): Promise<CertificadoSubido>;
  eliminarCertificado(
    ambiente: AmbienteFiscal,
    actor: ActorFiscal,
  ): Promise<{ eliminado: true; ambiente: AmbienteFiscal; id_certificado: number }>;
  descargarCertificadoPublico(ambiente: AmbienteFiscal | undefined, formato: FormatoDescargaCertificado | undefined): Promise<DescargaCertificadoPublico>;
  generarCertificadoAutofirmado(dto: GenerarAutofirmadoDto, actor: ActorFiscal): Promise<CertificadoSubido>;

  guardarCredencialesSol(dto: CredencialesSolDto, actor: ActorFiscal): Promise<EstadoCredencialesSol>;
  eliminarCredencialesSol(actor: ActorFiscal): Promise<EstadoCredencialesSol>;
  guardarCredencialesGre(dto: CredencialesGreDto, actor: ActorFiscal): Promise<EstadoCredencialesGre>;
  eliminarCredencialesGre(actor: ActorFiscal): Promise<EstadoCredencialesGre>;

  probarConexion(dto: ProbarConexionDto, actor: ActorFiscal): Promise<ResultadoPruebaConexion>;
  estado(): Promise<EstadoFiscalVista>;
  auditoria(dto: AuditoriaConsultaDto): Promise<{ registros: RegistroAuditoriaFiscal[]; siguiente: number | null }>;
}

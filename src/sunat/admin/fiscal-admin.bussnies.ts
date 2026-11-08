import { Inject, Injectable, Optional } from '@nestjs/common';
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
import { EMISOR_PRUEBA_BETA } from '../config/fiscal-tokens';
import type { EmisorPruebaBeta, ResultadoGuardadoFiscal } from '../config/fiscal-tokens';
import { GestorConfigFiscalService } from '../config/gestor-config-fiscal.service';
import { GestorCredencialesFiscalesService } from '../config/gestor-credenciales-fiscales.service';
import { PruebaConexionFiscalService, ResultadoPruebaConexion } from '../config/prueba-conexion-fiscal.service';
import { EstadoFiscalVista, SaludFiscalService } from '../config/salud-fiscal.service';
import { ConfiguracionFiscalVista } from '../config/vista-config-fiscal';
import { EstadoCredencialesGre } from '../seguridad/credenciales-gre.service';
import { EstadoCredencialesSol } from '../seguridad/credenciales-sol.service';
import { RecifradoFiscalService, ResultadoRecifrado } from '../seguridad/recifrado-fiscal.service';
import { AlertasFiscalesService, EstadoAlertasFiscales } from '../alertas/alertas-fiscales.service';
import { ACCIONES_AUDITORIA_FISCAL } from '../auditoria/fiscal-auditoria.repository';
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
    /** EmisorBetaService (módulo de emisión) por su token: el certificado de prueba lleva el RUC del emisor BETA. */
    @Inject(EMISOR_PRUEBA_BETA) private readonly emisorBeta: EmisorPruebaBeta,
    @Optional() private readonly recifrado?: RecifradoFiscalService,
    @Optional() private readonly alertas?: AlertasFiscalesService,
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

  async subirCertificado(archivo: ArchivoCertificado | undefined, dto: SubirCertificadoDto, actor: ActorFiscal): Promise<CertificadoSubido> {
    // Solo para BETA: el certificado de pruebas se valida contra el emisor BETA (puede ser otro RUC).
    const emisor = dto.ambiente === 'beta' ? await this.emisorBeta.obtenerEmisor() : undefined;
    return this.certificadosFiscales.subir(archivo, dto.clave, { ambiente: dto.ambiente, forzar: dto.forzar }, actor, emisor);
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

  async generarCertificadoAutofirmado(dto: GenerarAutofirmadoDto, actor: ActorFiscal): Promise<CertificadoSubido> {
    const e = await this.emisorBeta.obtenerEmisor();
    return this.certificadosFiscales.generarAutofirmadoBeta(actor, dto.dias ?? 365, { ruc: e.ruc, razonSocial: e.razonSocial });
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

  /** Vuelve a cifrar con la llave vigente la clave SOL, las credenciales de la guía y los certificados (admin). */
  recifrarSecretos(actor: ActorFiscal): Promise<ResultadoRecifrado> {
    if (!this.recifrado) throw new FiscalConfigError('FISCAL_CONFIG_INVALIDA', 'El re-cifrado de secretos no está disponible en este servidor.');
    return this.recifrado.recifrarTodo(actor);
  }

  estadoAlertas(): Promise<EstadoAlertasFiscales> {
    return this.servicioAlertas().estado();
  }

  async guardarCorreoAlertas(correo: string | undefined, actor: ActorFiscal): Promise<EstadoAlertasFiscales> {
    const antes = await this.servicioAlertas().estado();
    const despues = await this.servicioAlertas().guardarCorreo(correo);
    await this.auditoriaFiscal.registrar({
      accion: ACCIONES_AUDITORIA_FISCAL.CONFIG_OPERACION,
      id_usuario: actor.id_usuario ?? null,
      ip: actor.ip ?? null,
      detalle: { cambio: 'correo_alertas', antes: antes.correo, despues: despues.correo },
    });
    return despues;
  }

  private servicioAlertas(): AlertasFiscalesService {
    if (!this.alertas) throw new FiscalConfigError('FISCAL_CONFIG_INVALIDA', 'Los avisos por correo no están disponibles en este servidor.');
    return this.alertas;
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

import { RegistroModulo } from '../../registro/registro-modulo';
import { FiscalAdminBussnies } from '../admin/fiscal-admin.bussnies';
import { FiscalAdminController } from '../admin/fiscal-admin.controller';
import { FiscalAuditoriaRepository } from '../auditoria/fiscal-auditoria.repository';
import { CertificadoFiscalRepository, RepositorioCertificadosFiscales } from '../certificado/certificado-fiscal.repository';
import { CertificadoFiscalService } from '../certificado/certificado-fiscal.service';
import { ConfigFiscalRepository, RepositorioConfigFiscal } from '../config/config-fiscal.repository';
import { DiagnosticoArranqueFiscal } from '../config/diagnostico-arranque-fiscal';
import { FiscalConfigService } from '../config/fiscal-config.service';
import { FiscalEsquemaService } from '../config/fiscal-esquema.service';
import { EVALUADOR_PREPARACION_FISCAL, GESTOR_CONFIG_FISCAL } from '../config/fiscal-tokens';
import { GestorConfigFiscalService } from '../config/gestor-config-fiscal.service';
import { GestorCredencialesFiscalesService } from '../config/gestor-credenciales-fiscales.service';
import { NotificadorCambiosFiscales } from '../config/notificador-cambios-fiscales';
import { PreparacionFiscalService } from '../config/preparacion-fiscal.service';
import { PruebaConexionFiscalService } from '../config/prueba-conexion-fiscal.service';
import { RelojFiscal, RelojSistemaFiscal } from '../config/reloj-fiscal';
import { SaludFiscalService } from '../config/salud-fiscal.service';
import { TransaccionesFiscales, TransaccionesFiscalesPg } from '../config/transacciones-fiscales';
import { BovedaSecretosFiscales } from '../seguridad/boveda-secretos.service';
import { CifradoFiscalService } from '../seguridad/cifrado-fiscal.service';
import { CredencialesGreService } from '../seguridad/credenciales-gre.service';
import { CredencialesSolService } from '../seguridad/credenciales-sol.service';
import { RepositorioSecretosFiscales, SecretosFiscalesRepository } from '../seguridad/secretos-fiscales.repository';

/**
 * Configuración fiscal, certificado digital, credenciales SOL/API (GRE) y
 * administración (FiscalAdminController). Sin entidades: los repositorios
 * usan SQL parametrizado sobre las tablas de sql/fase9_sunat_directo.sql.
 *
 * Lo que exporta para otros módulos SUNAT (inyectables por clase):
 * FiscalConfigService, CertificadoFiscalService (obtenerMaterialFirma,
 * obtenerCredencialesSol, obtenerCredencialesGre), CredencialesSolService,
 * CredencialesGreService, FiscalAuditoriaRepository, FiscalEsquemaService,
 * TransaccionesFiscales, RelojFiscal y NotificadorCambiosFiscales.
 */
export const REGISTRO_SUNAT_CONFIG: RegistroModulo = {
  entidades: [],
  controladores: [FiscalAdminController],
  proveedores: [
    // Infraestructura (puertos → adaptadores)
    NotificadorCambiosFiscales,
    { provide: RelojFiscal, useClass: RelojSistemaFiscal },
    { provide: TransaccionesFiscales, useClass: TransaccionesFiscalesPg },
    { provide: RepositorioConfigFiscal, useClass: ConfigFiscalRepository },
    { provide: RepositorioSecretosFiscales, useClass: SecretosFiscalesRepository },
    { provide: RepositorioCertificadosFiscales, useClass: CertificadoFiscalRepository },
    FiscalEsquemaService,
    FiscalAuditoriaRepository,
    DiagnosticoArranqueFiscal,

    // Seguridad
    CifradoFiscalService,
    BovedaSecretosFiscales,
    CredencialesSolService,
    CredencialesGreService,

    // Configuración y certificado
    FiscalConfigService,
    CertificadoFiscalService,
    PreparacionFiscalService,
    { provide: EVALUADOR_PREPARACION_FISCAL, useExisting: PreparacionFiscalService },
    GestorConfigFiscalService,
    { provide: GESTOR_CONFIG_FISCAL, useExisting: GestorConfigFiscalService },
    GestorCredencialesFiscalesService,
    PruebaConexionFiscalService,
    SaludFiscalService,

    // Casos de uso del panel
    FiscalAdminBussnies,
  ],
};

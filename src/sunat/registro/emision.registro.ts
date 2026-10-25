import { RegistroModulo } from '../../registro/registro-modulo';
import {
  EMISOR_PRUEBA_BETA,
  FUENTE_ESTADO_OPERATIVO_FISCAL,
  PROBADOR_ENVIO_CPE,
} from '../config/fiscal-tokens';
import { BetaAdminController } from '../emision/beta-admin.controller';
import { EmisionDirectaService } from '../emision/emision-directa.service';
import { EmisionDirecta, OyentesEnvioFiscal } from '../emision/emision.contrato';
import { EmisorBetaService } from '../emision/emisor-beta.service';
import { EnvioFiscalRepository } from '../emision/envio-fiscal.repository';
import { EnviosAdminController } from '../emision/envios-admin.controller';
import { ProbadorEnvioCpeService } from '../emision/probador-envio-cpe.service';
import { SunatEmisionService } from '../emision/sunat-emision.service';
import { EmisionFiscalTarea } from '../tareas/emision-fiscal.tarea';

/**
 * Emisión directa de factura, boleta y notas (BETA y PRODUCCIÓN): contrato EmisionDirecta para el
 * negocio, oyentes de envíos (singleton: el negocio registra los suyos al iniciar), administración de
 * envíos, prueba BETA del panel y la tarea programada de reintentos con su estado para /fiscal/estado.
 */
export const REGISTRO_SUNAT_EMISION: RegistroModulo = {
  entidades: [],
  controladores: [BetaAdminController, EnviosAdminController],
  proveedores: [
    { provide: OyentesEnvioFiscal, useClass: OyentesEnvioFiscal },
    EnvioFiscalRepository,
    SunatEmisionService,
    EmisorBetaService,
    EmisionDirectaService,
    { provide: EmisionDirecta, useExisting: EmisionDirectaService },
    ProbadorEnvioCpeService,
    { provide: PROBADOR_ENVIO_CPE, useExisting: ProbadorEnvioCpeService },
    { provide: EMISOR_PRUEBA_BETA, useExisting: EmisorBetaService },
    EmisionFiscalTarea,
    { provide: FUENTE_ESTADO_OPERATIVO_FISCAL, useExisting: EmisionFiscalTarea },
  ],
};

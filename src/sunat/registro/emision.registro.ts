import { RegistroModulo } from '../../registro/registro-modulo';
import {
  EMISOR_PRUEBA_BETA,
  PROBADOR_ENVIO_CPE,
} from '../config/fiscal-tokens';
import { BetaAdminController } from '../emision/beta-admin.controller';
import { EmisorBetaService } from '../emision/emisor-beta.service';
import { EnvioBetaRepository } from '../emision/envio-beta.repository';
import { ProbadorEnvioCpeService } from '../emision/probador-envio-cpe.service';
import { SunatEmisionBetaService } from '../emision/sunat-emision-beta.service';
import { PosBetaService } from '../emision/pos-beta.service';

/** Emisión directa integrada al flujo de comprobantes (estrategia de proveedor, SunatEmisionService, pruebas BETA). */
export const REGISTRO_SUNAT_EMISION: RegistroModulo = {
  entidades: [],
  controladores: [BetaAdminController],
  proveedores: [
    EnvioBetaRepository,
    SunatEmisionBetaService,
    PosBetaService,
    EmisorBetaService,
    ProbadorEnvioCpeService,
    { provide: PROBADOR_ENVIO_CPE, useExisting: ProbadorEnvioCpeService },
    { provide: EMISOR_PRUEBA_BETA, useExisting: EmisorBetaService },
  ],
};

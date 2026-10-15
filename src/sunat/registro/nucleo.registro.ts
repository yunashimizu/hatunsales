import { Logger } from '@nestjs/common';
import { RegistroModulo } from '../../registro/registro-modulo';
import { ClasificadorRespuestaSunat } from '../nucleo/clasificador-respuesta';
import { FabricaClienteSoapSunat } from '../nucleo/soap/sunat-soap-client';
import { PreparadorEnvioCpe } from '../nucleo/preparador-envio-cpe';

/**
 * Núcleo SUNAT puro (UBL, firma, ZIP, cliente SOAP, CDR, clasificador). Sus
 * clases no dependen de Nest; aquí se exponen como providers sin estado para
 * que emisión, documentos y tareas las inyecten (y los specs las reemplacen).
 */
export const REGISTRO_SUNAT_NUCLEO: RegistroModulo = {
  entidades: [],
  controladores: [],
  proveedores: [
    { provide: PreparadorEnvioCpe, useFactory: () => new PreparadorEnvioCpe() },
    { provide: FabricaClienteSoapSunat, useFactory: () => new FabricaClienteSoapSunat() },
    { provide: ClasificadorRespuestaSunat, useFactory: () => new ClasificadorRespuestaSunat(new Logger('ClasificadorRespuestaSunat')) },
  ],
};

import { RegistroModulo } from '../../registro/registro-modulo';
import { EmisionGre } from '../gre/gre.contrato';
import { GreEmisionService } from '../gre/gre-emision.service';
import { ClienteRestGre, TransporteHttpGreAxios } from '../gre/gre-rest-client';
import { PreparadorGre } from '../gre/preparador-gre';

/**
 * Guía de Remisión Electrónica Remitente por la API REST de SUNAT: el motor (validar, armar el
 * DespatchAdvice, firmar, ZIP, token, envío y consulta del ticket). Depende de REGISTRO_SUNAT_CONFIG
 * (configuración fiscal, certificado y credenciales). El negocio de la guía inyecta `EmisionGre`.
 * El cliente REST es uno solo por instancia: así el token queda en memoria y se reutiliza.
 */
export const REGISTRO_SUNAT_GRE: RegistroModulo = {
  entidades: [],
  controladores: [],
  proveedores: [
    { provide: PreparadorGre, useFactory: () => new PreparadorGre() },
    { provide: ClienteRestGre, useFactory: () => new ClienteRestGre(new TransporteHttpGreAxios()) },
    GreEmisionService,
    { provide: EmisionGre, useExisting: GreEmisionService },
  ],
};

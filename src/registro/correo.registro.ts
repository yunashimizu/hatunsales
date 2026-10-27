import { ComprobanteCorreosRepository } from '../correo/comprobante-correos.repository';
import { fabricarEnviador } from '../correo/correo.config';
import { CorreoComprobanteService } from '../correo/correo-comprobante.service';
import { CorreoComprobantesTarea } from '../correo/correo-comprobantes.tarea';
import { EnviadorCorreo } from '../correo/enviador-correo.contrato';
import { RegistroModulo } from './registro-modulo';

/**
 * Envío del comprobante por correo al cliente: cola (comprobante_correos, sql/fase17), servicio, proveedor
 * de correo según CORREO_PROVEEDOR (brevo, resend o archivo) y la tarea periódica. El servicio usa además
 * ComprobanteBussnies (app.module.ts), RepositorioConfigFiscal (REGISTRO_SUNAT_CONFIG) y FiscalConfigService.
 * Los endpoints viven en ComprobanteController.
 */
export const REGISTRO_CORREO: RegistroModulo = {
  entidades: [],
  controladores: [],
  proveedores: [
    ComprobanteCorreosRepository,
    CorreoComprobanteService,
    { provide: EnviadorCorreo, useFactory: () => fabricarEnviador() },
    CorreoComprobantesTarea,
  ],
};

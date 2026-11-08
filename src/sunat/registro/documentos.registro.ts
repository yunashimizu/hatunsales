import { RegistroModulo } from '../../registro/registro-modulo';
import { AlertasFiscalesRepository } from '../alertas/alertas-fiscales.repository';
import { AlertasFiscalesService } from '../alertas/alertas-fiscales.service';
import { AlertasFiscalesTarea } from '../alertas/alertas-fiscales.tarea';
import { LoteFiscalRepository } from '../documentos/lote-fiscal.repository';
import { LotesAdminController } from '../documentos/lotes-admin.controller';
import { LotesFiscalesService } from '../documentos/lotes-fiscales.service';
import { LotesFiscalesTarea } from '../documentos/lotes-fiscales.tarea';
import { LotesFiscales } from '../documentos/lotes.contrato';

/**
 * Representación impresa, descargas XML/CDR/PDF, anulación, resúmenes y tareas programadas fiscales.
 * Por ahora: los lotes fiscales (comunicación de baja RA y resumen diario RC con la condición 3 «anular»)
 * con que se anula un comprobante aceptado sin nota de crédito, su administración y su tarea de tickets.
 */
export const REGISTRO_SUNAT_DOCUMENTOS: RegistroModulo = {
  entidades: [],
  controladores: [LotesAdminController],
  proveedores: [
    LoteFiscalRepository,
    LotesFiscalesService,
    { provide: LotesFiscales, useExisting: LotesFiscalesService },
    LotesFiscalesTarea,
    // Avisos diarios por correo (certificado por vencer, envíos que requieren revisión…).
    AlertasFiscalesRepository,
    AlertasFiscalesService,
    AlertasFiscalesTarea,
  ],
};

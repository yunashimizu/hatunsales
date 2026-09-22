import AdmZip from 'adm-zip';
import { endpointBillServicePorTipo, getFiscalConfig } from '../config/fiscal-config';
import { EmitirResumenDiarioBetaDto, ResumenDiarioBetaService } from '../factura/resumen-diario-beta.service';
import { FacturaBetaFirmaService } from '../factura/factura-beta-firma.service';
import { SunatBillClient } from './sunat-bill.client';
import { FiscalEnvioRepository } from '../repository/fiscal-envio.repository';

export interface ResumenDiarioEnvioResultado {
  ok: boolean;
  identificador: string;
  ticket: string | null;
  mensaje: string;
  idEnvio?: number;
}

export interface ResumenDiarioConsultaResultado {
  ok: boolean;
  finalizado: boolean;
  aceptado: boolean;
  mensaje: string;
}

/**
 * Envía el Resumen Diario de Boletas (sendSummary → ticket → getStatus),
 * a diferencia de Factura/Boleta/NC/GRE que van por sendBill y reciben el
 * CDR de inmediato. El fileName del ZIP sigue la convención propia de SUNAT
 * para resúmenes: {RUC}-RC-{AAAAMMDD}-{correlativo}.zip (no la de
 * tipo-serie-número que usan los comprobantes individuales).
 */
export class ResumenDiarioEnvioService {
  constructor(private readonly fiscalEnvioRepository?: FiscalEnvioRepository) {}

  async enviar(dto: EmitirResumenDiarioBetaDto): Promise<ResumenDiarioEnvioResultado> {
    const config = getFiscalConfig();

    if (!config.proveedorHabilitado || config.proveedorActivo !== 'sunat-direct') {
      return { ok: false, identificador: '', ticket: null, mensaje: 'Proveedor fiscal directo no habilitado explícitamente.' };
    }

    let envio = null as any;

    try {
      const xmlResult = await new ResumenDiarioBetaService().emitirResumenDiarioBeta(dto);
      const xmlFirmado = await new FacturaBetaFirmaService().firmar(xmlResult.xml);

      const fileName = `${dto.rucEmisor}-RC-${dto.fechaEmisionDocumentos.replace(/-/g, '')}-${dto.numeroCorrelativoResumen}`;
      const zip = new AdmZip();
      zip.addFile(`${fileName}.xml`, Buffer.from(xmlFirmado.xmlFirmado, 'utf8'));
      const zipBase64 = zip.toBuffer().toString('base64');

      envio = this.fiscalEnvioRepository
        ? await this.fiscalEnvioRepository.registrar({
            tipo_documento: 'RC',
            ambiente: config.ambiente,
            proveedor: 'sunat-direct',
            operacion: 'resumen',
            estado: 'ENVIANDO',
            intento: 1,
            nombre_archivo: `${fileName}.zip`,
            observaciones: `Resumen diario ${xmlResult.identificador} para boletas del ${dto.fechaEmisionDocumentos}.`,
          })
        : { id_envio: null };

      const billClient = new SunatBillClient({
        username: `${dto.rucEmisor}${process.env.SUNAT_USERNAME_SUFFIX ?? 'MODDATOS'}`,
        password: process.env.SUNAT_PASSWORD ?? 'MODDATOS',
        endpoint: endpointBillServicePorTipo('03', config.ambiente),
        timeoutMs: Number(process.env.SUNAT_TIMEOUT_MS ?? 30000),
      });

      const sendResult = await billClient.sendSummary(`${fileName}.zip`, zipBase64);

      if (this.fiscalEnvioRepository && envio?.id_envio) {
        await this.fiscalEnvioRepository.actualizarEstado(envio.id_envio, sendResult.ok ? 'TICKET_PENDIENTE' : 'ERROR_TRANSPORTE', {
          sunat_ticket: sendResult.ticket ?? undefined,
          mensaje_sunat: sendResult.fault?.faultString ?? sendResult.message,
          ultimo_error: sendResult.ok ? undefined : (sendResult.fault?.faultString ?? sendResult.message),
          respuesta_json: { sendSummary: sendResult },
        });
      }

      return {
        ok: sendResult.ok,
        identificador: xmlResult.identificador,
        ticket: sendResult.ticket,
        mensaje: sendResult.message,
        idEnvio: envio?.id_envio ?? undefined,
      };
    } catch (error: any) {
      if (this.fiscalEnvioRepository && envio?.id_envio) {
        await this.fiscalEnvioRepository.actualizarEstado(envio.id_envio, 'ERROR_TRANSPORTE', {
          ultimo_error: error?.message ?? 'Error inesperado enviando el resumen diario.',
        });
      }
      return { ok: false, identificador: '', ticket: null, mensaje: error?.message ?? 'Error inesperado enviando el resumen diario.' };
    }
  }

  /** Consulta un ticket de sendSummary. SUNAT puede seguir "En proceso" (finalizado=false) por un rato. */
  async consultarTicket(ticket: string, rucEmisor: string): Promise<ResumenDiarioConsultaResultado> {
    const config = getFiscalConfig();
    const billClient = new SunatBillClient({
      username: `${rucEmisor}${process.env.SUNAT_USERNAME_SUFFIX ?? 'MODDATOS'}`,
      password: process.env.SUNAT_PASSWORD ?? 'MODDATOS',
      endpoint: endpointBillServicePorTipo('03', config.ambiente),
      timeoutMs: Number(process.env.SUNAT_TIMEOUT_MS ?? 30000),
    });

    const resultado = await billClient.getStatus(ticket);

    return {
      ok: resultado.ok,
      finalizado: resultado.finalizado,
      aceptado: !!resultado.cdrXml,
      mensaje: resultado.fault?.faultString ?? resultado.message,
    };
  }
}

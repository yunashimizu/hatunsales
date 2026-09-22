import { createHash } from 'crypto';
import { FiscalGreDocument, FiscalIssueResult, GreProvider } from './fiscal-provider.interface';
import { endpointBillServicePorTipo, getFiscalConfig } from '../config/fiscal-config';
import { GuiaRemisionBetaService } from '../factura/guia-remision-beta.service';
import { CATALOGO_20_MOTIVO_TRASLADO, CATALOGO_21_MODALIDAD_TRASLADO } from '../catalogos/sunat.catalogos';
import { FacturaBetaFirmaService } from '../factura/factura-beta-firma.service';
import { FacturaBetaZipService } from '../factura/factura-beta-zip.service';
import { SunatBillClient } from './sunat-bill.client';
import { CdrParserService } from '../cdr/cdr-parser.service';
import { FiscalEnvioRepository } from '../repository/fiscal-envio.repository';

/**
 * Orquesta la Guía de Remisión Remitente (09) por el canal SOAP clásico
 * (mismo patrón que Factura/Boleta/NC, pero con el endpoint propio de GRE —
 * ver fiscal-config.ts). Ver la advertencia de alcance en
 * guia-remision-ubl.builder.ts: la plantilla XML necesita una verificación
 * más antes de un envío real. SUNAT también ofrece una vía REST/OAuth2
 * ("Plataforma Nueva GRE") no implementada aquí todavía.
 */
export class SunatDirectGreProvider implements GreProvider {
  constructor(private readonly fiscalEnvioRepository?: FiscalEnvioRepository) {}

  async emitir(documento: FiscalGreDocument): Promise<FiscalIssueResult> {
    const config = getFiscalConfig();

    if (!config.proveedorHabilitado || config.proveedorActivo !== 'sunat-direct') {
      return { success: false, estado: 'PENDIENTE' };
    }

    let envio = null as any;

    try {
      const xmlResult = await new GuiaRemisionBetaService().emitirGuiaRemisionBeta({
        rucEmisor: documento.supplier.ruc,
        razonSocialEmisor: documento.supplier.razonSocial,
        destinatario: {
          tipoDocumento: documento.customer?.tipoDocumento ?? '6',
          numeroDocumento: documento.customer?.numeroDocumento ?? '',
          razonSocial: documento.customer?.denominacion ?? 'Cliente genérico',
        },
        serie: documento.series,
        numero: documento.number,
        fechaEmision: documento.issueDate,
        motivoTraslado: documento.motivoTraslado ?? CATALOGO_20_MOTIVO_TRASLADO.VENTA,
        modalidadTraslado: documento.modalidadTraslado ?? CATALOGO_21_MODALIDAD_TRASLADO.TRANSPORTE_PRIVADO,
        pesoBrutoTotalKg: documento.pesoBrutoTotalKg ?? 0,
        origenUbigeo: documento.origenUbigeo ?? '',
        origenDireccion: documento.origenDireccion ?? '',
        destinoUbigeo: documento.destinoUbigeo ?? '',
        destinoDireccion: documento.destinoDireccion ?? '',
        fechaInicioTraslado: documento.fechaInicioTraslado ?? documento.issueDate,
        transportista: documento.transportista,
        vehiculoPlaca: documento.vehiculoPlaca,
        conductorNumeroDocumento: documento.conductorNumeroDocumento,
        conductorLicencia: documento.conductorLicencia,
        items: documento.lines.map((line) => ({
          descripcion: line.descripcion,
          cantidad: line.cantidad,
          unidadMedida: line.unidad ?? 'NIU',
          codigoProducto: line.codigoProducto,
        })),
      });

      const nombreArchivo = `${documento.supplier.ruc}-09-${documento.series}-${String(documento.number).padStart(8, '0')}`;

      envio = this.fiscalEnvioRepository
        ? await this.fiscalEnvioRepository.registrar({
            tipo_documento: '09',
            ambiente: config.ambiente,
            proveedor: 'sunat-direct',
            operacion: 'emitir',
            estado: 'GENERANDO_XML',
            intento: 1,
            nombre_archivo: nombreArchivo,
            observaciones: 'Creado antes del envío BETA (GRE).',
          })
        : { id_envio: null };

      const xmlFirmado = await new FacturaBetaFirmaService().firmar(xmlResult.xml);
      const zip = new FacturaBetaZipService().generarZip(xmlFirmado.xmlFirmado, documento.supplier.ruc, '09', documento.series, documento.number);

      if (this.fiscalEnvioRepository && envio?.id_envio) {
        await this.fiscalEnvioRepository.actualizarEstado(envio.id_envio, 'ENVIANDO', {
          observaciones: 'Enviando paquete SOAP de GRE a SUNAT BETA.',
          nombre_archivo: zip.fileName,
        });
      }

      const billClient = new SunatBillClient({
        username: `${documento.supplier.ruc}${process.env.SUNAT_USERNAME_SUFFIX ?? 'MODDATOS'}`,
        password: process.env.SUNAT_PASSWORD ?? 'MODDATOS',
        endpoint: endpointBillServicePorTipo('09', config.ambiente),
        timeoutMs: Number(process.env.SUNAT_TIMEOUT_MS ?? 30000),
      });

      const sendResult = await billClient.sendBill(zip.fileName, zip.zipBase64);
      const cdr = sendResult.ok
        ? new CdrParserService().parse(sendResult.cdrXml ?? sendResult.raw)
        : {
            codigo: sendResult.fault?.faultCode ?? 'ERROR',
            descripcion: sendResult.fault?.faultString ?? sendResult.message,
            observaciones: [sendResult.fault?.faultString ?? sendResult.message],
            estado: 'ERROR_TRANSPORTE' as const,
          };

      const estadoFinal = cdr.estado === 'ACEPTADO' || cdr.estado === 'ACEPTADO_CON_OBSERVACIONES'
        ? cdr.estado
        : cdr.estado === 'RECHAZADO' ? 'RECHAZADO' : 'ERROR_TRANSPORTE';

      if (this.fiscalEnvioRepository && envio?.id_envio) {
        await this.fiscalEnvioRepository.actualizarEstado(envio.id_envio, estadoFinal, {
          codigo_sunat: cdr.codigo,
          mensaje_sunat: cdr.descripcion,
          observaciones: JSON.stringify(cdr.observaciones),
          respuesta_json: { sendBill: sendResult, cdr, fileName: zip.fileName },
          fecha_respuesta: new Date(),
        });
      }

      return {
        success: estadoFinal === 'ACEPTADO' || estadoFinal === 'ACEPTADO_CON_OBSERVACIONES',
        estado: estadoFinal,
        idEnvio: envio?.id_envio ?? undefined,
        codigoSunat: cdr.codigo,
        mensajeSunat: cdr.descripcion,
        observaciones: cdr.observaciones,
        hash: this.sha256(xmlFirmado.xmlFirmado),
      };
    } catch (error: any) {
      if (this.fiscalEnvioRepository && envio?.id_envio) {
        await this.fiscalEnvioRepository.actualizarEstado(envio.id_envio, 'ERROR_TRANSPORTE', {
          ultimo_error: error?.message ?? 'Error inesperado en el flujo BETA de GRE',
        });
      }

      return {
        success: false,
        estado: 'ERROR_TRANSPORTE',
        idEnvio: envio?.id_envio ?? undefined,
        mensajeSunat: error?.message ?? 'Error inesperado en el flujo BETA de GRE.',
      };
    }
  }

  async consultar(idEnvio: number): Promise<FiscalIssueResult> {
    if (!this.fiscalEnvioRepository) {
      return { success: false, estado: 'PENDIENTE' };
    }

    const envios = await this.fiscalEnvioRepository.buscarPorGuia(idEnvio);
    const ultimo = envios[0];
    if (!ultimo) {
      return { success: false, estado: 'PENDIENTE' };
    }

    return {
      success: ultimo.estado === 'ACEPTADO' || ultimo.estado === 'ACEPTADO_CON_OBSERVACIONES',
      estado: (ultimo.estado as any) ?? 'PENDIENTE',
      idEnvio: ultimo.id_envio,
      codigoSunat: ultimo.codigo_sunat,
      mensajeSunat: ultimo.mensaje_sunat,
    };
  }

  private sha256(value: string): string {
    return createHash('sha256').update(value).digest('hex');
  }
}

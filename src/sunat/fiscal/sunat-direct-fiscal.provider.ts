import { createHash } from 'crypto';
import { DocumentoFiscalBase, FiscalProvider, ResultadoPreparacionFiscal } from './fiscal-provider.interface';
import { endpointBillServicePorTipo, getFiscalConfig, AmbienteFiscal } from '../config/fiscal-config';
import { AfectacionIgvTipo, EmitirFacturaBetaDto, FacturaBetaService } from '../factura/factura-beta.service';
import { BoletaBetaService, EmitirBoletaBetaDto } from '../factura/boleta-beta.service';
import { EmitirNotaCreditoBetaDto, NotaCreditoBetaService } from '../factura/nota-credito-beta.service';
import { FacturaBetaFirmaService } from '../factura/factura-beta-firma.service';
import { FacturaBetaZipService } from '../factura/factura-beta-zip.service';
import { SunatBillClient } from './sunat-bill.client';
import { CdrParserService } from '../cdr/cdr-parser.service';
import { FiscalEnvioRepository } from '../repository/fiscal-envio.repository';

/**
 * Orquesta Factura (01), Boleta (03) y Nota de Crédito (07): genera el XML
 * con el builder correcto según documentType, lo firma, lo empaqueta y lo
 * envía por sendBill al mismo webservice de SUNAT (billService) — cambia
 * solo la plantilla UBL, el resto del pipeline es idéntico para los tres.
 * La Guía de Remisión (09) no pasa por aquí: usa su propio endpoint y su
 * propio contrato (ver GreProvider / SunatDirectGreProvider), porque
 * FiscalGreDocument no tiene la misma forma que DocumentoFiscalBase.
 * El Resumen Diario tampoco: es un envío por lote (sendSummary + ticket),
 * no un documento individual (ver ResumenDiarioEnvioService).
 */
export class SunatDirectFiscalProvider implements FiscalProvider {
  constructor(private readonly fiscalEnvioRepository?: FiscalEnvioRepository) {}

  async preparar(documento: DocumentoFiscalBase): Promise<ResultadoPreparacionFiscal> {
    const config = getFiscalConfig();

    if (!config.proveedorHabilitado || config.proveedorActivo !== 'sunat-direct') {
      return {
        ok: false,
        estado: 'PENDIENTE',
        mensaje: 'Proveedor fiscal directo no habilitado explícitamente.',
        codigo: 'SUNAT_DIRECT_DISABLED',
        payload: this.payloadBase(documento, config.ambiente),
      };
    }

    let envio = null as any;

    try {
      const xml = await this.generarXml(documento);

      envio = this.fiscalEnvioRepository
        ? await this.fiscalEnvioRepository.registrar({
            tipo_documento: documento.documentType,
            ambiente: config.ambiente,
            proveedor: 'sunat-direct',
            operacion: 'emitir',
            estado: 'PENDIENTE',
            intento: 1,
            nombre_archivo: this.nombreArchivo(documento),
            observaciones: 'Creado antes del envío BETA.',
          })
        : { id_envio: null };

      if (this.fiscalEnvioRepository && envio?.id_envio) {
        await this.fiscalEnvioRepository.actualizarEstado(envio.id_envio, 'GENERANDO_XML', {
          observaciones: `Generando XML de ${documento.documentType} BETA.`,
        });
        await this.fiscalEnvioRepository.guardarArtefacto({
          id_envio: envio.id_envio,
          tipo_artifacto: 'xml_original',
          storage_key: `${config.ambiente}/xml/${this.nombreArchivo(documento)}.xml`,
          mime: 'application/xml',
          hash: this.sha256(xml),
          size: Buffer.byteLength(xml, 'utf8'),
        });
      }

      const xmlFirmado = await new FacturaBetaFirmaService().firmar(xml);
      if (this.fiscalEnvioRepository && envio?.id_envio) {
        await this.fiscalEnvioRepository.actualizarEstado(envio.id_envio, 'FIRMADO', {
          observaciones: 'XML firmado para BETA.',
        });
        await this.fiscalEnvioRepository.guardarArtefacto({
          id_envio: envio.id_envio,
          tipo_artifacto: 'xml_firmado',
          storage_key: `${config.ambiente}/xml_firmado/${this.nombreArchivo(documento)}.xml`,
          mime: 'application/xml',
          hash: this.sha256(xmlFirmado.xmlFirmado),
          size: Buffer.byteLength(xmlFirmado.xmlFirmado, 'utf8'),
        });
      }

      const zip = new FacturaBetaZipService().generarZip(
        xmlFirmado.xmlFirmado,
        documento.supplier.ruc,
        documento.documentType,
        documento.series,
        documento.number,
      );
      if (this.fiscalEnvioRepository && envio?.id_envio) {
        await this.fiscalEnvioRepository.guardarArtefacto({
          id_envio: envio.id_envio,
          tipo_artifacto: 'zip',
          storage_key: `${config.ambiente}/zip/${zip.fileName}`,
          mime: 'application/zip',
          hash: this.sha256(zip.zipBase64),
          size: Buffer.byteLength(zip.zipBase64, 'utf8'),
        });
      }

      const billClient = new SunatBillClient({
        username: `${documento.supplier.ruc}${process.env.SUNAT_USERNAME_SUFFIX ?? 'MODDATOS'}`,
        password: process.env.SUNAT_PASSWORD ?? 'MODDATOS',
        endpoint: endpointBillServicePorTipo(documento.documentType, config.ambiente),
        timeoutMs: Number(process.env.SUNAT_TIMEOUT_MS ?? 30000),
      });

      if (this.fiscalEnvioRepository && envio?.id_envio) {
        await this.fiscalEnvioRepository.actualizarEstado(envio.id_envio, 'ENVIANDO', {
          observaciones: 'Enviando paquete SOAP a SUNAT BETA.',
          nombre_archivo: zip.fileName,
        });
      }

      const sendResult = await billClient.sendBill(zip.fileName, zip.zipBase64);
      const cdr = sendResult.ok
        ? new CdrParserService().parse(sendResult.cdrXml ?? sendResult.raw)
        : {
            codigo: sendResult.fault?.faultCode ?? 'ERROR',
            descripcion: sendResult.fault?.faultString ?? sendResult.message,
            observaciones: [sendResult.fault?.faultString ?? sendResult.message],
            estado: 'ERROR_TRANSPORTE' as const,
            rawXml: sendResult.raw,
          };

      const finalState = cdr.estado === 'ACEPTADO'
        ? 'ACEPTADO'
        : cdr.estado === 'ACEPTADO_CON_OBSERVACIONES'
          ? 'ACEPTADO_CON_OBSERVACIONES'
          : cdr.estado === 'RECHAZADO'
            ? 'RECHAZADO'
            : 'ERROR_TRANSPORTE';

      if (this.fiscalEnvioRepository && envio?.id_envio) {
        await this.fiscalEnvioRepository.actualizarEstado(envio.id_envio, finalState, {
          codigo_sunat: cdr.codigo,
          mensaje_sunat: cdr.descripcion,
          observaciones: JSON.stringify(cdr.observaciones),
          // sendResult.raw ya viene con el usuario/clave SOL redactados por SunatBillClient.
          respuesta_json: {
            sendBill: sendResult,
            cdr,
            fileName: zip.fileName,
          },
          fecha_respuesta: new Date(),
        });
      }

      return {
        ok: finalState === 'ACEPTADO' || finalState === 'ACEPTADO_CON_OBSERVACIONES',
        estado: finalState,
        mensaje: cdr.descripcion || sendResult.message,
        codigo: cdr.codigo,
        payload: {
          ...this.payloadBase(documento, config.ambiente),
          envioId: envio?.id_envio ?? null,
          fileName: zip.fileName,
          sendBill: sendResult,
          cdr,
        },
      };
    } catch (error: any) {
      if (this.fiscalEnvioRepository && envio?.id_envio) {
        await this.fiscalEnvioRepository.actualizarEstado(envio.id_envio, 'ERROR_TRANSPORTE', {
          ultimo_error: error?.message ?? 'Error inesperado del flujo BETA',
          observaciones: 'Fallo en la orquestación de SUNAT BETA.',
        });
      }

      return {
        ok: false,
        estado: 'ERROR_TRANSPORTE',
        mensaje: error?.message ?? 'Error inesperado en el flujo BETA de SUNAT.',
        codigo: 'SUNAT_DIRECT_FLOW_ERROR',
        payload: {
          ...this.payloadBase(documento, config.ambiente),
          envioId: envio?.id_envio ?? null,
        },
      };
    }
  }

  private async generarXml(documento: DocumentoFiscalBase): Promise<string> {
    switch (documento.documentType) {
      case '01': {
        if (!documento.customer?.numeroDocumento || documento.customer.numeroDocumento.length !== 11) {
          // Antes se rellenaba con un RUC generico inventado ('20123456789') si faltaba el dato.
          // Una Factura sin el RUC real del cliente es fiscalmente invalida: se rechaza en vez de inventar uno.
          throw new Error('La Factura electrónica exige el RUC (11 dígitos) del cliente; no se generó porque el documento no lo trae.');
        }
        const resultado = await new FacturaBetaService().emitirFacturaBeta(this.toFacturaBetaDto(documento));
        return resultado.xml;
      }
      case '03': {
        const resultado = await new BoletaBetaService().emitirBoletaBeta(this.toBoletaBetaDto(documento));
        return resultado.xml;
      }
      case '07': {
        if (!documento.notaCredito) {
          throw new Error('La Nota de Crédito requiere el documento que modifica, el motivo y el sustento (documento.notaCredito).');
        }
        const resultado = await new NotaCreditoBetaService().emitirNotaCreditoBeta(this.toNotaCreditoBetaDto(documento));
        return resultado.xml;
      }
      default:
        throw new Error(`Tipo de documento "${documento.documentType}" no soportado por SunatDirectFiscalProvider (la Guía de Remisión usa SunatDirectGreProvider).`);
    }
  }

  private payloadBase(documento: DocumentoFiscalBase, ambiente: AmbienteFiscal) {
    return {
      provider: 'sunat-direct',
      environment: ambiente,
      documentType: documento.documentType,
      series: documento.series,
      number: documento.number,
    };
  }

  private nombreArchivo(documento: DocumentoFiscalBase): string {
    return `${documento.supplier.ruc}-${documento.documentType}-${documento.series}-${String(documento.number).padStart(8, '0')}`;
  }

  private toFacturaBetaDto(documento: DocumentoFiscalBase): EmitirFacturaBetaDto {
    return {
      rucEmisor: documento.supplier.ruc,
      razonSocialEmisor: documento.supplier.razonSocial,
      direccionEmisor: documento.supplier.direccion ?? '',
      ubigeoEmisor: documento.supplier.ubigeo ?? '',
      rucCliente: documento.customer!.numeroDocumento!,
      razonSocialCliente: documento.customer?.denominacion ?? 'Cliente genérico',
      direccionCliente: documento.customer?.direccion,
      serie: documento.series,
      numero: documento.number,
      fechaEmision: documento.issueDate,
      horaEmision: documento.issueTime,
      moneda: documento.currency,
      tipoOperacion: '0101',
      items: documento.lines.map((line) => ({
        descripcion: line.descripcion,
        cantidad: line.cantidad,
        unidadMedida: line.unidad ?? 'NIU',
        precioUnitario: line.precioUnitario,
        afectacionIgv: this.mapAfectacion(line.afectacionIgv),
        descuento: Number(line.descuento ?? 0),
      })),
    };
  }

  private toBoletaBetaDto(documento: DocumentoFiscalBase): EmitirBoletaBetaDto {
    return {
      rucEmisor: documento.supplier.ruc,
      razonSocialEmisor: documento.supplier.razonSocial,
      direccionEmisor: documento.supplier.direccion ?? '',
      ubigeoEmisor: documento.supplier.ubigeo ?? '',
      tipoDocumentoCliente: (documento.customer?.tipoDocumento as any) ?? '0',
      numeroDocumentoCliente: documento.customer?.numeroDocumento ?? '',
      denominacionCliente: documento.customer?.denominacion ?? 'Cliente varios',
      direccionCliente: documento.customer?.direccion,
      serie: documento.series,
      numero: documento.number,
      fechaEmision: documento.issueDate,
      horaEmision: documento.issueTime,
      moneda: documento.currency,
      items: documento.lines.map((line) => ({
        descripcion: line.descripcion,
        cantidad: line.cantidad,
        unidadMedida: line.unidad ?? 'NIU',
        precioUnitario: line.precioUnitario,
        afectacionIgv: this.mapAfectacion(line.afectacionIgv),
        descuento: Number(line.descuento ?? 0),
      })),
    };
  }

  private toNotaCreditoBetaDto(documento: DocumentoFiscalBase): EmitirNotaCreditoBetaDto {
    const referencia = documento.notaCredito!;
    return {
      rucEmisor: documento.supplier.ruc,
      razonSocialEmisor: documento.supplier.razonSocial,
      direccionEmisor: documento.supplier.direccion ?? '',
      ubigeoEmisor: documento.supplier.ubigeo ?? '',
      tipoDocumentoCliente: (documento.customer?.tipoDocumento as any) ?? '6',
      numeroDocumentoCliente: documento.customer?.numeroDocumento ?? '',
      razonSocialCliente: documento.customer?.denominacion ?? 'Cliente genérico',
      serie: documento.series,
      numero: documento.number,
      fechaEmision: documento.issueDate,
      horaEmision: documento.issueTime,
      moneda: documento.currency,
      documentoModificado: {
        tipoDocumento: referencia.documentoModificado.tipoDocumento,
        serie: referencia.documentoModificado.series,
        numero: referencia.documentoModificado.number,
      },
      motivo: referencia.motivo as any,
      sustento: referencia.sustento,
      items: documento.lines.map((line) => ({
        descripcion: line.descripcion,
        cantidad: line.cantidad,
        unidadMedida: line.unidad ?? 'NIU',
        precioUnitario: line.precioUnitario,
        afectacionIgv: this.mapAfectacion(line.afectacionIgv),
        descuento: Number(line.descuento ?? 0),
      })),
    };
  }

  private mapAfectacion(afectacion?: '10' | '20' | '30' | '40'): AfectacionIgvTipo {
    switch (afectacion) {
      case '20':
        return 'exonerado';
      case '30':
      case '40':
        return 'inafecto';
      default:
        return 'gravado';
    }
  }

  private sha256(value: string): string {
    return createHash('sha256').update(value).digest('hex');
  }
}

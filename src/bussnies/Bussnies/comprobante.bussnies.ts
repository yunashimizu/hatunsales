import {
  Injectable,
  BadRequestException,
  ServiceUnavailableException,
  NotFoundException,
} from '@nestjs/common';
import axios from 'axios';
import { ComprobanteRepository } from '../../repository/Repository/comprobante.repository';
import { nubefactConfig } from '../../config/nubefact.config';
import { sunatConfig } from '../../config/sunat.config';
import {
  GenerarComprobanteRequest,
  ConsultarComprobanteRequest,
  AnularComprobanteRequest,
} from '../../models/model/c-electronico/comprobante.request';
import { ComprobanteResponse, AnulacionResponse } from '../../models/model/c-electronico/comprobante.response';
import { IComprobanteBussniees } from '../Ibussnies/IComprobanteBussniees';
import { Comprobante } from '../../models/DBModel/c-electronico/comprobante.entity';

@Injectable()
export class ComprobanteBussnies implements IComprobanteBussniees {

  constructor(private readonly repo: ComprobanteRepository) {}

  private get headers() {
    return {
      'Content-Type':  'application/json; charset=utf-8',
      'Authorization': `Token token=${nubefactConfig.token}`,
    };
  }

  // ── GENERAR ──────────────────────────────────────────────────

  async generar(dto: GenerarComprobanteRequest): Promise<ComprobanteResponse> {

    dto.serie = this.normalizarSerie(dto.serie, dto.id_tipo);
    dto.numero = this.normalizarNumero(dto.numero);

    if (!dto.fecha_de_emision) {
      dto.fecha_de_emision = this.getFechaActual();
    }

    // ── RESOLVER RECEPTOR ────────────────────────────────────────
    // prioridad: dni > ruc > id_cliente > id_empresa

    // CASO 1: viene DNI → SUNAT → guarda/actualiza en clientes
    if (dto.dni) {
      if (dto.dni.length !== 8) {
        throw new BadRequestException('El DNI debe tener exactamente 8 dígitos');
      }

      let cliente = await this.repo.buscarClientePorDni(Number(dto.dni));

      if (!cliente) {
        try {
          const { data } = await axios.get(
            `${sunatConfig.dniUrl}/${dto.dni}?token=${sunatConfig.token}`
          );
          if (!data?.success) throw new BadRequestException('DNI no encontrado en SUNAT');

          cliente = await this.repo.guardarCliente({
            dni:              Number(dto.dni),
            nombre:           data.nombres,
            apellido_paterno: data.apellidoPaterno,
            apellido_materno: data.apellidoMaterno,
          });
        } catch (error: any) {
          if (error instanceof BadRequestException) throw error;
          throw new ServiceUnavailableException('Error al consultar SUNAT para DNI');
        }
      }

      dto.id_cliente           = cliente.id_cliente;
      dto.cliente_tipo_doc     = 1;
      dto.cliente_numero_doc   = String(cliente.dni);
      dto.cliente_denominacion = `${cliente.nombre ?? ''} ${cliente.apellido_paterno ?? ''} ${cliente.apellido_materno ?? ''}`.trim();
      dto.cliente_direccion    = cliente.direccion ?? '';
      dto.cliente_email        = cliente.email ?? '';
    }

    // CASO 2: viene RUC → SUNAT → guarda/actualiza en empresas
    else if (dto.ruc) {
      if (dto.ruc.length !== 11) {
        throw new BadRequestException('El RUC debe tener exactamente 11 dígitos');
      }

      let empresa = await this.repo.buscarEmpresaPorRuc(dto.ruc);

      if (!empresa) {
        try {
          const { data } = await axios.get(
            `${sunatConfig.rucUrl}/${dto.ruc}?token=${sunatConfig.token}`
          );
          if (!data?.razonSocial) throw new BadRequestException('RUC no encontrado en SUNAT');

          empresa = await this.repo.guardarEmpresa({
            ruc:               dto.ruc,
            razon_social:      data.razonSocial ?? '',
            nombre_comercial:  data.nombreComercial ?? '',
            telefonos:         Array.isArray(data.telefonos) ? data.telefonos.join(',') : '',
            tipo:              data.tipo ?? '',
            estado:            data.estado ?? '',
            condicion:         data.condicion ?? '',
            direccion:         data.direccion ?? '',
            departamento:      data.departamento ?? '',
            provincia:         data.provincia ?? '',
            distrito:          data.distrito ?? '',
            ubigeo:            data.ubigeo ?? '',
            capital:           data.capital ?? '',
            fecha_inscripcion: data.fechaInscripcion ?? '',
            fecha_baja:        data.fechaBaja ?? '',
          });
        } catch (error: any) {
          if (error instanceof BadRequestException) throw error;
          throw new ServiceUnavailableException('Error al consultar SUNAT para RUC');
        }
      }

      dto.id_empresa           = empresa.id_empresa;
      dto.cliente_tipo_doc     = 6;
      dto.cliente_numero_doc   = empresa.ruc;
      dto.cliente_denominacion = empresa.razon_social ?? '';
      dto.cliente_direccion    = empresa.direccion ?? '';
      dto.cliente_email        = '';
    }

    // CASO 3: viene id_cliente → jala de BD directo sin llamar SUNAT
    else if (dto.id_cliente) {
      const cliente = await this.repo.buscarClientePorId(dto.id_cliente);
      if (!cliente) throw new BadRequestException(`Cliente ${dto.id_cliente} no encontrado en BD`);

      dto.cliente_tipo_doc     = 1;
      dto.cliente_numero_doc   = String(cliente.dni);
      dto.cliente_denominacion = `${cliente.nombre ?? ''} ${cliente.apellido_paterno ?? ''} ${cliente.apellido_materno ?? ''}`.trim();
      dto.cliente_direccion    = cliente.direccion ?? '';
      dto.cliente_email        = cliente.email ?? '';
    }

    // CASO 4: viene id_empresa → jala de BD directo sin llamar SUNAT
    else if (dto.id_empresa) {
      const empresa = await this.repo.buscarEmpresaPorId(dto.id_empresa);
      if (!empresa) throw new BadRequestException(`Empresa ${dto.id_empresa} no encontrada en BD`);

      dto.cliente_tipo_doc     = 6;
      dto.cliente_numero_doc   = empresa.ruc;
      dto.cliente_denominacion = empresa.razon_social ?? '';
      dto.cliente_direccion    = empresa.direccion ?? '';
      dto.cliente_email        = '';
    }

    else {
      throw new BadRequestException(
        'Debes enviar uno de: dni, ruc, id_cliente o id_empresa'
      );
    }

    // validación final
    if (!dto.cliente_tipo_doc || !dto.cliente_numero_doc || !dto.cliente_denominacion) {
      throw new BadRequestException('No se pudieron obtener los datos del receptor del comprobante');
    }

    if (dto.id_tipo === 1 && dto.cliente_tipo_doc === 1) {
      throw new BadRequestException('Factura no puede emitirse a un cliente con DNI; use Boleta o un cliente con RUC');
    }

    if (dto.id_tipo === 1 && !dto.serie?.toUpperCase().startsWith('F')) {
      throw new BadRequestException("Serie de factura inválida. Debe comenzar con 'F'");
    }

    if (dto.id_tipo === 2 && !dto.serie?.toUpperCase().startsWith('B')) {
      throw new BadRequestException("Serie de boleta inválida. Debe comenzar con 'B'");
    }

    const payload = this.buildPayload(dto);

    try {
      const { data } = await axios.post(nubefactConfig.url, payload, {
        headers: this.headers,
      });

      if (data.errors) {
        throw new BadRequestException(`Nubefact: ${data.errors}`);
      }

      const guardado = await this.repo.guardarConItems(
        {
          id_venta:             dto.id_venta,
          cliente:              dto.id_cliente ? { id_cliente: dto.id_cliente } as any : undefined,
          tipo:                 { id_tipo: dto.id_tipo } as any,
          moneda:               { id_moneda: dto.id_moneda ?? 1 } as any,
          serie:                dto.serie,
          numero:               dto.numero,
          sunat_transaction:    1,
          cliente_tipo_doc:     dto.cliente_tipo_doc,
          cliente_numero_doc:   dto.cliente_numero_doc,
          cliente_denominacion: dto.cliente_denominacion,
          cliente_direccion:    dto.cliente_direccion ?? '',
          cliente_email:        dto.cliente_email ?? '',
          fecha_de_emision:     dto.fecha_de_emision,
          fecha_de_vencimiento: dto.fecha_de_vencimiento ?? '',
          porcentaje_igv:       18.00,
          total_gravada:        dto.total_gravada,
          total_igv:            dto.total_igv,
          total:                dto.total,
          observaciones:        dto.observaciones ?? '',
          enviar_sunat:         dto.enviar_sunat ?? true,
          enviar_cliente:       dto.enviar_cliente ?? false,
          enlace:               data.enlace ?? '',
          enlace_pdf:           data.enlace_del_pdf ?? '',
          enlace_xml:           data.enlace_del_xml ?? '',
          enlace_cdr:           data.enlace_del_cdr ?? '',
          aceptada_sunat:       data.aceptada_por_sunat ?? false,
          sunat_description:    data.sunat_description ?? '',
          sunat_responsecode:   data.sunat_responsecode ?? '',
          sunat_soap_error:     data.sunat_soap_error ?? '',
          cadena_qr:            data.cadena_para_codigo_qr ?? '',
          codigo_hash:          data.codigo_hash ?? '',
        },
        dto.items.map((i) => ({
          id_producto:           i.id_producto,
          unidad_de_medida:      i.unidad_de_medida,
          codigo:                i.codigo,
          codigo_producto_sunat: i.codigo_producto_sunat ?? '10000000',
          descripcion:           i.descripcion,
          cantidad:              i.cantidad,
          valor_unitario:        i.valor_unitario,
          precio_unitario:       i.precio_unitario,
          subtotal:              i.subtotal,
          tipo_de_igv:           i.tipo_de_igv,
          igv:                   i.igv,
          total:                 i.total,
        })),
      );

      return this.mapRespuesta(data, guardado.id_comprobante);

    } catch (error: any) {
      if (error instanceof BadRequestException) throw error;
      const msg = this.extraerMensajeNubefact(error);
      throw new ServiceUnavailableException(msg);
    }
  }

  // ── CONSULTAR ────────────────────────────────────────────────

  async consultar(dto: ConsultarComprobanteRequest): Promise<ComprobanteResponse> {
    const payload = {
      operacion:           'consultar_comprobante',
      tipo_de_comprobante: dto.tipo_de_comprobante,
      serie:               dto.serie,
      numero:              dto.numero,
    };

    try {
      const { data } = await axios.post(nubefactConfig.url, payload, {
        headers: this.headers,
      });

      const enBD = await this.repo.buscarPorSerieNumero(dto.serie, dto.numero);
      if (enBD) {
        await this.repo.actualizarRespuesta(enBD.id_comprobante, {
          aceptada_sunat:    data.aceptada_por_sunat,
          sunat_description: data.sunat_description,
          anulado:           data.anulado ?? false,
        });
      }

      return this.mapRespuesta(data, enBD?.id_comprobante);

    } catch (error: any) {
      const msg = error?.response?.data?.errors ?? error?.message ?? 'Error al consultar en Nubefact';
      throw new ServiceUnavailableException(msg);
    }
  }

  // ── ANULAR ───────────────────────────────────────────────────

  async anular(dto: AnularComprobanteRequest): Promise<AnulacionResponse> {
    const enBD = await this.repo.buscarPorSerieNumero(dto.serie, dto.numero);
    if (!enBD) throw new NotFoundException('Comprobante no encontrado en BD');
    if (enBD.anulado) throw new BadRequestException('El comprobante ya fue anulado');

    const payload = {
      operacion:           'generar_anulacion',
      tipo_de_comprobante: dto.tipo_de_comprobante,
      serie:               dto.serie,
      numero:              dto.numero,
      motivo:              dto.motivo,
      codigo_unico:        '',
    };

    try {
      const { data } = await axios.post(nubefactConfig.url, payload, {
        headers: this.headers,
      });

      await this.repo.actualizarRespuesta(enBD.id_comprobante, {
        anulado:          true,
        motivo_anulacion: dto.motivo,
        sunat_ticket:     data.sunat_ticket_numero ?? '',
      });

      return this.mapAnulacion(data);

    } catch (error: any) {
      const msg = error?.response?.data?.errors ?? error?.message ?? 'Error al anular en Nubefact';
      throw new ServiceUnavailableException(msg);
    }
  }

  // ── CONSULTAR ANULACIÓN ──────────────────────────────────────

  async consultarAnulacion(dto: ConsultarComprobanteRequest): Promise<AnulacionResponse> {
    const payload = {
      operacion:           'consultar_anulacion',
      tipo_de_comprobante: dto.tipo_de_comprobante,
      serie:               dto.serie,
      numero:              dto.numero,
    };

    try {
      const { data } = await axios.post(nubefactConfig.url, payload, {
        headers: this.headers,
      });

      return this.mapAnulacion(data);

    } catch (error: any) {
      const msg = error?.response?.data?.errors ?? error?.message ?? 'Error al consultar anulación';
      throw new ServiceUnavailableException(msg);
    }
  }

  // ── LISTAR ───────────────────────────────────────────────────

  async listarPorVenta(id_venta: number): Promise<ComprobanteResponse[]> {
    const lista = await this.repo.listarPorVenta(id_venta);
    return lista.map((c) => this.mapComprobante(c));
  }

  async listarPorCliente(id_cliente: number): Promise<ComprobanteResponse[]> {
    const lista = await this.repo.listarPorCliente(id_cliente);
    return lista.map((c) => this.mapComprobante(c));
  }

  async obtenerPorId(id_comprobante: number): Promise<ComprobanteResponse> {
    const c = await this.repo.buscarPorId(id_comprobante);
    if (!c) throw new NotFoundException('Comprobante no encontrado');
    return this.mapComprobante(c);
  }

  async obtenerPdfBuffer(id_comprobante: number): Promise<Buffer> {
    const c = await this.repo.buscarPorId(id_comprobante);
    if (!c) throw new NotFoundException('Comprobante no encontrado');
    if (!c.enlace_pdf) throw new NotFoundException('No hay PDF disponible para este comprobante');

    try {
      const resp = await axios.get(c.enlace_pdf, { responseType: 'arraybuffer' });
      return Buffer.from(resp.data);
    } catch (error: any) {
      throw new ServiceUnavailableException('Error al descargar el PDF del proveedor');
    }
  }

  // ── Build payload ────────────────────────────────────────────

  private buildPayload(dto: GenerarComprobanteRequest): object {
    const items = dto.items.map((i) => {
      const valorUnitario = Number(Number(i.valor_unitario ?? i.precio_unitario ?? 0).toFixed(2));
      const precioUnitario = Number((valorUnitario * 1.18).toFixed(2));
      const subtotal = Number((valorUnitario * Number(i.cantidad ?? 1)).toFixed(2));
      const igv = Number((subtotal * 0.18).toFixed(2));
      const total = Number((subtotal + igv).toFixed(2));

      return {
        unidad_de_medida:          i.unidad_de_medida ?? 'NIU',
        codigo:                    i.codigo ?? '',
        codigo_producto_sunat:     i.codigo_producto_sunat ?? '10000000',
        descripcion:               i.descripcion ?? 'Producto',
        cantidad:                  Number(i.cantidad ?? 1),
        valor_unitario:            valorUnitario,
        precio_unitario:           precioUnitario,
        descuento:                 0,
        subtotal:                  subtotal,
        tipo_de_igv:               i.tipo_de_igv ?? 1,
        igv:                       igv,
        total:                     total,
        anticipo_regularizacion:   false,
        anticipo_documento_serie:  '',
        anticipo_documento_numero: '',
      };
    });

    return {
      operacion:                         'generar_comprobante',
      tipo_de_comprobante:               this.mapTipoComprobante(dto.id_tipo),
      serie:                             dto.serie,
      numero:                            dto.numero,
      sunat_transaction:                 1,
      cliente_tipo_de_documento:         this.mapClienteTipoDeDocumento(dto.cliente_tipo_doc),
      cliente_numero_de_documento:       String(dto.cliente_numero_doc ?? ''),
      cliente_denominacion:              dto.cliente_denominacion ?? '',
      cliente_direccion:                 dto.cliente_direccion ?? '',
      cliente_email:                     dto.cliente_email ?? '',
      cliente_email_1:                   '',
      cliente_email_2:                   '',
      fecha_de_emision:                  dto.fecha_de_emision,
      fecha_de_vencimiento:              dto.fecha_de_vencimiento ?? '',
      moneda:                            this.mapMoneda(dto.id_moneda),
      tipo_de_cambio:                    '',
      porcentaje_de_igv:                 18.00,
      descuento_global:                  0,
      total_descuento:                   0,
      total_anticipo:                    0,
      total_gravada:                     Number(dto.total_gravada ?? 0),
      total_inafecta:                    0,
      total_exonerada:                   0,
      total_igv:                         Number(dto.total_igv ?? 0),
      total_gratuita:                    0,
      total_otros_cargos:                0,
      total:                             Number(dto.total ?? 0),
      percepcion_tipo:                   '',
      percepcion_base_imponible:         0,
      total_percepcion:                  0,
      total_incluido_percepcion:         0,
      detraccion:                        false,
      observaciones:                     dto.observaciones ?? '',
      documento_que_se_modifica_tipo:    dto.documento_que_se_modifica_tipo ?? '',
      documento_que_se_modifica_serie:   dto.documento_que_se_modifica_serie ?? '',
      documento_que_se_modifica_numero:  dto.documento_que_se_modifica_numero ?? '',
      tipo_de_nota_de_credito:           this.getTipoNotaCredito(dto),
      tipo_de_nota_de_debito:            this.getTipoNotaDebito(dto),
      enviar_automaticamente_a_la_sunat: dto.enviar_sunat ?? true,
      enviar_automaticamente_al_cliente: dto.enviar_cliente ?? false,
      condiciones_de_pago:               '',
      medio_de_pago:                     '',
      placa_vehiculo:                    '',
      orden_compra_servicio:             '',
      formato_de_pdf:                    '',
      generado_por_contingencia:         '',
      items,
    };
  }

  // ── Fecha actual DD-MM-YYYY ──────────────────────────────────

  private getFechaActual(): string {
    const hoy = new Date();
    return hoy.toISOString().slice(0, 10);
  }

  private normalizarSerie(serie?: string, idTipo?: number): string {
    const defaultSerie = idTipo === 1 ? 'F001' : idTipo === 2 ? 'B001' : idTipo === 7 ? 'FC01' : idTipo === 8 ? 'FD01' : 'B001';
    const base = (serie ?? defaultSerie).toString().trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    return base || defaultSerie;
  }

  private normalizarNumero(numero?: number): number {
    const numeric = Number(numero ?? 1);
    if (!Number.isFinite(numeric) || numeric <= 0) return 1;
    return Math.min(99999999, Math.floor(numeric));
  }

  private mapTipoComprobante(idTipo?: number): string {
    if (idTipo === 1) return '01';
    if (idTipo === 2) return '03';
    if (idTipo === 7) return '07';
    if (idTipo === 8) return '08';
    return '03';
  }

  private mapClienteTipoDeDocumento(tipoDoc?: number): string {
    return tipoDoc === 6 ? '6' : '1';
  }

  private mapMoneda(idMoneda?: number): number {
    if (idMoneda === 2) return 2;
    if (idMoneda === 3) return 3;
    if (idMoneda === 4) return 4;
    return 1;
  }

  private getTipoNotaCredito(dto: GenerarComprobanteRequest): string {
    if (dto.id_tipo !== 7) return '';
    return dto.tipo_de_nota_de_credito?.trim() || '10';
  }

  private getTipoNotaDebito(dto: GenerarComprobanteRequest): string {
    if (dto.id_tipo !== 8) return '';
    return dto.tipo_de_nota_de_debito?.trim() || '1';
  }

  private extraerMensajeNubefact(error: any): string {
    const data = error?.response?.data;
    if (typeof data === 'string') return data;
    if (Array.isArray(data?.errors)) return data.errors.join(', ');
    if (typeof data?.errors === 'string') return data.errors;
    if (typeof data?.message === 'string') return data.message;
    if (typeof data?.error === 'string') return data.error;
    if (typeof error?.message === 'string') return error.message;
    return 'Error al conectar con Nubefact';
  }

  // ── Mappers ──────────────────────────────────────────────────

  private mapRespuesta(data: any, id_comprobante?: number): ComprobanteResponse {
    return {
      id_comprobante,
      tipo_de_comprobante: data.tipo_de_comprobante,
      serie:               data.serie,
      numero:              data.numero,
      enlace:              data.enlace,
      enlace_pdf:          data.enlace_del_pdf,
      enlace_xml:          data.enlace_del_xml,
      enlace_cdr:          data.enlace_del_cdr,
      aceptada_sunat:      data.aceptada_por_sunat,
      sunat_description:   data.sunat_description,
      sunat_responsecode:  data.sunat_responsecode,
      cadena_qr:           data.cadena_para_codigo_qr,
      codigo_hash:         data.codigo_hash,
      anulado:             data.anulado ?? false,
    };
  }

  private mapAnulacion(data: any): AnulacionResponse {
    return {
      numero:            data.numero,
      enlace:            data.enlace,
      sunat_ticket:      data.sunat_ticket_numero,
      aceptada_sunat:    data.aceptada_por_sunat,
      sunat_description: data.sunat_description,
      enlace_pdf:        data.enlace_del_pdf,
      enlace_xml:        data.enlace_del_xml,
      enlace_cdr:        data.enlace_del_cdr,
    };
  }

  private mapComprobante(c: Comprobante): ComprobanteResponse {
    return {
      id_comprobante:      c.id_comprobante,
      tipo_de_comprobante: c.tipo?.id_tipo,
      serie:               c.serie,
      numero:              c.numero,
      enlace:              c.enlace,
      enlace_pdf:          c.enlace_pdf,
      enlace_xml:          c.enlace_xml,
      enlace_cdr:          c.enlace_cdr,
      aceptada_sunat:      c.aceptada_sunat,
      sunat_description:   c.sunat_description,
      sunat_responsecode:  c.sunat_responsecode,
      cadena_qr:           c.cadena_qr,
      codigo_hash:         c.codigo_hash,
      anulado:             c.anulado,
    };
  }
}
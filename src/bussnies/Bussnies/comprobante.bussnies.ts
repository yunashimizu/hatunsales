import {
  Injectable,
  Logger,
  BadRequestException,
  ServiceUnavailableException,
  NotFoundException,
} from '@nestjs/common';
import axios from 'axios';
import { ComprobanteRepository, FiltroComprobantes } from '../../repository/Repository/comprobante.repository';
import { ConfiguracionRepository } from '../../repository/Repository/configuracion.repository';
import { ReceptorBussnies, TOPE_BOLETA_SIN_DOCUMENTO } from './receptor.bussnies';
import { nubefactConfig } from '../../config/nubefact.config';
import { emisorConfig } from '../../config/emisor.config';
import {
  GenerarComprobanteRequest,
  ConsultarComprobanteRequest,
  AnularComprobanteRequest,
  ItemComprobanteRequest,
} from '../../models/model/c-electronico/comprobante.request';
import {
  ComprobanteResponse,
  AnulacionResponse,
  ComprobanteListadoResponse,
  PreviewComprobanteResponse,
  ItemPreviewResponse,
} from '../../models/model/c-electronico/comprobante.response';
import { ReceptorResponse } from '../../models/model/receptor.response';
import { IComprobanteBussniees } from '../Ibussnies/IComprobanteBussniees';
import { Comprobante } from '../../models/DBModel/c-electronico/comprobante.entity';
import {
  calcularComprobante,
  ResumenFiscal,
  PORCENTAJE_IGV_POR_DEFECTO,
  redondear,
} from '../../util/fiscal/calculo-fiscal';
import { numeroALetras } from '../../util/fiscal/numero-letras';
import {
  esNota,
  normalizarSerie,
  nombreTipoComprobante,
  tipoComprobanteNubefact,
  tipoComprobanteSunat,
  tipoDocumentoNubefact,
  monedaNubefact,
  MOTIVOS_NOTA_CREDITO,
  MOTIVOS_NOTA_DEBITO,
  TIPO_FACTURA,
  TIPO_BOLETA,
  TIPO_NOTA_CREDITO,
  TIPO_NOTA_DEBITO,
  TIPO_DOC_RUC,
} from '../../util/fiscal/nubefact.catalogo';

const TIEMPO_LIMITE_MS = 30_000;

const MONEDAS: Record<number, { nombre: string; simbolo: string }> = {
  1: { nombre: 'SOLES', simbolo: 'S/' },
  2: { nombre: 'DOLARES AMERICANOS', simbolo: 'US$' },
  3: { nombre: 'EUROS', simbolo: '€' },
  4: { nombre: 'LIBRAS ESTERLINAS', simbolo: '£' },
};

/** Resultado de preparar un comprobante, compartido entre vista previa y emisión. */
interface ComprobantePreparado {
  dto: GenerarComprobanteRequest;
  receptor: ReceptorResponse;
  resumen: ResumenFiscal;
  items: ItemPreviewResponse[];
  serie: string;
  fechaEmision: string;
  fechaVencimiento: string;
  idMoneda: number;
  importeEnLetras: string;
  advertencias: string[];
}

@Injectable()
export class ComprobanteBussnies implements IComprobanteBussniees {

  private readonly logger = new Logger(ComprobanteBussnies.name);

  constructor(
    private readonly repo: ComprobanteRepository,
    private readonly receptorBussnies: ReceptorBussnies,
    private readonly config: ConfiguracionRepository,
  ) {}

  /**
   * NUBEFACT espera el token tal cual en la cabecera. El prefijo "Token token="
   * pertenece a otra convención y hace que la solicitud sea rechazada.
   */
  private get headers() {
    return {
      'Content-Type': 'application/json; charset=utf-8',
      Authorization: nubefactConfig.token,
    };
  }

  // ── Vista previa ─────────────────────────────────────────────

  /** Calcula el comprobante completo sin enviarlo ni consumir correlativo. */
  async previsualizar(dto: GenerarComprobanteRequest): Promise<PreviewComprobanteResponse> {
    const preparado = await this.preparar(dto, { guardarReceptor: false });
    const numero = dto.numero && dto.numero > 0
      ? dto.numero
      : (await this.repo.buscarUltimoNumeroPorSerie(preparado.serie)) + 1;

    const emisor = await this.emisor();
    const moneda = MONEDAS[preparado.idMoneda] ?? MONEDAS[1];

    return {
      emisor,
      id_tipo: dto.id_tipo,
      tipo_nombre: nombreTipoComprobante(dto.id_tipo),
      serie: preparado.serie,
      numero,
      numero_formateado: this.formatearNumero(preparado.serie, numero),
      fecha_de_emision: preparado.fechaEmision,
      fecha_de_vencimiento: preparado.fechaVencimiento,
      moneda: { id_moneda: preparado.idMoneda, ...moneda },
      receptor: preparado.receptor,
      items: preparado.items,
      porcentaje_igv: preparado.resumen.porcentaje_igv,
      totales: {
        gravada: preparado.resumen.total_gravada,
        exonerada: preparado.resumen.total_exonerada,
        inafecta: preparado.resumen.total_inafecta,
        descuento: preparado.resumen.total_descuento,
        igv: preparado.resumen.total_igv,
        total: preparado.resumen.total,
      },
      importe_en_letras: preparado.importeEnLetras,
      observaciones: dto.observaciones ?? '',
      nota: this.datosNota(dto),
      advertencias: preparado.advertencias,
      json_nubefact: this.construirPayload(preparado, numero),
    };
  }

  // ── Emitir ───────────────────────────────────────────────────

  async generar(dto: GenerarComprobanteRequest): Promise<ComprobanteResponse> {
    const preparado = await this.preparar(dto, { guardarReceptor: true });

    // El correlativo se toma dentro de una transacción con bloqueo, así dos
    // cajas emitiendo a la vez no se pisan el número.
    const comprobante = await this.reservar(preparado, dto.numero);
    const payload = this.construirPayload(preparado, comprobante.numero);

    let data: any;
    try {
      const respuesta = await axios.post(nubefactConfig.url, payload, {
        headers: this.headers,
        timeout: TIEMPO_LIMITE_MS,
      });
      data = respuesta.data;
    } catch (error: any) {
      const mensaje = this.extraerMensajeNubefact(error);
      await this.repo.marcarError(comprobante.id_comprobante, mensaje);
      this.logger.error(`Envío fallido de ${preparado.serie}-${comprobante.numero}: ${mensaje}`);
      throw new ServiceUnavailableException(mensaje);
    }

    // NUBEFACT responde 200 aun cuando rechaza, con el detalle en `errors`.
    if (data?.errors) {
      const mensaje = Array.isArray(data.errors) ? data.errors.join(', ') : String(data.errors);
      await this.repo.marcarError(comprobante.id_comprobante, mensaje);
      throw new BadRequestException(mensaje);
    }

    await this.repo.actualizarRespuesta(comprobante.id_comprobante, {
      estado: 'emitido',
      error_mensaje: undefined,
      enlace: data.enlace ?? '',
      enlace_pdf: data.enlace_del_pdf ?? '',
      enlace_xml: data.enlace_del_xml ?? '',
      enlace_cdr: data.enlace_del_cdr ?? '',
      aceptada_sunat: data.aceptada_por_sunat ?? false,
      sunat_description: data.sunat_description ?? '',
      sunat_responsecode: String(data.sunat_responsecode ?? ''),
      sunat_soap_error: data.sunat_soap_error ?? '',
      cadena_qr: data.cadena_para_codigo_qr ?? '',
      codigo_hash: data.codigo_hash ?? '',
    });

    return {
      ...this.mapRespuesta(data, comprobante.id_comprobante),
      serie: preparado.serie,
      numero: comprobante.numero,
      numero_formateado: this.formatearNumero(preparado.serie, comprobante.numero),
      estado: 'emitido',
    };
  }

  /** Reintenta un comprobante que quedó en error o pendiente, sin gastar otro número. */
  async reintentar(id_comprobante: number): Promise<ComprobanteResponse> {
    const guardado = await this.repo.buscarPorId(id_comprobante);
    if (!guardado) throw new NotFoundException('Comprobante no encontrado');
    if (guardado.estado === 'emitido') {
      throw new BadRequestException('El comprobante ya fue emitido correctamente');
    }

    // Puede que NUBEFACT sí lo haya recibido y solo se perdiera la respuesta.
    const yaExiste = await this.consultarEnNubefact(
      guardado.tipo?.id_tipo ?? TIPO_BOLETA,
      guardado.serie,
      guardado.numero,
    );

    if (yaExiste && !yaExiste.errors) {
      await this.repo.actualizarRespuesta(id_comprobante, {
        estado: 'emitido',
        error_mensaje: undefined,
        enlace: yaExiste.enlace ?? '',
        enlace_pdf: yaExiste.enlace_del_pdf ?? '',
        enlace_xml: yaExiste.enlace_del_xml ?? '',
        aceptada_sunat: yaExiste.aceptada_por_sunat ?? false,
        sunat_description: yaExiste.sunat_description ?? '',
        cadena_qr: yaExiste.cadena_para_codigo_qr ?? '',
        codigo_hash: yaExiste.codigo_hash ?? '',
      });
      return { ...this.mapRespuesta(yaExiste, id_comprobante), estado: 'emitido' };
    }

    throw new BadRequestException(
      'El comprobante no llegó a registrarse en NUBEFACT. Corrija los datos y emita uno nuevo.',
    );
  }

  // ── Preparación compartida ───────────────────────────────────

  private async preparar(
    dto: GenerarComprobanteRequest,
    opciones: { guardarReceptor: boolean },
  ): Promise<ComprobantePreparado> {
    if (!Array.isArray(dto.items) || dto.items.length === 0) {
      throw new BadRequestException('El comprobante debe tener al menos un producto');
    }

    const advertencias: string[] = [];
    const receptor = await this.resolverReceptor(dto, opciones.guardarReceptor);
    if (receptor.advertencia) advertencias.push(receptor.advertencia);

    const porcentajeIgv = await this.config.obtenerNumero(
      'tienda_igv_porcentaje',
      PORCENTAJE_IGV_POR_DEFECTO,
    );

    const resumen = calcularComprobante(
      dto.items.map((item) => this.aLineaFiscal(item, porcentajeIgv)),
      porcentajeIgv,
    );

    if (resumen.total <= 0) {
      throw new BadRequestException('El total del comprobante debe ser mayor a cero');
    }

    const serieModificada = dto.documento_que_se_modifica_serie;
    const serie = normalizarSerie(dto.serie, dto.id_tipo, serieModificada);

    this.validar(dto, receptor, resumen, serie);

    const idMoneda = monedaNubefact(dto.id_moneda);
    const fechaEmision = this.normalizarFecha(dto.fecha_de_emision);

    return {
      dto,
      receptor,
      resumen,
      items: this.armarItems(dto.items, resumen),
      serie,
      fechaEmision,
      fechaVencimiento: this.normalizarFecha(dto.fecha_de_vencimiento ?? dto.fecha_de_emision),
      idMoneda,
      importeEnLetras: numeroALetras(resumen.total, idMoneda),
      advertencias,
    };
  }

  /**
   * El frontend envía el precio de venta, que ya incluye IGV. Si por
   * compatibilidad llegara solo el valor unitario sin impuesto, se le agrega.
   */
  private aLineaFiscal(item: ItemComprobanteRequest, porcentajeIgv: number) {
    const precioConIgv = item.precio_unitario ?? (
      item.valor_unitario !== undefined
        ? redondear(item.valor_unitario * (1 + porcentajeIgv / 100))
        : 0
    );

    return {
      cantidad: Number(item.cantidad) || 0,
      precio_unitario: precioConIgv,
      descuento: item.descuento ?? 0,
      tipo_de_igv: item.tipo_de_igv,
    };
  }

  private armarItems(entradas: ItemComprobanteRequest[], resumen: ResumenFiscal): ItemPreviewResponse[] {
    return entradas.map((entrada, indice) => {
      const linea = resumen.lineas[indice];
      return {
        id_producto: entrada.id_producto,
        codigo: entrada.codigo?.trim() || String(entrada.id_producto ?? indice + 1),
        codigo_producto_sunat: entrada.codigo_producto_sunat?.trim() || '10000000',
        unidad_de_medida: entrada.unidad_de_medida?.trim().toUpperCase() || 'NIU',
        descripcion: this.limpiarTexto(entrada.descripcion),
        cantidad: linea.cantidad,
        valor_unitario: linea.valor_unitario,
        precio_unitario: linea.precio_unitario,
        descuento: linea.descuento,
        subtotal: linea.subtotal,
        igv: linea.igv,
        total: linea.total,
        tipo_de_igv: linea.tipo_de_igv,
      };
    });
  }

  private async resolverReceptor(
    dto: GenerarComprobanteRequest,
    guardar: boolean,
  ): Promise<ReceptorResponse> {
    const documento = (dto.documento ?? dto.ruc ?? dto.dni ?? '').toString().replace(/\D/g, '');

    if (documento) return this.receptorBussnies.buscarPorDocumento(documento, guardar);
    if (dto.id_empresa) return this.receptorBussnies.porIdEmpresa(dto.id_empresa);
    if (dto.id_cliente) return this.receptorBussnies.porIdCliente(dto.id_cliente);

    // Sin documento solo se puede emitir boleta a consumidor final.
    if (dto.id_tipo === TIPO_BOLETA) return this.receptorBussnies.consumidorFinal();

    throw new BadRequestException(
      'Indique el DNI o RUC del cliente, o selecciónelo de la lista',
    );
  }

  private validar(
    dto: GenerarComprobanteRequest,
    receptor: ReceptorResponse,
    resumen: ResumenFiscal,
    serie: string,
  ): void {
    if (dto.id_tipo === TIPO_FACTURA && receptor.tipo_documento !== TIPO_DOC_RUC) {
      throw new BadRequestException(
        'Una factura solo puede emitirse a un RUC. Para una persona con DNI use boleta.',
      );
    }

    if (
      dto.id_tipo === TIPO_BOLETA &&
      receptor.origen === 'generico' &&
      resumen.total > TOPE_BOLETA_SIN_DOCUMENTO
    ) {
      throw new BadRequestException(
        `Por encima de S/ ${TOPE_BOLETA_SIN_DOCUMENTO} SUNAT exige identificar al comprador. Ingrese su DNI o RUC.`,
      );
    }

    if (esNota(dto.id_tipo)) {
      if (!dto.documento_que_se_modifica_serie || !dto.documento_que_se_modifica_numero) {
        throw new BadRequestException(
          'Indique la serie y el número del comprobante que se está corrigiendo',
        );
      }

      const motivo = dto.id_tipo === TIPO_NOTA_CREDITO
        ? dto.tipo_de_nota_de_credito?.trim()
        : dto.tipo_de_nota_de_debito?.trim();

      if (!motivo) {
        throw new BadRequestException('Seleccione el motivo de la nota');
      }

      const catalogo = dto.id_tipo === TIPO_NOTA_CREDITO ? MOTIVOS_NOTA_CREDITO : MOTIVOS_NOTA_DEBITO;
      if (!catalogo[motivo]) {
        throw new BadRequestException(`El motivo ${motivo} no pertenece al catálogo de SUNAT`);
      }

      // La nota comparte la serie del documento corregido, no una serie propia.
      const prefijoOrigen = dto.documento_que_se_modifica_serie.trim().toUpperCase()[0];
      if (serie[0] !== prefijoOrigen) {
        throw new BadRequestException(
          `La nota debe emitirse con una serie que empiece con "${prefijoOrigen}", igual que el documento que corrige`,
        );
      }
    }
  }

  private async reservar(preparado: ComprobantePreparado, numeroSolicitado?: number): Promise<Comprobante> {
    const { dto, receptor, resumen, serie } = preparado;

    try {
      return await this.repo.reservarCorrelativo(
        {
          id_venta: dto.id_venta,
          cliente: receptor.id_cliente ? ({ id_cliente: receptor.id_cliente } as any) : undefined,
          tipo: { id_tipo: dto.id_tipo } as any,
          moneda: { id_moneda: preparado.idMoneda } as any,
          serie,
          sunat_transaction: 1,
          cliente_tipo_doc: receptor.tipo_documento,
          cliente_numero_doc: receptor.numero_documento,
          cliente_denominacion: receptor.denominacion,
          cliente_direccion: receptor.direccion,
          cliente_email: receptor.email,
          fecha_de_emision: preparado.fechaEmision,
          fecha_de_vencimiento: preparado.fechaVencimiento,
          porcentaje_igv: resumen.porcentaje_igv,
          total_gravada: resumen.total_gravada,
          total_exonerada: resumen.total_exonerada,
          total_inafecta: resumen.total_inafecta,
          total_descuento: resumen.total_descuento,
          total_igv: resumen.total_igv,
          total: resumen.total,
          importe_en_letras: preparado.importeEnLetras,
          observaciones: dto.observaciones ?? '',
          enviar_sunat: dto.enviar_sunat ?? true,
          enviar_cliente: dto.enviar_cliente ?? false,
        },
        preparado.items.map((i) => ({
          id_producto: i.id_producto,
          unidad_de_medida: i.unidad_de_medida,
          codigo: i.codigo,
          codigo_producto_sunat: i.codigo_producto_sunat,
          descripcion: i.descripcion,
          cantidad: i.cantidad,
          valor_unitario: i.valor_unitario,
          precio_unitario: i.precio_unitario,
          descuento: i.descuento,
          subtotal: i.subtotal,
          tipo_de_igv: i.tipo_de_igv,
          igv: i.igv,
          total: i.total,
        })),
        numeroSolicitado,
      );
    } catch (error: any) {
      throw new BadRequestException(error?.message ?? 'No se pudo reservar el número del comprobante');
    }
  }

  // ── Construcción del cuerpo para NUBEFACT ────────────────────

  private construirPayload(preparado: ComprobantePreparado, numero: number): Record<string, any> {
    const { dto, receptor, resumen, serie } = preparado;

    return {
      operacion: 'generar_comprobante',
      tipo_de_comprobante: tipoComprobanteNubefact(dto.id_tipo),
      serie,
      numero,
      sunat_transaction: 1,

      cliente_tipo_de_documento: tipoDocumentoNubefact(receptor.tipo_documento),
      cliente_numero_de_documento: receptor.numero_documento,
      cliente_denominacion: this.limpiarTexto(receptor.denominacion),
      cliente_direccion: this.limpiarTexto(receptor.direccion),
      cliente_email: receptor.email ?? '',
      cliente_email_1: '',
      cliente_email_2: '',

      fecha_de_emision: preparado.fechaEmision,
      fecha_de_vencimiento: preparado.fechaVencimiento,
      moneda: preparado.idMoneda,
      tipo_de_cambio: '',
      porcentaje_de_igv: resumen.porcentaje_igv,

      descuento_global: '',
      total_descuento: resumen.total_descuento || '',
      total_anticipo: '',
      total_gravada: resumen.total_gravada || '',
      total_inafecta: resumen.total_inafecta || '',
      total_exonerada: resumen.total_exonerada || '',
      total_igv: resumen.total_igv || '',
      total_gratuita: '',
      total_otros_cargos: '',
      total: resumen.total,

      percepcion_tipo: '',
      percepcion_base_imponible: '',
      total_percepcion: '',
      total_incluido_percepcion: '',
      retencion_tipo: '',
      retencion_base_imponible: '',
      total_retencion: '',
      total_impuestos_bolsas: '',
      detraccion: false,

      observaciones: this.limpiarTexto(dto.observaciones ?? ''),

      documento_que_se_modifica_tipo: esNota(dto.id_tipo)
        ? this.tipoDocumentoModificado(dto.documento_que_se_modifica_tipo)
        : '',
      documento_que_se_modifica_serie: esNota(dto.id_tipo)
        ? (dto.documento_que_se_modifica_serie ?? '').toUpperCase()
        : '',
      documento_que_se_modifica_numero: esNota(dto.id_tipo)
        ? Number(dto.documento_que_se_modifica_numero) || ''
        : '',
      tipo_de_nota_de_credito: dto.id_tipo === TIPO_NOTA_CREDITO ? (dto.tipo_de_nota_de_credito ?? '') : '',
      tipo_de_nota_de_debito: dto.id_tipo === TIPO_NOTA_DEBITO ? (dto.tipo_de_nota_de_debito ?? '') : '',

      enviar_automaticamente_a_la_sunat: dto.enviar_sunat ?? true,
      enviar_automaticamente_al_cliente: (dto.enviar_cliente ?? false) && Boolean(receptor.email),

      condiciones_de_pago: dto.condiciones_de_pago ?? '',
      medio_de_pago: dto.medio_de_pago ?? '',
      placa_vehiculo: '',
      orden_compra_servicio: dto.orden_compra_servicio ?? '',
      formato_de_pdf: '',
      generado_por_contingencia: '',
      bienes_region_selva: '',
      servicios_region_selva: '',

      items: preparado.items.map((i) => ({
        unidad_de_medida: i.unidad_de_medida,
        codigo: i.codigo,
        codigo_producto_sunat: i.codigo_producto_sunat,
        descripcion: i.descripcion,
        cantidad: i.cantidad,
        valor_unitario: i.valor_unitario,
        precio_unitario: i.precio_unitario,
        descuento: i.descuento || '',
        subtotal: i.subtotal,
        tipo_de_igv: i.tipo_de_igv,
        igv: i.igv,
        total: i.total,
        anticipo_regularizacion: false,
        anticipo_documento_serie: '',
        anticipo_documento_numero: '',
      })),
    };
  }

  /** El documento corregido se referencia con el código del catálogo 01 de SUNAT. */
  private tipoDocumentoModificado(valor?: string): string {
    const limpio = (valor ?? '').toString().trim();
    if (limpio === '01' || limpio === '03') return limpio;
    if (limpio === '1' || limpio === String(TIPO_FACTURA)) return tipoComprobanteSunat(TIPO_FACTURA);
    if (limpio === '2' || limpio === String(TIPO_BOLETA)) return tipoComprobanteSunat(TIPO_BOLETA);
    return tipoComprobanteSunat(TIPO_FACTURA);
  }

  // ── Consultar ────────────────────────────────────────────────

  async consultar(dto: ConsultarComprobanteRequest): Promise<ComprobanteResponse> {
    const data = await this.consultarEnNubefact(dto.tipo_de_comprobante, dto.serie, dto.numero);

    if (!data || data.errors) {
      throw new NotFoundException(
        data?.errors ? String(data.errors) : 'El comprobante no está registrado en NUBEFACT',
      );
    }

    const enBD = await this.repo.buscarPorSerieNumero(dto.serie, dto.numero);
    if (enBD) {
      await this.repo.actualizarRespuesta(enBD.id_comprobante, {
        aceptada_sunat: data.aceptada_por_sunat,
        sunat_description: data.sunat_description,
        anulado: data.anulado ?? false,
        estado: data.anulado ? 'anulado' : 'emitido',
      });
    }

    return this.mapRespuesta(data, enBD?.id_comprobante);
  }

  private async consultarEnNubefact(idTipo: number, serie: string, numero: number): Promise<any | null> {
    try {
      const { data } = await axios.post(
        nubefactConfig.url,
        {
          operacion: 'consultar_comprobante',
          tipo_de_comprobante: tipoComprobanteNubefact(idTipo),
          serie,
          numero,
        },
        { headers: this.headers, timeout: TIEMPO_LIMITE_MS },
      );
      return data;
    } catch (error: any) {
      this.logger.warn(`Consulta fallida de ${serie}-${numero}: ${this.extraerMensajeNubefact(error)}`);
      return null;
    }
  }

  // ── Anular ───────────────────────────────────────────────────

  async anular(dto: AnularComprobanteRequest): Promise<AnulacionResponse> {
    const enBD = dto.id_comprobante
      ? await this.repo.buscarPorId(dto.id_comprobante)
      : await this.repo.buscarPorSerieNumero(dto.serie as string, dto.numero as number);

    if (!enBD) throw new NotFoundException('Comprobante no encontrado');
    if (enBD.anulado) throw new BadRequestException('El comprobante ya fue anulado');
    if (!dto.motivo?.trim()) throw new BadRequestException('Indique el motivo de la anulación');

    // Un comprobante que nunca llegó a NUBEFACT se descarta localmente.
    if (enBD.estado === 'error' || enBD.estado === 'pendiente') {
      await this.repo.actualizarRespuesta(enBD.id_comprobante, {
        anulado: true,
        estado: 'anulado',
        motivo_anulacion: dto.motivo,
      });
      return { numero: enBD.numero, sunat_description: 'Descartado localmente, nunca llegó a SUNAT' };
    }

    try {
      const { data } = await axios.post(
        nubefactConfig.url,
        {
          operacion: 'generar_anulacion',
          tipo_de_comprobante: tipoComprobanteNubefact(enBD.tipo?.id_tipo ?? TIPO_BOLETA),
          serie: enBD.serie,
          numero: enBD.numero,
          motivo: this.limpiarTexto(dto.motivo),
          codigo_unico: '',
        },
        { headers: this.headers, timeout: TIEMPO_LIMITE_MS },
      );

      if (data?.errors) {
        throw new BadRequestException(Array.isArray(data.errors) ? data.errors.join(', ') : String(data.errors));
      }

      await this.repo.actualizarRespuesta(enBD.id_comprobante, {
        anulado: true,
        estado: 'anulado',
        motivo_anulacion: dto.motivo,
        sunat_ticket: data.sunat_ticket_numero ?? '',
      });

      return this.mapAnulacion(data);
    } catch (error: any) {
      if (error instanceof BadRequestException) throw error;
      throw new ServiceUnavailableException(this.extraerMensajeNubefact(error));
    }
  }

  async consultarAnulacion(dto: ConsultarComprobanteRequest): Promise<AnulacionResponse> {
    try {
      const { data } = await axios.post(
        nubefactConfig.url,
        {
          operacion: 'consultar_anulacion',
          tipo_de_comprobante: tipoComprobanteNubefact(dto.tipo_de_comprobante),
          serie: dto.serie,
          numero: dto.numero,
        },
        { headers: this.headers, timeout: TIEMPO_LIMITE_MS },
      );
      return this.mapAnulacion(data);
    } catch (error: any) {
      throw new ServiceUnavailableException(this.extraerMensajeNubefact(error));
    }
  }

  // ── Listados ─────────────────────────────────────────────────

  async listar(filtro: FiltroComprobantes) {
    const resultado = await this.repo.listar(filtro);
    return { ...resultado, datos: resultado.datos.map((c) => this.mapListado(c)) };
  }

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

  /** Detalle completo, con líneas y totales, para reimprimir o revisar. */
  async obtenerDetalle(id_comprobante: number) {
    const c = await this.repo.buscarPorId(id_comprobante);
    if (!c) throw new NotFoundException('Comprobante no encontrado');

    const emisor = await this.emisor();
    const idMoneda = Number(c.moneda?.id_moneda ?? 1);

    return {
      emisor,
      id_comprobante: c.id_comprobante,
      id_tipo: c.tipo?.id_tipo,
      tipo_nombre: nombreTipoComprobante(c.tipo?.id_tipo),
      serie: c.serie,
      numero: c.numero,
      numero_formateado: this.formatearNumero(c.serie, c.numero),
      fecha_de_emision: c.fecha_de_emision,
      fecha_de_vencimiento: c.fecha_de_vencimiento,
      moneda: { id_moneda: idMoneda, ...(MONEDAS[idMoneda] ?? MONEDAS[1]) },
      receptor: {
        tipo_documento: c.cliente_tipo_doc,
        numero_documento: c.cliente_numero_doc,
        denominacion: c.cliente_denominacion,
        direccion: c.cliente_direccion,
        email: c.cliente_email,
      },
      items: (c.items ?? []).map((i) => ({
        codigo: i.codigo,
        unidad_de_medida: i.unidad_de_medida,
        descripcion: i.descripcion,
        cantidad: Number(i.cantidad ?? 0),
        valor_unitario: Number(i.valor_unitario ?? 0),
        precio_unitario: Number(i.precio_unitario ?? 0),
        descuento: Number(i.descuento ?? 0),
        subtotal: Number(i.subtotal ?? 0),
        igv: Number(i.igv ?? 0),
        total: Number(i.total ?? 0),
      })),
      porcentaje_igv: Number(c.porcentaje_igv ?? PORCENTAJE_IGV_POR_DEFECTO),
      totales: {
        gravada: Number(c.total_gravada ?? 0),
        exonerada: Number(c.total_exonerada ?? 0),
        inafecta: Number(c.total_inafecta ?? 0),
        descuento: Number(c.total_descuento ?? 0),
        igv: Number(c.total_igv ?? 0),
        total: Number(c.total ?? 0),
      },
      importe_en_letras: c.importe_en_letras ?? numeroALetras(Number(c.total ?? 0), idMoneda),
      observaciones: c.observaciones ?? '',
      estado: this.estadoVisible(c),
      anulado: c.anulado,
      motivo_anulacion: c.motivo_anulacion,
      enlace: c.enlace,
      enlace_pdf: c.enlace_pdf,
      cadena_qr: c.cadena_qr,
      codigo_hash: c.codigo_hash,
      sunat_description: c.sunat_description,
      error_mensaje: c.error_mensaje,
    };
  }

  async obtenerPdfBuffer(id_comprobante: number): Promise<Buffer> {
    const c = await this.repo.buscarPorId(id_comprobante);
    if (!c) throw new NotFoundException('Comprobante no encontrado');
    if (!c.enlace_pdf) {
      throw new NotFoundException('Este comprobante todavía no tiene PDF disponible');
    }

    try {
      const resp = await axios.get(c.enlace_pdf, {
        responseType: 'arraybuffer',
        timeout: TIEMPO_LIMITE_MS,
      });
      return Buffer.from(resp.data);
    } catch {
      throw new ServiceUnavailableException('No se pudo descargar el PDF desde NUBEFACT');
    }
  }

  // ── Auxiliares ───────────────────────────────────────────────

  private async emisor() {
    const valores = await this.config.obtenerVarias([
      'emisor_ruc',
      'emisor_razon_social',
      'emisor_direccion',
      'emisor_ubicacion',
      'emisor_logo_url',
    ]);

    return {
      ruc: valores.emisor_ruc ?? emisorConfig.ruc,
      razon_social: valores.emisor_razon_social ?? emisorConfig.razon_social,
      direccion: valores.emisor_direccion ?? emisorConfig.direccion,
      ubicacion: valores.emisor_ubicacion ?? emisorConfig.ubicacion,
      logo_url: valores.emisor_logo_url ?? emisorConfig.logo_url,
    };
  }

  private datosNota(dto: GenerarComprobanteRequest) {
    if (!esNota(dto.id_tipo)) return undefined;

    const codigo = (dto.id_tipo === TIPO_NOTA_CREDITO
      ? dto.tipo_de_nota_de_credito
      : dto.tipo_de_nota_de_debito) ?? '';
    const catalogo = dto.id_tipo === TIPO_NOTA_CREDITO ? MOTIVOS_NOTA_CREDITO : MOTIVOS_NOTA_DEBITO;

    return {
      motivo_codigo: codigo,
      motivo_texto: catalogo[codigo] ?? '',
      documento_modificado: `${dto.documento_que_se_modifica_serie ?? ''}-${String(
        dto.documento_que_se_modifica_numero ?? '',
      ).padStart(8, '0')}`,
    };
  }

  private formatearNumero(serie: string, numero: number): string {
    return `${serie}-${String(numero).padStart(8, '0')}`;
  }

  /**
   * Las comillas dobles rompen el JSON de NUBEFACT, por ejemplo en
   * descripciones como clavos 3" pulgadas.
   */
  private limpiarTexto(texto: string): string {
    return (texto ?? '')
      .toString()
      .replace(/"/g, "''")
      .replace(/[\r\n\t]+/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }

  private normalizarFecha(fecha?: string): string {
    const texto = (fecha ?? '').trim();

    if (/^\d{2}-\d{2}-\d{4}$/.test(texto)) return texto;
    if (/^\d{4}-\d{2}-\d{2}$/.test(texto)) {
      const [anio, mes, dia] = texto.split('-');
      return `${dia}-${mes}-${anio}`;
    }

    const hoy = new Date();
    const dia = String(hoy.getDate()).padStart(2, '0');
    const mes = String(hoy.getMonth() + 1).padStart(2, '0');
    return `${dia}-${mes}-${hoy.getFullYear()}`;
  }

  private estadoVisible(c: Comprobante): string {
    if (c.anulado) return 'anulado';
    if (c.estado === 'error' || c.estado === 'pendiente') return c.estado;
    return c.aceptada_sunat ? 'aceptado' : 'emitido';
  }

  private extraerMensajeNubefact(error: any): string {
    const data = error?.response?.data;
    if (Array.isArray(data?.errors)) return data.errors.join(', ');
    if (typeof data?.errors === 'string') return data.errors;
    if (typeof data === 'string' && data.trim()) return data.slice(0, 500);
    if (typeof data?.message === 'string') return data.message;
    if (error?.code === 'ECONNABORTED') return 'NUBEFACT no respondió a tiempo. Reintente en unos segundos.';
    if (typeof error?.message === 'string') return error.message;
    return 'No se pudo conectar con NUBEFACT';
  }

  // ── Mappers ──────────────────────────────────────────────────

  private mapRespuesta(data: any, id_comprobante?: number): ComprobanteResponse {
    return {
      id_comprobante,
      tipo_de_comprobante: data.tipo_de_comprobante,
      serie: data.serie,
      numero: data.numero,
      enlace: data.enlace,
      enlace_pdf: data.enlace_del_pdf,
      enlace_xml: data.enlace_del_xml,
      enlace_cdr: data.enlace_del_cdr,
      aceptada_sunat: data.aceptada_por_sunat,
      sunat_description: data.sunat_description,
      sunat_responsecode: data.sunat_responsecode,
      cadena_qr: data.cadena_para_codigo_qr,
      codigo_hash: data.codigo_hash,
      anulado: data.anulado ?? false,
    };
  }

  private mapAnulacion(data: any): AnulacionResponse {
    return {
      numero: data.numero,
      enlace: data.enlace,
      sunat_ticket: data.sunat_ticket_numero,
      aceptada_sunat: data.aceptada_por_sunat,
      sunat_description: data.sunat_description,
      enlace_pdf: data.enlace_del_pdf,
      enlace_xml: data.enlace_del_xml,
      enlace_cdr: data.enlace_del_cdr,
    };
  }

  private mapComprobante(c: Comprobante): ComprobanteResponse {
    return {
      id_comprobante: c.id_comprobante,
      tipo_de_comprobante: c.tipo?.id_tipo,
      serie: c.serie,
      numero: c.numero,
      numero_formateado: this.formatearNumero(c.serie, c.numero),
      enlace: c.enlace,
      enlace_pdf: c.enlace_pdf,
      enlace_xml: c.enlace_xml,
      enlace_cdr: c.enlace_cdr,
      aceptada_sunat: c.aceptada_sunat,
      sunat_description: c.sunat_description,
      sunat_responsecode: c.sunat_responsecode,
      cadena_qr: c.cadena_qr,
      codigo_hash: c.codigo_hash,
      anulado: c.anulado,
      estado: this.estadoVisible(c),
    };
  }

  private mapListado(c: Comprobante): ComprobanteListadoResponse {
    const idMoneda = Number(c.moneda?.id_moneda ?? 1);
    return {
      id_comprobante: c.id_comprobante,
      id_tipo: c.tipo?.id_tipo,
      tipo_nombre: nombreTipoComprobante(c.tipo?.id_tipo),
      serie: c.serie,
      numero: c.numero,
      numero_formateado: this.formatearNumero(c.serie, c.numero),
      fecha_de_emision: c.fecha_de_emision,
      creado_en: c.creado_en,
      cliente_numero_doc: c.cliente_numero_doc,
      cliente_denominacion: c.cliente_denominacion,
      moneda_simbolo: (MONEDAS[idMoneda] ?? MONEDAS[1]).simbolo,
      total: Number(c.total ?? 0),
      estado: this.estadoVisible(c),
      aceptada_sunat: Boolean(c.aceptada_sunat),
      anulado: Boolean(c.anulado),
      sunat_description: c.sunat_description,
      error_mensaje: c.error_mensaje,
      enlace: c.enlace,
      enlace_pdf: c.enlace_pdf,
      puede_anular: !c.anulado,
    };
  }
}

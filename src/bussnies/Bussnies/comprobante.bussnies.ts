import {
  Injectable,
  BadRequestException,
  ServiceUnavailableException,
  NotFoundException,
} from '@nestjs/common';
import { ComprobanteRepository, FiltroComprobantes } from '../../repository/Repository/comprobante.repository';
import { ConfiguracionRepository } from '../../repository/Repository/configuracion.repository';
import { ReceptorBussnies, TOPE_BOLETA_SIN_DOCUMENTO } from './receptor.bussnies';
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
import { construirLineaCpe, totalesCpeDesdeLineas } from '../../sunat/nucleo/linea-cpe';
import type { AfectacionCpe, DocumentoCpe } from '../../sunat/nucleo/documento-fiscal.types';
import { PosBetaService } from '../../sunat/emision/pos-beta.service';
import {
  esNota,
  normalizarSerie,
  nombreTipoComprobante,
  monedaNubefact,
  MOTIVOS_NOTA_CREDITO,
  MOTIVOS_NOTA_DEBITO,
  TIPO_FACTURA,
  TIPO_BOLETA,
  TIPO_NOTA_CREDITO,
  TIPO_NOTA_DEBITO,
  TIPO_DOC_RUC,
} from '../../util/fiscal/nubefact.catalogo';

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

  constructor(
    private readonly repo: ComprobanteRepository,
    private readonly receptorBussnies: ReceptorBussnies,
    private readonly config: ConfiguracionRepository,
    private readonly posBeta: PosBetaService,
  ) {}

  // ── Vista previa ─────────────────────────────────────────────

  /** Calcula el comprobante completo sin enviarlo ni consumir correlativo. */
  async previsualizar(dto: GenerarComprobanteRequest): Promise<PreviewComprobanteResponse> {
    const betaPos = await this.posBeta.activoEnBeta();
    const preparado = await this.preparar(dto, { guardarReceptor: false, betaPos });
    const numero = betaPos
      ? await this.posBeta.siguienteCorrelativoVista()
      : dto.numero && dto.numero > 0
      ? dto.numero
      : (await this.repo.buscarUltimoNumeroPorSerie(preparado.serie)) + 1;

    const emisor = betaPos
      ? await this.emisorBetaPreview()
      : await this.emisor();
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
      proveedor_fiscal: 'sunat_directo',
      ambiente_fiscal: betaPos ? 'beta' : undefined,
    };
  }

  // ── Emitir ───────────────────────────────────────────────────

  async generar(dto: GenerarComprobanteRequest): Promise<ComprobanteResponse> {
    const betaPos = await this.posBeta.activoEnBeta();
    if (!betaPos) {
      throw new ServiceUnavailableException(
        'La emisión comercial directa solo está habilitada para SUNAT BETA. Active la opción POS BETA en Facturación SUNAT; el comprobante no se enviará a ningún proveedor alternativo.',
      );
    }
    return this.generarBeta(dto);
  }

  private async generarBeta(dto: GenerarComprobanteRequest): Promise<ComprobanteResponse> {
    if (dto.id_tipo !== TIPO_FACTURA && dto.id_tipo !== TIPO_BOLETA) {
      throw new BadRequestException(
        'El POS SUNAT BETA solo admite facturas y boletas. Las notas requieren un flujo de referencia específico.',
      );
    }
    if (dto.enviar_sunat === false) {
      throw new BadRequestException(
        'El POS SUNAT BETA está activo y requiere enviar el comprobante a BETA; no se puede guardar como si ya estuviera emitido.',
      );
    }
    if (Number(dto.descuento_global ?? 0) !== 0) {
      throw new BadRequestException(
        'El POS SUNAT BETA no admite descuentos globales sin distribuirlos en las líneas. Aplique el descuento por producto.',
      );
    }

    const preparado = await this.preparar(dto, { guardarReceptor: true, betaPos: true });
    if (preparado.idMoneda !== 1 && preparado.idMoneda !== 2) {
      throw new BadRequestException('El POS SUNAT BETA solo admite soles (PEN) o dólares (USD).');
    }
    const numero = await this.posBeta.siguienteCorrelativo();
    const documento = await this.documentoCpeBeta(preparado, numero);
    const documentoPreparado = await this.posBeta.prepararDocumento(documento);

    const comprobante = await this.reservar(preparado, numero, true);
    try {
      const resultado = await this.posBeta.emitirPreparado(
        documentoPreparado,
        comprobante.id_comprobante,
        null,
      );
      const aceptado = resultado.aceptado;
      const estado =
        aceptado ? 'emitido' : resultado.estado === 'PENDIENTE_REENVIO' ? 'pendiente' : 'error';
      return {
        id_comprobante: comprobante.id_comprobante,
        tipo_de_comprobante: dto.id_tipo,
        serie: preparado.serie,
        numero: comprobante.numero,
        numero_formateado: this.formatearNumero(preparado.serie, comprobante.numero),
        aceptada_sunat: aceptado,
        sunat_description: resultado.mensaje,
        sunat_responsecode: resultado.codigo,
        cadena_qr: resultado.cadena_qr,
        codigo_hash: resultado.digest,
        estado,
        error: aceptado ? undefined : resultado.mensaje,
        proveedor_fiscal: 'sunat_directo',
        ambiente_fiscal: 'beta',
        estado_sunat: resultado.estado,
        id_envio_ultimo: resultado.id_envio,
        archivos_beta: resultado.archivos,
      };
    } catch (error) {
      const persistido = await this.repo.buscarPorId(comprobante.id_comprobante);
      if (!persistido?.id_envio_ultimo) {
        const mensaje =
          error instanceof Error ? error.message : 'No se pudo preparar el envío BETA';
        await this.repo.actualizarRespuesta(comprobante.id_comprobante, {
          estado: 'error',
          estado_sunat: 'ERROR_CONFIG',
          error_mensaje: mensaje,
        });
      }
      throw error;
    }
  }

  private async emisorBetaPreview(): Promise<PreviewComprobanteResponse['emisor']> {
    const [beta, general] = await Promise.all([
      this.posBeta.emisorParaDocumento(),
      this.emisor(),
    ]);
    return {
      ruc: beta.ruc,
      razon_social: beta.razonSocial,
      direccion: beta.direccion,
      ubicacion: [beta.distrito, beta.provincia, beta.departamento].join(' - '),
      logo_url: general.logo_url,
    };
  }

  private async documentoCpeBeta(
    preparado: ComprobantePreparado,
    numero: number,
  ): Promise<DocumentoCpe> {
    const documento = preparado.dto;
    const emisor = await this.posBeta.emisorParaDocumento();
    const receptor = preparado.receptor;
    const porcentajeIgv = preparado.resumen.porcentaje_igv;
    const lineas = preparado.items.map((item) =>
      construirLineaCpe(
        {
          cantidad: item.cantidad,
          precioUnitario: item.precio_unitario,
          subtotal: item.subtotal,
          igv: item.igv,
          total: item.total,
          afectacion: this.afectacionCpe(item.tipo_de_igv),
          descuento: item.descuento,
        },
        {
          unidad: item.unidad_de_medida,
          descripcion: item.descripcion,
          codigoInterno: item.codigo,
          codigoSunat: item.codigo_producto_sunat,
        },
        porcentajeIgv,
      ),
    );
    const totales = totalesCpeDesdeLineas(lineas);
    const esperados = {
      gravada: preparado.resumen.total_gravada,
      exonerada: preparado.resumen.total_exonerada,
      inafecta: preparado.resumen.total_inafecta,
      igv: preparado.resumen.total_igv,
      total: preparado.resumen.total,
    };
    for (const clave of Object.keys(esperados) as (keyof typeof esperados)[]) {
      if (redondear(totales[clave]) !== redondear(esperados[clave])) {
        throw new BadRequestException(
          `Los totales calculados para SUNAT BETA no coinciden con la venta (${clave}). No se reservó ni envió el comprobante.`,
        );
      }
    }

    const credito = (documento.condiciones_de_pago ?? '').toLowerCase().includes('crédito')
      || (documento.condiciones_de_pago ?? '').toLowerCase().includes('credito');
    const fechaEmisionIso = this.fechaIso(preparado.fechaEmision);
    const fechaVencimientoIso = this.fechaIso(preparado.fechaVencimiento);
    if (credito && fechaVencimientoIso <= fechaEmisionIso) {
      throw new BadRequestException(
        'Para emitir una venta al crédito en BETA, indique una fecha de vencimiento posterior a la emisión.',
      );
    }
    const montoCredito = credito ? Number(documento.monto_credito ?? 0) : 0;
    if (credito && (!Number.isFinite(montoCredito) || montoCredito <= 0 || montoCredito > totales.total)) {
      throw new BadRequestException(
        'El monto del crédito calculado en la venta no es válido para el comprobante BETA.',
      );
    }

    return {
      tipo: documento.id_tipo === TIPO_FACTURA ? '01' : '03',
      serie: preparado.serie,
      numero,
      fechaEmision: fechaEmisionIso,
      horaEmision: new Intl.DateTimeFormat('en-GB', {
        timeZone: 'America/Lima',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23',
      }).format(new Date()),
      fechaVencimiento: credito ? fechaVencimientoIso : undefined,
      moneda: preparado.idMoneda === 1 ? 'PEN' : 'USD',
      emisor,
      cliente: {
        tipoDoc: String(receptor.tipo_documento),
        numDoc: receptor.numero_documento,
        nombre: receptor.denominacion,
        direccion: receptor.direccion || undefined,
      },
      lineas,
      totales,
      formaPago: credito
        ? {
            tipo: 'Credito',
            montoPendiente: montoCredito,
            cuotas: [
              {
                numero: 1,
                monto: montoCredito,
                fechaPago: fechaVencimientoIso,
              },
            ],
          }
        : { tipo: 'Contado' },
      leyendaMontoLetras: preparado.importeEnLetras,
      observaciones: preparado.dto.observaciones,
    };
  }

  private fechaIso(fecha: string): string {
    const partes = fecha.match(/^(\d{2})-(\d{2})-(\d{4})$/);
    if (partes) return `${partes[3]}-${partes[2]}-${partes[1]}`;
    if (/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return fecha;
    throw new BadRequestException('La fecha del comprobante no tiene un formato válido para SUNAT.');
  }

  private afectacionCpe(tipoIgv: number): AfectacionCpe {
    if (tipoIgv === 1) return '10';
    if (tipoIgv === 8) return '20';
    if (tipoIgv === 9) return '30';
    throw new BadRequestException(
      `El tipo de afectación IGV ${tipoIgv} todavía no se puede emitir por el flujo comercial SUNAT BETA.`,
    );
  }

  /** Reintenta un comprobante que quedó en error o pendiente, sin gastar otro número. */
  async reintentar(id_comprobante: number): Promise<ComprobanteResponse> {
    const guardado = await this.repo.buscarPorId(id_comprobante);
    if (!guardado) throw new NotFoundException('Comprobante no encontrado');
    if (guardado.proveedor_fiscal === 'sunat_directo' && guardado.ambiente_fiscal === 'beta') {
      if (!guardado.id_envio_ultimo) {
        throw new BadRequestException('El comprobante BETA no tiene un envío recuperable asociado.');
      }
      const resultado = await this.posBeta.reintentar(guardado.id_envio_ultimo);
      return {
        id_comprobante,
        tipo_de_comprobante: guardado.tipo?.id_tipo,
        serie: guardado.serie,
        numero: guardado.numero,
        numero_formateado: this.formatearNumero(guardado.serie, guardado.numero),
        aceptada_sunat: resultado.aceptado,
        sunat_description: resultado.mensaje,
        sunat_responsecode: resultado.codigo,
        cadena_qr: resultado.cadena_qr,
        codigo_hash: resultado.digest,
        estado: resultado.aceptado
          ? 'emitido'
          : resultado.estado === 'PENDIENTE_REENVIO'
            ? 'pendiente'
            : 'error',
        error: resultado.aceptado ? undefined : resultado.mensaje,
        proveedor_fiscal: 'sunat_directo',
        ambiente_fiscal: 'beta',
        estado_sunat: resultado.estado,
        id_envio_ultimo: resultado.id_envio,
        archivos_beta: resultado.archivos,
      };
    }
    throw new BadRequestException(
      'Este comprobante no pertenece a un envío SUNAT BETA recuperable. No se consultará ni reenviará a un proveedor externo.',
    );
  }

  // ── Preparación compartida ───────────────────────────────────

  private async preparar(
    dto: GenerarComprobanteRequest,
    opciones: { guardarReceptor: boolean; betaPos?: boolean },
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
    // Boleta/factura: serie desde configuración (POS solo lectura). Notas: flujo propio.
    let serieEntrada = dto.serie;
    if (opciones.betaPos) {
      if (dto.id_tipo !== TIPO_FACTURA && dto.id_tipo !== TIPO_BOLETA) {
        throw new BadRequestException('El POS SUNAT BETA solo admite facturas y boletas.');
      }
      serieEntrada = dto.id_tipo === TIPO_FACTURA ? 'FB01' : 'BB01';
    } else if (!esNota(dto.id_tipo)) {
      const clave = dto.id_tipo === TIPO_FACTURA ? 'serie_factura' : 'serie_boleta';
      const defecto = dto.id_tipo === TIPO_FACTURA ? 'FFF1' : 'BBB1';
      serieEntrada = await this.config.obtenerTexto(clave, defecto);
    }
    const serie = normalizarSerie(serieEntrada, dto.id_tipo, serieModificada);

    this.validar(dto, receptor, resumen, serie);

    const idMoneda = monedaNubefact(dto.id_moneda);
    // Siempre el día calendario de Perú al emitir (Railway/UTC no debe desfasar).
    const fechaEmision = this.fechaHoyLima();
    const fechaVencimiento = dto.fecha_de_vencimiento?.trim()
      ? this.normalizarFecha(dto.fecha_de_vencimiento)
      : fechaEmision;

    return {
      dto,
      receptor,
      resumen,
      items: this.armarItems(dto.items, resumen),
      serie,
      fechaEmision,
      fechaVencimiento,
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

  private async reservar(
    preparado: ComprobantePreparado,
    numeroSolicitado?: number,
    betaPos = false,
  ): Promise<Comprobante> {
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
          proveedor_fiscal: betaPos ? 'sunat_directo' : null,
          ambiente_fiscal: betaPos ? 'beta' : null,
          estado_sunat: betaPos ? 'NO_ENVIADO' : null,
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

  // ── Consultar ────────────────────────────────────────────────

  async consultar(dto: ConsultarComprobanteRequest): Promise<ComprobanteResponse> {
    void dto;
    throw new ServiceUnavailableException(
      'La consulta remota de comprobantes aún no está habilitada para SUNAT directo. Revise el estado del envío BETA en Documentos.',
    );
  }

  // ── Anular ───────────────────────────────────────────────────

  async anular(dto: AnularComprobanteRequest): Promise<AnulacionResponse> {
    void dto;
    throw new ServiceUnavailableException(
      'La anulación electrónica directa todavía no está implementada. No se enviará la solicitud a un proveedor externo.',
    );
  }

  async consultarAnulacion(dto: ConsultarComprobanteRequest): Promise<AnulacionResponse> {
    void dto;
    throw new ServiceUnavailableException(
      'La consulta de anulaciones aún no está habilitada para SUNAT directo.',
    );
  }

  // ── Listados ─────────────────────────────────────────────────

  async listar(filtro: FiltroComprobantes) {
    const resultado = await this.repo.listar(filtro);
    return { ...resultado, datos: resultado.datos.map((c) => this.mapListado(c)) };
  }

  /** Contador para badge de Documentos (CPE pendiente/error). */
  async monitorAtencion() {
    return this.repo.contarAtencion();
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
    throw new NotFoundException(
      c.proveedor_fiscal === 'sunat_directo' && c.ambiente_fiscal === 'beta'
        ? 'Este comprobante SUNAT BETA no tiene un PDF disponible.'
        : 'La descarga remota de PDF no está habilitada para comprobantes históricos.',
    );
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

  private limpiarTexto(texto: string): string {
    return (texto ?? '')
      .toString()
      .replace(/"/g, "''")
      .replace(/[\r\n\t]+/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }

  /** Fecha de hoy en Perú (dd-mm-yyyy). */
  private fechaHoyLima(): string {
    const partes = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Lima',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date());

    const anio = partes.find((p) => p.type === 'year')?.value ?? '1970';
    const mes = partes.find((p) => p.type === 'month')?.value ?? '01';
    const dia = partes.find((p) => p.type === 'day')?.value ?? '01';
    return `${dia}-${mes}-${anio}`;
  }

  private normalizarFecha(fecha?: string): string {
    const texto = (fecha ?? '').trim();

    if (/^\d{2}-\d{2}-\d{4}$/.test(texto)) return texto;
    if (/^\d{4}-\d{2}-\d{2}$/.test(texto)) {
      const [anio, mes, dia] = texto.split('-');
      return `${dia}-${mes}-${anio}`;
    }

    return this.fechaHoyLima();
  }

  private estadoVisible(c: Comprobante): string {
    if (c.anulado) return 'anulado';
    if (c.estado === 'error' || c.estado === 'pendiente') return c.estado;
    return c.aceptada_sunat ? 'aceptado' : 'emitido';
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
      proveedor_fiscal: c.proveedor_fiscal ?? undefined,
      ambiente_fiscal: c.ambiente_fiscal ?? undefined,
      estado_sunat: c.estado_sunat ?? undefined,
      id_envio_ultimo: c.id_envio_ultimo ?? undefined,
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
      proveedor_fiscal: c.proveedor_fiscal,
      ambiente_fiscal: c.ambiente_fiscal,
      estado_sunat: c.estado_sunat,
      id_envio_ultimo: c.id_envio_ultimo,
      puede_reintentar:
        c.proveedor_fiscal === 'sunat_directo' && c.ambiente_fiscal === 'beta'
          ? c.estado_sunat === 'ENVIANDO' || c.estado_sunat === 'PENDIENTE_REENVIO'
          : false,
      puede_anular: false,
    };
  }
}

import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import {
  VentaRepository,
  FiltroVentas,
  LineaVentaPersistida,
  VentaParaComprobante,
} from '../../repository/Repository/venta.repository';
import { ConfiguracionRepository } from '../../repository/Repository/configuracion.repository';
import { CreditoRepository } from '../../repository/Repository/credito.repository';
import { CajaPagosRepository } from '../../repository/Repository/caja-pagos.repository';
import { ComprobanteBussnies } from './comprobante.bussnies';
import { ReceptorBussnies } from './receptor.bussnies';
import { CreditoBussnies } from './credito.bussnies';
import { CrearVentaRequest, EmitirComprobanteVentaRequest, ItemVentaRequest } from '../../models/model/venta/venta.request';
import { VentaResponse } from '../../models/model/venta/venta.response';
import { GenerarComprobanteRequest } from '../../models/model/c-electronico/comprobante.request';
import { ComprobanteResponse, PreviewComprobanteResponse } from '../../models/model/c-electronico/comprobante.response';
import { esComprobantePrincipal } from '../../util/fiscal/tipos-comprobante';
import { hoyLima } from '../../util/fecha-lima';
import type { UsuarioToken } from '../../guards/usuario-actual.decorator';
import {
  calcularComprobante,
  PORCENTAJE_IGV_POR_DEFECTO,
  redondear,
  ResumenFiscal,
} from '../../util/fiscal/calculo-fiscal';
import { CodigoError, cuerpoError } from '../../util/errores-operativos';
import { pasarelaConfig } from '../../config/pasarela.config';
import { CajaSesionBussnies } from './caja-sesion.bussnies';
import { NotaCreditoBussnies } from './nota-credito.bussnies';
import type { AnularVentaRequest } from '../../models/model/venta/anular-venta.request';
import type { AnulacionVentaResponse } from '../../models/model/c-electronico/nota-credito.response';
import { normalizarRol } from '../../config/roles.config';
import { resolverPrecioVenta } from '../../util/precios/precio-venta';
import {
  CLAVE_RECARGO_TARJETA_PCT,
  CODIGO_RECARGO_TARJETA,
  DESCRIPCION_RECARGO_TARJETA,
  RECARGO_TARJETA_PCT_DEFECTO,
  UNIDAD_RECARGO_TARJETA,
  RecargoTarjeta,
  calcularRecargoTarjeta,
  esMetodoTarjeta,
  normalizarPorcentajeRecargo,
  repartirRecargoPorAfectacion,
} from '../../util/precios/recargo-tarjeta';

/** Línea del comprobante que cobra el recargo por tarjeta: no es un producto, no mueve stock. */
interface ItemRecargo {
  descripcion: string;
  codigo: string;
  unidad_de_medida: string;
  cantidad: number;
  precio_unitario: number;
  descuento: number;
  tipo_de_igv: number;
}

const SIN_RECARGO: RecargoTarjeta = { aplica: false, porcentaje: 0, base_tarjeta: 0, monto: 0 };

/**
 * Punto de venta de mostrador.
 *
 * La venta y el comprobante son dos pasos separados a propósito: la mercadería
 * ya salió del almacén, así que un rechazo de SUNAT no debe deshacer la
 * venta. Queda registrada con el comprobante pendiente y se puede reintentar.
 */
@Injectable()
export class VentaBussnies {

  private readonly logger = new Logger(VentaBussnies.name);

  constructor(
    private readonly repo: VentaRepository,
    private readonly config: ConfiguracionRepository,
    private readonly comprobantes: ComprobanteBussnies,
    private readonly receptor: ReceptorBussnies,
    private readonly creditoRepo: CreditoRepository,
    private readonly credito: CreditoBussnies,
    private readonly cajaPagosRepo: CajaPagosRepository,
    private readonly cajaSesion: CajaSesionBussnies,
    private readonly notasCredito?: NotaCreditoBussnies,
  ) {}

  // ── Apoyo al mostrador ───────────────────────────────────────

  buscarProductos(termino: string, limite?: number, idAlmacen?: number) {
    return this.repo.buscarProductos(termino, limite, idAlmacen);
  }

  /** Catálogo activo para cache del mostrador (misma forma que autocompletado). */
  catalogoProductos(limite?: number, idAlmacen?: number) {
    return this.repo.catalogoProductos(limite, idAlmacen);
  }

  async buscarPorCodigoBarras(codigo: string, idAlmacen?: number) {
    // Mismo criterio que el front: sin caracteres de control (\r \n \t...) ni espacios en los bordes.
    // eslint-disable-next-line no-control-regex
    const limpio = String(codigo ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
    if (!limpio) throw new BadRequestException('Indique el código a buscar');
    const producto = await this.repo.buscarPorCodigoBarras(limpio, idAlmacen);
    if (producto) return producto;

    // Inactivo ≠ inexistente: así el mostrador no ofrece «crear» un producto que ya existe.
    const inactivo = await this.repo.buscarInactivoPorCodigo(limpio);
    if (inactivo) {
      throw new ConflictException({
        codigo: 'PRODUCTO_INACTIVO',
        id_producto: inactivo.id_producto,
        message: `El producto "${inactivo.nombre}" existe pero está inactivo`,
      });
    }
    throw new NotFoundException(`No hay ningún producto con el código ${limpio}`);
  }

  /**
   * Almacenes disponibles para el POS + default de configuración.
   * El cajero elige almacén cuando debe despachar desde otra sede.
   */
  async contextoPos(): Promise<{
    almacenes: { id_almacen: number; nombre: string; sucursal: string; id_sucursal: number | null }[];
    almacen_default?: number;
    /** % que se suma a la parte de la venta cobrada con tarjeta (0 = sin recargo). */
    recargo_tarjeta_pct: number;
  }> {
    const filas = await this.repo.listarAlmacenesPos();
    const def = await this.almacenPorDefecto();
    return {
      almacenes: filas,
      ...(def ? { almacen_default: def } : {}),
      recargo_tarjeta_pct: await this.porcentajeRecargoTarjeta(),
    };
  }

  async metodosPago() {
    return this.creditoRepo.metodosConTipo();
  }

  /**
   * Vista previa del comprobante desde el carrito del mostrador. Si algún pago es
   * con tarjeta, ya trae el recargo como línea y dentro del total: lo que ve el
   * cajero es lo que se cobra, se registra y se envía a SUNAT.
   */
  async previsualizar(dto: CrearVentaRequest): Promise<PreviewComprobanteResponse> {
    const { items, itemsRecargo, recargo, totalSinRecargo } = await this.armarLineas(dto);
    const base = await this.comprobantes.previsualizar(this.aSolicitudComprobante(dto, items, itemsRecargo));
    const formaPago = await this.formaPagoDeVistaPrevia(dto);
    const preview = formaPago ? { ...base, forma_pago: formaPago } : base;
    if (!recargo.aplica) return preview;
    return {
      ...preview,
      recargo_tarjeta: {
        porcentaje: recargo.porcentaje,
        base_tarjeta: recargo.base_tarjeta,
        monto: recargo.monto,
        total_sin_recargo: totalSinRecargo,
      },
    };
  }

  /**
   * Forma de pago que llevará el comprobante, para que la vista previa diga lo mismo que el PDF:
   * crédito si algún medio elegido es el crédito (con monto, o sin monto todavía cuando es lo único
   * elegido), contado en los demás casos. Sin medios elegidos no se afirma nada. Nunca falla: es solo
   * informativo y el registro de la venta vuelve a validarlo.
   */
  private async formaPagoDeVistaPrevia(dto: CrearVentaRequest): Promise<'Contado' | 'Credito' | undefined> {
    const pagos = (dto.pagos ?? []).filter((p) => p.id_metodo != null);
    if (!pagos.length) return undefined;
    try {
      const metodos = await this.creditoRepo.metodosConTipo();
      const idCredito = await this.creditoRepo.idMetodoCredito();
      const esCredito = (idMetodo: unknown) => {
        const tipo = String(metodos.find((m) => Number(m.id_metodo) === Number(idMetodo))?.tipo ?? '').toLowerCase();
        return tipo === 'credito' || (idCredito != null && Number(idMetodo) === idCredito);
      };
      const hayMontos = pagos.some((p) => Number(p.monto) > 0);
      const elegidosCredito = pagos.filter((p) => esCredito(p.id_metodo));
      const credito = hayMontos ? elegidosCredito.some((p) => Number(p.monto) > 0) : elegidosCredito.length === pagos.length;
      return credito ? 'Credito' : 'Contado';
    } catch (error) {
      this.logger.warn(`No se pudo derivar la forma de pago de la vista previa: ${(error as Error)?.message ?? error}`);
      return undefined;
    }
  }

  // ── Registrar ────────────────────────────────────────────────

  async registrar(dto: CrearVentaRequest, usuario?: UsuarioToken): Promise<VentaResponse> {
    if (!Array.isArray(dto.items) || dto.items.length === 0) {
      throw new BadRequestException(
        cuerpoError(CodigoError.VENTA_SIN_ITEMS, 'Agregue al menos un producto a la venta'),
      );
    }

    // C4: solo si caja_modo=estricto (default blando = no bloquea). Tienda no aplica.
    await this.assertCajaModoSiEstricto(usuario);

    const claveIdempotencia = dto.clave_idempotencia?.trim() || undefined;
    if (claveIdempotencia) {
      const existente = await this.repo.buscarPorClaveIdempotencia(claveIdempotencia);
      if (existente) return this.ventaYaRegistrada(existente, dto);
    }

    const { items, itemsRecargo, resumen, recargo } = await this.armarLineas(dto);
    const receptor = await this.resolverReceptor(dto);
    const { pagos, credito } = await this.validarPagosYCredito(dto, resumen.total, receptor, usuario);

    const lineas: LineaVentaPersistida[] = items.map((item, indice) => {
      const linea = resumen.lineas[indice];
      return {
        id_producto: item.id_producto,
        descripcion: item.descripcion,
        cantidad: linea.cantidad,
        precio_unitario: linea.precio_unitario,
        descuento: linea.descuento,
        subtotal: linea.subtotal,
        igv: linea.igv,
        total: linea.total,
        precio_lista_unitario: items[indice].precio_lista_unitario,
        descuento_unitario_aplicado: items[indice].descuento_unitario_aplicado,
        descuento_total_linea: items[indice].descuento_total_linea,
        precio_unitario_final: items[indice].precio_unitario_final,
        id_regla_mayorista: items[indice].id_regla_mayorista,
      };
    });

    const idAlmacen = dto.id_almacen ?? (await this.almacenPorDefecto());

    let idVenta: number;
    let ventaExistente = false;
    try {
      const resultado = await this.repo.registrar(
        {
          id_cliente: receptor.id_cliente,
          id_empresa: receptor.id_empresa,
          id_caja: dto.id_caja,
          id_usuario: usuario?.id_usuario,
          subtotal: resumen.total_gravada + resumen.total_exonerada + resumen.total_inafecta,
          igv: resumen.total_igv,
          descuento: resumen.total_descuento,
          total: resumen.total,
           origen: 'mostrador',
           clave_idempotencia: claveIdempotencia,
           observaciones: dto.observaciones,
           id_proforma: dto.id_proforma,
           credito,
        },
        lineas,
        pagos,
        {
          descontarStock: dto.descontar_stock ?? true,
          idAlmacenPreferido: idAlmacen,
        },
      );
      idVenta = resultado.id_venta;
      ventaExistente = resultado.existente;
    } catch (error: any) {
      // Carrera de idempotencia: el índice único ganó en otra petición.
      if (claveIdempotencia && this.esViolacionUnica(error)) {
        const existente = await this.repo.buscarPorClaveIdempotencia(claveIdempotencia);
        if (existente) return this.ventaYaRegistrada(existente, dto);
      }
      throw this.traducirErrorDeStock(error, items);
    }

    // Un reintento idempotente devuelve la venta existente sin volver a emitir ni repetir
    // efectos externos; si quedó sin comprobante, lo dice para que el mostrador ofrezca emitirlo.
    const venta = ventaExistente ? await this.ventaYaRegistrada(idVenta, dto) : await this.obtener(idVenta);
    if (recargo.aplica) venta.recargo_tarjeta = recargo.monto;
    if (ventaExistente) return venta;

    if (dto.emitir_comprobante === false) return venta;

    try {
      const medio = await this.nombreMedioPago(pagos);
      const anonimo = receptor.origen === 'generico' || /^0*$/.test(String(receptor.numero_documento ?? ''));
      venta.comprobante = await this.comprobantes.generar(
        {
          ...this.aSolicitudComprobante(dto, items, itemsRecargo),
          id_venta: idVenta,
          id_cliente: receptor.id_cliente,
          id_empresa: receptor.id_empresa,
          documento: anonimo ? undefined : receptor.numero_documento,
          medio_de_pago: medio,
          forma_pago: credito ? 'Credito' : 'Contado',
          condiciones_de_pago: credito ? 'Crédito' : 'Contado',
          monto_credito: credito?.monto,
          fecha_de_vencimiento: credito
            ? this.fechaLimaMasDias(credito.dias)
            : undefined,
        },
        usuario?.id_usuario ?? null,
      );
      this.avisarSiNoAceptado(venta);
    } catch (error: any) {
      const mensaje = error?.response?.message ?? error?.message ?? 'No se pudo emitir el comprobante';
      this.logger.warn(`Venta ${idVenta} registrada sin comprobante: ${mensaje}`);
      venta.comprobante_error = String(mensaje);
      // generar() solo falla antes de guardar nada: la venta quedó sin comprobante y se puede emitir después.
      venta.comprobante_pendiente = true;
    }

    return venta;
  }

  /**
   * Emite la factura o boleta de una venta que quedó sin comprobante (emisión inactiva, SUNAT
   * caída, datos del cliente incompletos…). Las líneas salen de la venta guardada tal como se
   * cobró (precios, descuentos y el recargo por tarjeta) y el comprobante debe sumar EXACTAMENTE
   * el total cobrado: nunca se recalcula con los precios actuales del catálogo.
   */
  async emitirComprobanteDeVenta(
    idVenta: number,
    dto: EmitirComprobanteVentaRequest,
    usuario?: UsuarioToken,
  ): Promise<VentaResponse> {
    const venta = await this.repo.obtenerParaComprobante(idVenta);
    if (!venta) throw new NotFoundException(`No existe la venta ${idVenta}`);
    if (venta.estado.trim().toLowerCase() === 'anulada') {
      throw new ConflictException(
        cuerpoError(CodigoError.COMPROBANTE_EMISION_FALLIDA, `La venta ${idVenta} está anulada: no se le emite comprobante.`),
      );
    }

    const vigente = this.comprobantePrincipalVigente(await this.comprobantes.listarPorVenta(idVenta));
    if (vigente) {
      throw new ConflictException({
        message: `La venta ${idVenta} ya tiene el comprobante ${vigente.numero_formateado}. No se emite otro para no duplicarlo.`,
        codigo: 'VENTA_CON_COMPROBANTE',
        id_comprobante: vigente.id_comprobante,
      });
    }
    if (!venta.lineas.length) {
      throw new BadRequestException(
        cuerpoError(CodigoError.COMPROBANTE_EMISION_FALLIDA, `La venta ${idVenta} no tiene productos registrados para emitir su comprobante.`),
      );
    }

    const solicitud = await this.solicitudDesdeVentaGuardada(venta, dto);
    const respuesta = await this.obtener(idVenta);
    try {
      respuesta.comprobante = await this.comprobantes.generar(solicitud, usuario?.id_usuario ?? null, {
        totalExigido: venta.total,
      });
      this.avisarSiNoAceptado(respuesta);
    } catch (error: any) {
      // Otro comprobante ganó la carrera o el total no cuadra: son errores de la acción, no de SUNAT.
      if (error instanceof ConflictException || error instanceof BadRequestException) throw error;
      const mensaje = error?.response?.message ?? error?.message ?? 'No se pudo emitir el comprobante';
      this.logger.warn(`Venta ${idVenta}: no se pudo emitir su comprobante: ${mensaje}`);
      respuesta.comprobante_error = String(mensaje);
      respuesta.comprobante_pendiente = true;
    }
    return respuesta;
  }

  // ── Consultas ────────────────────────────────────────────────

  async obtener(idVenta: number): Promise<VentaResponse> {
    const venta = await this.repo.obtener(idVenta);
    if (!venta) throw new NotFoundException(`No existe la venta ${idVenta}`);

    const comprobantes = await this.comprobantes.listarPorVenta(idVenta);

    return {
      id_venta: Number(venta.id_venta),
      fecha: venta.fecha,
      origen: venta.origen,
      id_cliente: venta.id_cliente ? Number(venta.id_cliente) : undefined,
      id_empresa: venta.id_empresa ? Number(venta.id_empresa) : undefined,
      cliente_denominacion: venta.cliente_denominacion?.trim() || 'CLIENTES VARIOS',
      subtotal: Number(venta.subtotal ?? 0),
      igv: Number(venta.igv ?? 0),
      descuento: 0,
      total: Number(venta.total ?? 0),
      items: (venta.items ?? []).map((i: any) => {
        const precio = Number(i.precio ?? 0);
        const cantidad = Number(i.cantidad ?? 0);
        const total = redondear(precio * cantidad);
        return {
          id_producto: Number(i.id_producto),
          descripcion: i.descripcion,
          cantidad,
          precio_unitario: precio,
          descuento: 0,
          subtotal: total,
          igv: 0,
          total,
        };
      }),
      pagos: (venta.pagos ?? []).map((p: any) => ({
        id_metodo: p.id_metodo ? Number(p.id_metodo) : undefined,
        monto: Number(p.monto ?? 0),
      })),
      comprobante: comprobantes[0],
    };
  }

  listar(filtro: FiltroVentas) {
    return this.repo.listar(filtro);
  }

  /**
   * Anula la venta según D9 (lo resuelve el negocio de notas de crédito): sin comprobante válido se
   * anula en el sistema (stock al almacén de salida, cuentas por cobrar cerradas); con comprobante
   * aceptado por SUNAT se emite la nota de crédito y la venta se anula cuando SUNAT la acepte.
   */
  async anular(idVenta: number, dto: AnularVentaRequest = {}, usuario?: UsuarioToken): Promise<AnulacionVentaResponse> {
    if (!this.notasCredito) {
      throw new ServiceUnavailableException('La anulación de ventas no está disponible en este momento. Intente de nuevo en unos minutos.');
    }
    return this.notasCredito.anularVenta(idVenta, dto, usuario?.id_usuario ?? null);
  }

  // ── Interno ──────────────────────────────────────────────────

  /**
   * Venta que ya estaba registrada (reintento con la misma clave de idempotencia). Si se pidió
   * comprobante y no tiene uno principal vigente ni en curso, lo informa con `comprobante_pendiente`.
   */
  private async ventaYaRegistrada(idVenta: number, dto: CrearVentaRequest): Promise<VentaResponse> {
    const venta = await this.obtener(idVenta);
    if (dto.emitir_comprobante === false) return venta;
    // obtener() trae primero el comprobante principal vigente, si lo hay.
    if (this.comprobantePrincipalVigente(venta.comprobante ? [venta.comprobante] : [])) return venta;
    venta.comprobante_pendiente = true;
    venta.comprobante_error ??=
      'La venta ya estaba registrada y no tiene comprobante electrónico: emítalo desde Ventas («Emitir comprobante»).';
    return venta;
  }

  /** Factura o boleta de la venta que no está anulada ni en error (emitida o con su envío en curso). */
  private comprobantePrincipalVigente(lista: ComprobanteResponse[]): ComprobanteResponse | undefined {
    return lista.find((c) => esComprobantePrincipal(c.tipo_de_comprobante) && !c.anulado && c.estado !== 'error');
  }

  /** El comprobante quedó guardado pero SUNAT no lo aceptó (todavía): el mostrador debe verlo. */
  private avisarSiNoAceptado(venta: VentaResponse): void {
    const comprobante = venta.comprobante;
    if (!comprobante || comprobante.aceptada_sunat) return;
    venta.comprobante_error =
      comprobante.error ||
      comprobante.sunat_description ||
      'SUNAT no confirmó la aceptación del comprobante. Revíselo en Documentos antes de reintentar.';
    // Rechazado o con error ya no cuenta como el comprobante de la venta: se puede emitir otro.
    if (comprobante.estado === 'error') venta.comprobante_pendiente = true;
  }

  /**
   * Solicitud de comprobante con las líneas tal como se cobraron. El recargo por tarjeta no se
   * guarda en detalle_venta: es la diferencia entre el total cobrado y los productos, y solo se
   * acepta si se pagó con tarjeta; se reparte por afectación igual que al cobrar.
   */
  private async solicitudDesdeVentaGuardada(
    venta: VentaParaComprobante,
    dto: EmitirComprobanteVentaRequest,
  ): Promise<GenerarComprobanteRequest> {
    const porcentajeIgv = await this.config.obtenerNumero('tienda_igv_porcentaje', PORCENTAJE_IGV_POR_DEFECTO);

    const items = venta.lineas.map((linea, indice) => {
      const precio = redondear(linea.precio > 0 ? linea.precio : linea.precio_lista_unitario ?? 0);
      const bruto = redondear(precio * linea.cantidad);
      const descuento = linea.descuento_total_linea
        ?? (linea.total !== null ? Math.max(0, redondear(bruto - linea.total)) : 0);
      // Una línea con importe y sin IGV fue exonerada o inafecta, y la venta no guarda cuál de las dos.
      if (porcentajeIgv > 0 && linea.igv === 0 && (linea.total ?? 0) > 0) {
        throw new BadRequestException(
          cuerpoError(
            CodigoError.COMPROBANTE_EMISION_FALLIDA,
            `La línea ${indice + 1} (${linea.descripcion}) se vendió sin IGV y la venta no indica si fue exonerada o inafecta: no se puede declarar a SUNAT con certeza.`,
          ),
        );
      }
      return {
        id_producto: linea.id_producto ?? undefined,
        codigo: linea.codigo,
        codigo_producto_sunat: linea.codigo_sunat ?? undefined,
        unidad_de_medida: linea.unidad_de_medida,
        descripcion: linea.descripcion,
        cantidad: linea.cantidad,
        precio_unitario: precio,
        descuento: redondear(descuento),
        tipo_de_igv: 1,
      };
    });

    const productos = calcularComprobante(items, porcentajeIgv);
    const diferencia = redondear(venta.total - productos.total);
    const conTarjeta = venta.pagos.some((pago) => esMetodoTarjeta({ tipo: pago.tipo, nombre: pago.metodo }));
    const itemsRecargo = diferencia > 0 && conTarjeta
      ? repartirRecargoPorAfectacion(productos.lineas, diferencia).map((tramo) => ({
          codigo: CODIGO_RECARGO_TARJETA,
          unidad_de_medida: UNIDAD_RECARGO_TARJETA,
          descripcion: DESCRIPCION_RECARGO_TARJETA,
          cantidad: 1,
          precio_unitario: tramo.monto,
          descuento: 0,
          tipo_de_igv: tramo.tipo_de_igv,
        }))
      : [];

    // Receptor del pedido; si no se indicó ninguno, el cliente o la empresa de la venta.
    const propio = !!(dto.documento?.trim() || dto.id_empresa || dto.id_cliente);
    const receptor = await this.resolverReceptor(
      propio ? dto : { id_empresa: venta.id_empresa ?? undefined, id_cliente: venta.id_cliente ?? undefined },
    );
    const anonimo = receptor.origen === 'generico' || /^0*$/.test(String(receptor.numero_documento ?? ''));

    // Crédito: lo que todavía se debe. Ya pagado del todo, el comprobante sale al contado.
    const credito = venta.credito && venta.credito.saldo > 0 ? venta.credito : null;
    if (credito && (!credito.fecha_vencimiento || credito.fecha_vencimiento <= hoyLima())) {
      throw new BadRequestException(
        cuerpoError(
          CodigoError.COMPROBANTE_EMISION_FALLIDA,
          `La venta tiene S/ ${credito.saldo.toFixed(2)} al crédito con vencimiento ${credito.fecha_vencimiento ?? 'sin fecha'}: SUNAT exige que la cuota venza después de la emisión. Registre el cobro en Cuentas por cobrar y vuelva a intentarlo.`,
        ),
      );
    }

    return {
      id_tipo: dto.id_tipo,
      id_moneda: 1,
      id_venta: venta.id_venta,
      id_cliente: receptor.id_cliente,
      id_empresa: receptor.id_empresa,
      documento: anonimo ? undefined : receptor.numero_documento,
      observaciones: dto.observaciones,
      medio_de_pago: venta.pagos.map((pago) => pago.metodo).filter(Boolean).join(' + ') || undefined,
      forma_pago: credito ? 'Credito' : 'Contado',
      condiciones_de_pago: credito ? 'Crédito' : 'Contado',
      monto_credito: credito ? credito.saldo : undefined,
      fecha_de_vencimiento: credito?.fecha_vencimiento ?? undefined,
      items: [...items, ...itemsRecargo],
    };
  }

  /**
   * Los precios se toman del producto en base de datos, no de lo que envía el
   * navegador. Solo se acepta un precio distinto si viene explícito, para
   * permitir un ajuste manual en el mostrador.
   */
  private async armarLineas(dto: CrearVentaRequest) {
    const ids = [...new Set(dto.items.map((i) => Number(i.id_producto)).filter(Boolean))];
    const productos = await this.repo.cargarProductos(ids);

    const faltantes = ids.filter((id) => !productos.has(id));
    if (faltantes.length) {
      throw new BadRequestException(`No se encontraron los productos: ${faltantes.join(', ')}`);
    }

    const items = dto.items.map((item: ItemVentaRequest) => {
      const producto = productos.get(Number(item.id_producto))!;
      const precioLista = Number(item.precio_unitario ?? producto.precio_venta ?? 0);
      const descuentoUnitario = Number(item.descuento ?? producto.descuento ?? 0);
      const precio = resolverPrecioVenta({
        precio_lista: precioLista,
        descuento_producto: descuentoUnitario,
        cantidad: Number(item.cantidad),
        reglas_mayoristas: producto.reglas_mayoristas,
      });

      if (precio.precio_lista_unitario <= 0) {
        throw new BadRequestException(`El producto "${producto.nombre}" no tiene precio de venta configurado`);
      }

      return {
        id_producto: producto.id_producto,
        descripcion: producto.nombre,
        codigo: producto.sku || producto.codigo_barras || String(producto.id_producto),
        unidad_de_medida: producto.unidad_medida || 'NIU',
        cantidad: Number(item.cantidad),
        precio_unitario: precio.precio_lista_unitario,
        descuento: precio.descuento_total_linea,
        precio_lista_unitario: precio.precio_lista_unitario,
        descuento_unitario_aplicado: precio.descuento_unitario_aplicado,
        descuento_total_linea: precio.descuento_total_linea,
        precio_unitario_final: precio.precio_unitario_final,
        id_regla_mayorista: precio.id_regla_mayorista,
        tipo_de_igv: item.tipo_de_igv,
        stock_disponible: producto.stock_disponible,
        codigo_sunat: producto.codigo_sunat ?? null,
      };
    });

    const porcentajeIgv = await this.config.obtenerNumero(
      'tienda_igv_porcentaje',
      PORCENTAJE_IGV_POR_DEFECTO,
    );

    const lineasProductos = items.map((i) => ({
      cantidad: i.cantidad,
      precio_unitario: i.precio_unitario,
      descuento: i.descuento,
      tipo_de_igv: i.tipo_de_igv,
    }));
    const resumenProductos = calcularComprobante(lineasProductos, porcentajeIgv);

    // El recargo por tarjeta se calcula sobre el total ya con descuentos y va como línea
    // aparte AL FINAL: los productos conservan su posición (detalle de la venta y stock).
    const { recargo, itemsRecargo } = await this.resolverRecargoTarjeta(dto, resumenProductos);
    const resumen = itemsRecargo.length
      ? calcularComprobante(
          [
            ...lineasProductos,
            ...itemsRecargo.map((r) => ({
              cantidad: r.cantidad,
              precio_unitario: r.precio_unitario,
              descuento: r.descuento,
              tipo_de_igv: r.tipo_de_igv,
            })),
          ],
          porcentajeIgv,
        )
      : resumenProductos;

    return { items, itemsRecargo, resumen, recargo, totalSinRecargo: resumenProductos.total };
  }

  /** % vigente del recargo por tarjeta (0 = desactivado); lo lee el POS para el cálculo en vivo. */
  private async porcentajeRecargoTarjeta(): Promise<number> {
    return normalizarPorcentajeRecargo(
      await this.config.obtenerNumero(CLAVE_RECARGO_TARJETA_PCT, RECARGO_TARJETA_PCT_DEFECTO),
    );
  }

  /**
   * Recargo por cobrar con tarjeta. Solo se consulta lo necesario: sin pagos o sin ningún
   * medio de tarjeta no se lee ni la configuración. Es parte del precio de la venta: sube
   * el total, los pagos deben cubrirlo y el comprobante lo declara como una línea más.
   */
  private async resolverRecargoTarjeta(
    dto: CrearVentaRequest,
    resumen: ResumenFiscal,
  ): Promise<{ recargo: RecargoTarjeta; itemsRecargo: ItemRecargo[] }> {
    const ninguno = { recargo: SIN_RECARGO, itemsRecargo: [] as ItemRecargo[] };
    const pagos = dto.pagos ?? [];
    if (!pagos.length) return ninguno;

    const metodos = await this.creditoRepo.metodosConTipo();
    const tarjetas = new Set(metodos.filter((m) => esMetodoTarjeta(m)).map((m) => Number(m.id_metodo)));
    const entradas = pagos.map((p) => ({
      tarjeta: p.id_metodo != null && tarjetas.has(Number(p.id_metodo)),
      monto: Number(p.monto) || 0,
    }));
    if (!entradas.some((p) => p.tarjeta)) return ninguno;

    const porcentaje = await this.porcentajeRecargoTarjeta();
    const recargo = calcularRecargoTarjeta(resumen.total, entradas, porcentaje);
    if (!recargo.aplica) return { recargo, itemsRecargo: [] };

    const etiqueta = `${DESCRIPCION_RECARGO_TARJETA} (${Number(recargo.porcentaje.toFixed(2))}%)`;
    const itemsRecargo = repartirRecargoPorAfectacion(resumen.lineas, recargo.monto).map((tramo) => ({
      descripcion: etiqueta,
      codigo: CODIGO_RECARGO_TARJETA,
      unidad_de_medida: UNIDAD_RECARGO_TARJETA,
      cantidad: 1,
      precio_unitario: tramo.monto,
      descuento: 0,
      tipo_de_igv: tramo.tipo_de_igv,
    }));
    return { recargo, itemsRecargo };
  }

  /** Solicitud del comprobante desde el carrito. Lleva el código SUNAT de cada producto (catálogo 25), si lo tiene. */
  private aSolicitudComprobante(
    dto: CrearVentaRequest,
    items: {
      id_producto: number;
      descripcion: string;
      codigo: string;
      unidad_de_medida: string;
      cantidad: number;
      precio_unitario: number;
      descuento: number;
      tipo_de_igv?: number;
      codigo_sunat?: string | null;
    }[],
    itemsRecargo: ItemRecargo[] = [],
  ): GenerarComprobanteRequest {
    return {
      documento: dto.documento,
      id_cliente: dto.id_cliente,
      id_empresa: dto.id_empresa,
      id_tipo: dto.id_tipo,
      id_moneda: dto.id_moneda ?? 1,
      serie: dto.serie,
      observaciones: dto.observaciones,
      enviar_cliente: dto.enviar_cliente,
      correo_cliente: dto.correo_cliente,
      items: [
        ...items.map((i) => ({
          id_producto: i.id_producto,
          codigo: i.codigo,
          ...(i.codigo_sunat ? { codigo_producto_sunat: i.codigo_sunat } : {}),
          unidad_de_medida: i.unidad_de_medida,
          descripcion: i.descripcion,
          cantidad: i.cantidad,
          precio_unitario: i.precio_unitario,
          descuento: i.descuento,
          tipo_de_igv: i.tipo_de_igv,
        })),
        ...itemsRecargo.map((r) => ({
          codigo: r.codigo,
          unidad_de_medida: r.unidad_de_medida,
          descripcion: r.descripcion,
          cantidad: r.cantidad,
          precio_unitario: r.precio_unitario,
          descuento: r.descuento,
          tipo_de_igv: r.tipo_de_igv,
        })),
      ],
    } as GenerarComprobanteRequest;
  }

  private async resolverReceptor(
    dto: Pick<CrearVentaRequest, 'documento' | 'cliente_denominacion' | 'cliente_direccion' | 'id_empresa' | 'id_cliente'>,
  ) {
    const documento = (dto.documento ?? '').replace(/\D/g, '');
    const nombre = dto.cliente_denominacion?.trim();
    const direccion = dto.cliente_direccion?.trim();

    if (documento) {
      const receptor = await this.receptor.buscarPorDocumento(documento, true);

      // Si SUNAT no respondió y el cajero escribió el nombre, se guarda aquí.
      if (!receptor.denominacion?.trim() && nombre) {
        return this.receptor.registrarManual(documento, {
          denominacion: nombre,
          direccion: direccion ?? '',
        });
      }

      if (!receptor.denominacion?.trim() && documento !== '00000000') {
        throw new BadRequestException(
          'Indique el nombre o razón social del cliente. La consulta automática no está disponible.',
        );
      }

      return receptor;
    }

    if (dto.id_empresa) return this.receptor.porIdEmpresa(dto.id_empresa);
    if (dto.id_cliente) return this.receptor.porIdCliente(dto.id_cliente);
    return this.receptor.consumidorFinal();
  }

  private async validarPagosYCredito(
    dto: CrearVentaRequest,
    total: number,
    receptor: { id_cliente?: number; id_empresa?: number; numero_documento?: string },
    usuario?: UsuarioToken,
  ) {
    const metodos = await this.creditoRepo.metodosConTipo();
    const mapaTipo = new Map(metodos.map((m) => [Number(m.id_metodo), String(m.tipo || '').toLowerCase()]));
    const idCredito = await this.creditoRepo.idMetodoCredito();

    let pagos = (dto.pagos ?? []).filter((p) => Number(p.monto) > 0);
    if (!pagos.length) pagos = [{ monto: total }];

    const suma = redondear(pagos.reduce((acumulado, p) => acumulado + Number(p.monto), 0));
    if (Math.abs(suma - total) > 0.05) {
      throw new BadRequestException(
        cuerpoError(
          CodigoError.PAGOS_NO_CUADRAN,
          `Los pagos suman S/ ${suma.toFixed(2)} y el total es S/ ${total.toFixed(2)}`,
        ),
      );
    }

    const montoCredito = redondear(
      pagos
        .filter((p) => {
          const tipo = mapaTipo.get(Number(p.id_metodo)) ?? '';
          return tipo === 'credito' || (idCredito && Number(p.id_metodo) === idCredito);
        })
        .reduce((a, p) => a + Number(p.monto), 0),
    );

    let credito: {
      monto: number;
      dias: number;
      id_cliente?: number | null;
      id_empresa?: number | null;
    } | undefined;

    if (montoCredito > 0) {
      this.credito.assertPuedeDarCredito(usuario);

      const doc = String(receptor.numero_documento ?? '');
      if (doc === '00000000' || (!receptor.id_cliente && !receptor.id_empresa)) {
        throw new BadRequestException(
          cuerpoError(
            CodigoError.CREDITO_SIN_CLIENTE,
            'El crédito solo aplica a clientes o empresas registradas. Busque DNI/RUC antes de cobrar.',
          ),
        );
      }

      const linea = receptor.id_empresa
        ? await this.creditoRepo.lineaEmpresa(Number(receptor.id_empresa))
        : await this.creditoRepo.lineaCliente(Number(receptor.id_cliente));

      if (!linea?.credito_activo) {
        throw new BadRequestException(
          cuerpoError(
            CodigoError.CREDITO_INACTIVO,
            'Este cliente/empresa no tiene crédito activo. Actívelo en Cuentas por cobrar (límite y días).',
          ),
        );
      }
      if (montoCredito > linea.disponible + 0.05) {
        throw new BadRequestException(
          cuerpoError(
            CodigoError.CREDITO_INSUFICIENTE,
            `Crédito insuficiente. Disponible S/ ${linea.disponible.toFixed(2)} (límite ${linea.limite_credito.toFixed(2)}, deuda ${linea.saldo_pendiente.toFixed(2)}).`,
          ),
        );
      }

      credito = {
        monto: montoCredito,
        dias: linea.dias_credito || 15,
        id_cliente: receptor.id_cliente ?? null,
        id_empresa: receptor.id_empresa ?? null,
      };
    }

    const mapaNombre = new Map(
      metodos.map((m) => [Number(m.id_metodo), String(m.nombre || '').toLowerCase()]),
    );

    for (const p of pagos) {
      const tipo = mapaTipo.get(Number(p.id_metodo)) ?? '';
      const nombre = mapaNombre.get(Number(p.id_metodo)) ?? '';
      const esYape = tipo === 'billetera' && nombre.includes('yape');
      const esPlin = tipo === 'billetera' && nombre.includes('plin');
      const esTransfer = tipo === 'transferencia' || nombre.includes('transfer');
      const esTarjeta = esMetodoTarjeta({ tipo, nombre });

      if (esTransfer) {
        if (!p.id_cuenta_bancaria) {
          throw new BadRequestException('Transferencia: elige la cuenta bancaria destino');
        }
        if (!String(p.referencia ?? '').trim()) {
          throw new BadRequestException('Transferencia: indica el N° de operación');
        }
        p.validacion = p.validacion || 'manual';
      }

      if (esYape) {
        const ext = String(p.referencia_externa ?? '').trim();
        const ref = String(p.referencia ?? '').trim();
        const hayCulqi = !!pasarelaConfig.culqi.secretKey;

        if (p.validacion === 'culqi' && ext) {
          if (!hayCulqi) {
            // Keys no pegadas: no exigir Culqi; caer a manual si hay referencia.
            if (!ref && !ext) {
              throw new BadRequestException(
                cuerpoError(
                  CodigoError.CULQI_NO_CONFIG,
                  'Culqi no está configurado. Indica el N° de operación de Yape manualmente.',
                ),
              );
            }
            p.referencia = ref || ext;
            p.validacion = 'manual';
          } else {
            // Keys presentes: reconsultar orden (plug-and-play al pegar).
            try {
              const estado = await this.cajaPagosRepo.consultarOrdenCulqi(ext);
              const montoOrden = Number(estado.amount ?? 0);
              const montoPago = Number(p.monto);
              if (!estado.pagado) {
                throw new BadRequestException(
                  cuerpoError(
                    CodigoError.CULQI_NO_CONFIRMADO,
                    'El cobro Yape/Culqi aún no está pagado. Verifica de nuevo antes de cobrar.',
                  ),
                );
              }
              if (montoOrden > 0 && Math.abs(montoOrden - montoPago) > 0.05) {
                throw new BadRequestException(
                  cuerpoError(
                    CodigoError.CULQI_NO_CONFIRMADO,
                    `El monto Culqi (S/ ${montoOrden.toFixed(2)}) no coincide con el pago (S/ ${montoPago.toFixed(2)}).`,
                  ),
                );
              }
              p.referencia = p.referencia || ext;
              p.validacion = 'culqi';
            } catch (error: any) {
              if (error instanceof BadRequestException) throw error;
              if (String(error?.message) === 'CULQI_NO_CONFIG') {
                p.referencia = ref || ext;
                p.validacion = 'manual';
              } else {
                throw new BadRequestException(
                  cuerpoError(
                    CodigoError.CULQI_NO_CONFIRMADO,
                    error?.message || 'No se pudo confirmar el pago Culqi',
                  ),
                );
              }
            }
          }
        } else if (!ref) {
          throw new BadRequestException(
            'Yape: verifica el cobro con Culqi o indica el N° de operación manual',
          );
        } else {
          p.validacion = p.validacion || 'manual';
        }
      }

      if (esPlin && !String(p.referencia ?? '').trim()) {
        throw new BadRequestException('Plin: indica el N° de operación');
      }

      if (esTarjeta) {
        const voucher = String(p.voucher_pos ?? p.referencia ?? '').trim();
        if (!voucher) {
          throw new BadRequestException(
            'Tarjeta: registra el N° de voucher del POS físico',
          );
        }
        p.voucher_pos = p.voucher_pos || voucher;
        p.referencia = p.referencia || voucher;
        p.validacion = 'pos_fisico';
      }
    }

    return {
      pagos: pagos.map((p) => ({
        id_metodo: p.id_metodo,
        monto: Number(p.monto),
        referencia: p.referencia,
        monto_recibido: p.monto_recibido,
        vuelto: p.vuelto,
        id_cuenta_bancaria: p.id_cuenta_bancaria,
        voucher_pos: p.voucher_pos,
        validacion: p.validacion,
        referencia_externa: p.referencia_externa,
      })),
      credito,
    };
  }

  private async nombreMedioPago(pagos: { id_metodo?: number }[]) {
    const metodos = await this.creditoRepo.metodosConTipo();
    const nombres = pagos
      .map((p) => metodos.find((m) => Number(m.id_metodo) === Number(p.id_metodo))?.nombre)
      .filter(Boolean);
    return nombres.join(' + ') || '';
  }

  private fechaLimaMasDias(dias: number): string {
    const partes = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Lima',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date());
    const anio = Number(partes.find((p) => p.type === 'year')?.value);
    const mes = Number(partes.find((p) => p.type === 'month')?.value);
    const dia = Number(partes.find((p) => p.type === 'day')?.value);
    const fecha = new Date(Date.UTC(anio, mes - 1, dia + Math.max(1, Math.trunc(dias))));
    return `${String(fecha.getUTCDate()).padStart(2, '0')}-${String(fecha.getUTCMonth() + 1).padStart(2, '0')}-${fecha.getUTCFullYear()}`;
  }

  private validarPagos(dto: CrearVentaRequest, total: number) {
    const pagos = (dto.pagos ?? []).filter((p) => Number(p.monto) > 0);
    if (!pagos.length) return [{ monto: total }];
    const suma = redondear(pagos.reduce((acumulado, p) => acumulado + Number(p.monto), 0));
    if (Math.abs(suma - total) > 0.05) {
      throw new BadRequestException(
        `Los pagos suman S/ ${suma.toFixed(2)} y el total es S/ ${total.toFixed(2)}`,
      );
    }
    return pagos.map((p) => ({
      id_metodo: p.id_metodo,
      monto: Number(p.monto),
      referencia: p.referencia,
      monto_recibido: p.monto_recibido,
      vuelto: p.vuelto,
    }));
  }

  /**
   * Modo estricto (opt-in vía configuraciones.caja_modo).
   * Default blando: no hace nada. Tienda web no usa este camino.
   */
  private async assertCajaModoSiEstricto(usuario?: UsuarioToken): Promise<void> {
    const { modo, bypassAdmin } = await this.cajaSesion.configEstricto();
    if (modo !== 'estricto') return;

    const rol = normalizarRol(usuario?.rol);
    if (bypassAdmin && rol === 'admin') return;

    const idUsuario = Number(usuario?.id_usuario);
    const ok = await this.cajaSesion.usuarioTieneApertura(idUsuario);
    if (!ok) {
      throw new BadRequestException(
        cuerpoError(
          CodigoError.CAJA_NO_ABIERTA,
          'Debe abrir una caja antes de cobrar (modo estricto).',
        ),
      );
    }
  }

  private async almacenPorDefecto(): Promise<number | undefined> {
    const valor = await this.config.obtener('tienda_id_almacen');
    const numero = Number(valor);
    return Number.isFinite(numero) && numero > 0 ? numero : undefined;
  }

  private esViolacionUnica(error: any): boolean {
    const codigo = String(error?.code ?? error?.driverError?.code ?? '');
    return codigo === '23505';
  }

  private traducirErrorDeStock(error: any, items: { id_producto: number; descripcion: string }[]) {
    const mensaje = String(error?.message ?? '');

    if (mensaje === 'COTIZACION_NO_ENCONTRADA') {
      return new NotFoundException(cuerpoError(CodigoError.COTIZACION_NO_ENCONTRADA, 'La cotización ya no existe'));
    }
    if (mensaje.startsWith('COTIZACION_YA_CONVERTIDA:')) {
      const idVenta = mensaje.split(':')[1] || '';
      return new ConflictException(
        cuerpoError(CodigoError.COTIZACION_YA_CONVERTIDA, idVenta ? `La cotización ya tiene venta #${idVenta}` : 'La cotización ya fue convertida'),
      );
    }
    if (mensaje === 'COTIZACION_ANULADA') {
      return new BadRequestException(cuerpoError(CodigoError.COTIZACION_ESTADO_INVALIDO, 'La cotización está anulada'));
    }
    if (mensaje === 'COTIZACION_NO_APROBADA') {
      return new BadRequestException(cuerpoError(CodigoError.COTIZACION_ESTADO_INVALIDO, 'Apruebe la cotización antes de cobrarla'));
    }
    if (mensaje === 'COTIZACION_ITEMS_CAMBIARON') {
      return new BadRequestException(cuerpoError(CodigoError.COTIZACION_ESTADO_INVALIDO, 'Los productos o cantidades no coinciden con la cotización aprobada'));
    }
    if (mensaje === 'COTIZACION_REQUIERE_STOCK') {
      return new BadRequestException(cuerpoError(CodigoError.COTIZACION_ESTADO_INVALIDO, 'Una venta desde cotización debe descontar stock'));
    }
    if (mensaje === 'COTIZACION_CONVERSION_CONFLICTO') {
      return new ConflictException(cuerpoError(CodigoError.COTIZACION_ESTADO_INVALIDO, 'No se pudo confirmar la conversión de la cotización'));
    }

    if (mensaje.startsWith('STOCK_INSUFICIENTE:')) {
      const [, idProducto, faltante] = mensaje.split(':');
      const producto = items.find((i) => i.id_producto === Number(idProducto));
      return new BadRequestException(
        cuerpoError(
          CodigoError.STOCK_INSUFICIENTE,
          `No hay stock suficiente de "${producto?.descripcion ?? `producto ${idProducto}`}". Faltan ${faltante} unidades.`,
        ),
      );
    }

    if (mensaje === 'CREDITO_INACTIVO') {
      return new BadRequestException(
        cuerpoError(
          CodigoError.CREDITO_INACTIVO,
          'Este cliente/empresa no tiene crédito activo. Actívelo en Cuentas por cobrar (límite y días).',
        ),
      );
    }

    if (mensaje === 'CREDITO_SIN_CLIENTE') {
      return new BadRequestException(
        cuerpoError(
          CodigoError.CREDITO_SIN_CLIENTE,
          'El crédito solo aplica a clientes o empresas registradas. Busque DNI/RUC antes de cobrar.',
        ),
      );
    }

    if (mensaje.startsWith('CREDITO_INSUFICIENTE:')) {
      const [, disponible, limite, deuda] = mensaje.split(':');
      return new BadRequestException(
        cuerpoError(
          CodigoError.CREDITO_INSUFICIENTE,
          `Crédito insuficiente. Disponible S/ ${disponible} (límite ${limite}, deuda ${deuda}).`,
        ),
      );
    }

    if (mensaje.startsWith('CREDITO_ENTIDAD:')) {
      return new BadRequestException(
        cuerpoError(CodigoError.ENTIDAD_NO_ENCONTRADA, mensaje.replace('CREDITO_ENTIDAD:', '')),
      );
    }

    return new BadRequestException(mensaje || 'No se pudo registrar la venta');
  }
}

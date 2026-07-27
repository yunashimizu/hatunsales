import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { VentaRepository, FiltroVentas, LineaVentaPersistida } from '../../repository/Repository/venta.repository';
import { ConfiguracionRepository } from '../../repository/Repository/configuracion.repository';
import { ComprobanteBussnies } from './comprobante.bussnies';
import { ReceptorBussnies } from './receptor.bussnies';
import { CrearVentaRequest, ItemVentaRequest } from '../../models/model/venta/venta.request';
import { VentaResponse } from '../../models/model/venta/venta.response';
import { GenerarComprobanteRequest } from '../../models/model/c-electronico/comprobante.request';
import { PreviewComprobanteResponse } from '../../models/model/c-electronico/comprobante.response';
import {
  calcularComprobante,
  PORCENTAJE_IGV_POR_DEFECTO,
  redondear,
} from '../../util/fiscal/calculo-fiscal';

/**
 * Punto de venta de mostrador.
 *
 * La venta y el comprobante son dos pasos separados a propósito: la mercadería
 * ya salió del almacén, así que un rechazo de NUBEFACT no debe deshacer la
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
  ) {}

  // ── Apoyo al mostrador ───────────────────────────────────────

  buscarProductos(termino: string, limite?: number) {
    return this.repo.buscarProductos(termino, limite);
  }

  async buscarPorCodigoBarras(codigo: string) {
    const producto = await this.repo.buscarPorCodigoBarras(codigo);
    if (!producto) throw new NotFoundException(`No hay ningún producto con el código ${codigo}`);
    return producto;
  }

  metodosPago() {
    return this.repo.metodosPago();
  }

  /** Vista previa del comprobante desde el carrito del mostrador. */
  async previsualizar(dto: CrearVentaRequest): Promise<PreviewComprobanteResponse> {
    const { items } = await this.armarLineas(dto);
    return this.comprobantes.previsualizar(this.aSolicitudComprobante(dto, items));
  }

  // ── Registrar ────────────────────────────────────────────────

  async registrar(dto: CrearVentaRequest, idUsuario?: number): Promise<VentaResponse> {
    if (!Array.isArray(dto.items) || dto.items.length === 0) {
      throw new BadRequestException('Agregue al menos un producto a la venta');
    }

    // Un doble clic o un reintento por conexión lenta devuelve la venta anterior
    // en vez de duplicarla.
    if (dto.clave_idempotencia) {
      const existente = await this.repo.buscarPorClaveIdempotencia(dto.clave_idempotencia);
      if (existente) return this.obtener(existente);
    }

    const { items, resumen } = await this.armarLineas(dto);

    const receptor = await this.resolverReceptor(dto);
    const pagos = this.validarPagos(dto, resumen.total);

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
      };
    });

    const idAlmacen = dto.id_almacen ?? (await this.almacenPorDefecto());

    let idVenta: number;
    try {
      idVenta = await this.repo.registrar(
        {
          id_cliente: receptor.id_cliente,
          id_caja: dto.id_caja,
          id_usuario: idUsuario,
          subtotal: resumen.total_gravada + resumen.total_exonerada + resumen.total_inafecta,
          igv: resumen.total_igv,
          descuento: resumen.total_descuento,
          total: resumen.total,
          origen: 'mostrador',
          clave_idempotencia: dto.clave_idempotencia,
          observaciones: dto.observaciones,
        },
        lineas,
        pagos,
        {
          descontarStock: dto.descontar_stock ?? true,
          idAlmacenPreferido: idAlmacen,
        },
      );
    } catch (error: any) {
      throw this.traducirErrorDeStock(error, items);
    }

    const venta = await this.obtener(idVenta);

    if (dto.emitir_comprobante === false) return venta;

    // Desde aquí la venta ya existe. Si el comprobante falla se informa, pero
    // no se revierte nada.
    try {
      venta.comprobante = await this.comprobantes.generar({
        ...this.aSolicitudComprobante(dto, items),
        id_venta: idVenta,
        id_cliente: receptor.id_cliente,
        id_empresa: receptor.id_empresa,
        documento: receptor.numero_documento,
      });
    } catch (error: any) {
      const mensaje = error?.response?.message ?? error?.message ?? 'No se pudo emitir el comprobante';
      this.logger.warn(`Venta ${idVenta} registrada sin comprobante: ${mensaje}`);
      venta.comprobante_error = String(mensaje);
    }

    return venta;
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

  /** Anula la venta devolviendo el stock. El comprobante se anula por separado. */
  async anular(idVenta: number): Promise<{ anulada: boolean }> {
    const venta = await this.repo.obtener(idVenta);
    if (!venta) throw new NotFoundException(`No existe la venta ${idVenta}`);

    await this.repo.devolverStock(idVenta);
    return { anulada: true };
  }

  // ── Interno ──────────────────────────────────────────────────

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
      const precio = item.precio_unitario ?? producto.precio_final;

      if (precio <= 0) {
        throw new BadRequestException(`El producto "${producto.nombre}" no tiene precio de venta configurado`);
      }

      return {
        id_producto: producto.id_producto,
        descripcion: producto.nombre,
        codigo: producto.sku || producto.codigo_barras || String(producto.id_producto),
        unidad_de_medida: producto.unidad_medida || 'NIU',
        cantidad: Number(item.cantidad),
        precio_unitario: precio,
        descuento: item.descuento ?? 0,
        tipo_de_igv: item.tipo_de_igv,
        stock_disponible: producto.stock_disponible,
      };
    });

    const porcentajeIgv = await this.config.obtenerNumero(
      'tienda_igv_porcentaje',
      PORCENTAJE_IGV_POR_DEFECTO,
    );

    const resumen = calcularComprobante(
      items.map((i) => ({
        cantidad: i.cantidad,
        precio_unitario: i.precio_unitario,
        descuento: i.descuento,
        tipo_de_igv: i.tipo_de_igv,
      })),
      porcentajeIgv,
    );

    return { items, resumen };
  }

  private aSolicitudComprobante(
    dto: CrearVentaRequest,
    items: { id_producto: number; descripcion: string; codigo: string; unidad_de_medida: string; cantidad: number; precio_unitario: number; descuento: number; tipo_de_igv?: number }[],
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
      items: items.map((i) => ({
        id_producto: i.id_producto,
        codigo: i.codigo,
        unidad_de_medida: i.unidad_de_medida,
        descripcion: i.descripcion,
        cantidad: i.cantidad,
        precio_unitario: i.precio_unitario,
        descuento: i.descuento,
        tipo_de_igv: i.tipo_de_igv,
      })),
    } as GenerarComprobanteRequest;
  }

  private async resolverReceptor(dto: CrearVentaRequest) {
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

  private validarPagos(dto: CrearVentaRequest, total: number) {
    const pagos = (dto.pagos ?? []).filter((p) => Number(p.monto) > 0);

    // Sin desglose se asume un único pago por el total, que es el caso común.
    if (!pagos.length) return [{ monto: total }];

    const suma = redondear(pagos.reduce((acumulado, p) => acumulado + Number(p.monto), 0));
    if (Math.abs(suma - total) > 0.05) {
      throw new BadRequestException(
        `Los pagos suman S/ ${suma.toFixed(2)} y el total es S/ ${total.toFixed(2)}`,
      );
    }

    return pagos.map((p) => ({ id_metodo: p.id_metodo, monto: Number(p.monto), referencia: p.referencia }));
  }

  private async almacenPorDefecto(): Promise<number | undefined> {
    const valor = await this.config.obtener('tienda_id_almacen');
    const numero = Number(valor);
    return Number.isFinite(numero) && numero > 0 ? numero : undefined;
  }

  private traducirErrorDeStock(error: any, items: { id_producto: number; descripcion: string }[]) {
    const mensaje = String(error?.message ?? '');

    if (mensaje.startsWith('STOCK_INSUFICIENTE:')) {
      const [, idProducto, faltante] = mensaje.split(':');
      const producto = items.find((i) => i.id_producto === Number(idProducto));
      return new BadRequestException(
        `No hay stock suficiente de "${producto?.descripcion ?? `producto ${idProducto}`}". Faltan ${faltante} unidades.`,
      );
    }

    return new BadRequestException(mensaje || 'No se pudo registrar la venta');
  }
}

import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { VentaRepository, FiltroVentas, LineaVentaPersistida } from '../../repository/Repository/venta.repository';
import { ConfiguracionRepository } from '../../repository/Repository/configuracion.repository';
import { CreditoRepository } from '../../repository/Repository/credito.repository';
import { CajaPagosRepository } from '../../repository/Repository/caja-pagos.repository';
import { ComprobanteBussnies } from './comprobante.bussnies';
import { ReceptorBussnies } from './receptor.bussnies';
import { CreditoBussnies } from './credito.bussnies';
import { CrearVentaRequest, ItemVentaRequest } from '../../models/model/venta/venta.request';
import { VentaResponse } from '../../models/model/venta/venta.response';
import { GenerarComprobanteRequest } from '../../models/model/c-electronico/comprobante.request';
import { PreviewComprobanteResponse } from '../../models/model/c-electronico/comprobante.response';
import type { UsuarioToken } from '../../guards/usuario-actual.decorator';
import {
  calcularComprobante,
  PORCENTAJE_IGV_POR_DEFECTO,
  redondear,
} from '../../util/fiscal/calculo-fiscal';
import { CodigoError, cuerpoError } from '../../util/errores-operativos';
import { pasarelaConfig } from '../../config/pasarela.config';
import { CajaSesionBussnies } from './caja-sesion.bussnies';
import { normalizarRol } from '../../config/roles.config';

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
    private readonly creditoRepo: CreditoRepository,
    private readonly credito: CreditoBussnies,
    private readonly cajaPagosRepo: CajaPagosRepository,
    private readonly cajaSesion: CajaSesionBussnies,
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
    const producto = await this.repo.buscarPorCodigoBarras(codigo, idAlmacen);
    if (!producto) throw new NotFoundException(`No hay ningún producto con el código ${codigo}`);
    return producto;
  }

  /**
   * Almacenes disponibles para el POS + default de configuración.
   * El cajero elige almacén cuando debe despachar desde otra sede.
   */
  async contextoPos(): Promise<{
    almacenes: { id_almacen: number; nombre: string; sucursal: string; id_sucursal: number | null }[];
    almacen_default?: number;
  }> {
    const filas = await this.repo.listarAlmacenesPos();
    const def = await this.almacenPorDefecto();
    return {
      almacenes: filas,
      ...(def ? { almacen_default: def } : {}),
    };
  }

  async metodosPago() {
    await this.creditoRepo.asegurarSchema();
    return this.creditoRepo.metodosConTipo();
  }

  /** Vista previa del comprobante desde el carrito del mostrador. */
  async previsualizar(dto: CrearVentaRequest): Promise<PreviewComprobanteResponse> {
    const { items } = await this.armarLineas(dto);
    return this.comprobantes.previsualizar(this.aSolicitudComprobante(dto, items));
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

    if (dto.clave_idempotencia) {
      const existente = await this.repo.buscarPorClaveIdempotencia(dto.clave_idempotencia);
      if (existente) return this.obtener(existente);
    }

    const { items, resumen } = await this.armarLineas(dto);
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
      };
    });

    const idAlmacen = dto.id_almacen ?? (await this.almacenPorDefecto());

    let idVenta: number;
    try {
      idVenta = await this.repo.registrar(
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
          clave_idempotencia: dto.clave_idempotencia,
          observaciones: dto.observaciones,
          credito,
        },
        lineas,
        pagos,
        {
          descontarStock: dto.descontar_stock ?? true,
          idAlmacenPreferido: idAlmacen,
        },
      );
    } catch (error: any) {
      // Carrera de idempotencia: el índice único ganó en otra petición.
      if (dto.clave_idempotencia && this.esViolacionUnica(error)) {
        const existente = await this.repo.buscarPorClaveIdempotencia(dto.clave_idempotencia);
        if (existente) return this.obtener(existente);
      }
      throw this.traducirErrorDeStock(error, items);
    }

    const venta = await this.obtener(idVenta);

    if (dto.emitir_comprobante === false) return venta;

    try {
      const medio = await this.nombreMedioPago(pagos);
      venta.comprobante = await this.comprobantes.generar({
        ...this.aSolicitudComprobante(dto, items),
        id_venta: idVenta,
        id_cliente: receptor.id_cliente,
        id_empresa: receptor.id_empresa,
        documento: receptor.numero_documento,
        medio_de_pago: medio,
        condiciones_de_pago: credito ? 'Crédito' : 'Contado',
      } as any);
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

  /** Anula la venta: stock al almacén de salida, cierra CxC. El CPE se anula aparte en Documentos. */
  async anular(idVenta: number): Promise<{
    anulada: boolean;
    ya_anulada?: boolean;
    cxc_cerradas: number;
    stock_devuelto: boolean;
    comprobante_aviso?: string;
  }> {
    const venta = await this.repo.obtener(idVenta);
    if (!venta) throw new NotFoundException(`No existe la venta ${idVenta}`);

    let resultado: { stock_devuelto: boolean; cxc_cerradas: number; ya_anulada: boolean };
    try {
      resultado = await this.repo.anularVentaCompleta(idVenta);
    } catch (error: any) {
      if (String(error?.message) === 'VENTA_NO_ENCONTRADA') {
        throw new NotFoundException(`No existe la venta ${idVenta}`);
      }
      throw error;
    }

    if (resultado.ya_anulada) {
      return {
        anulada: true,
        ya_anulada: true,
        cxc_cerradas: 0,
        stock_devuelto: false,
      };
    }

    const comprobantes = await this.comprobantes.listarPorVenta(idVenta);
    const emitidos = (comprobantes ?? []).filter(
      (c: any) => !c.anulado && (c.estado === 'aceptado' || c.estado === 'enviado' || c.pdf_url || c.numero),
    );

    let comprobante_aviso: string | undefined;
    if (emitidos.length > 0) {
      comprobante_aviso =
        'La venta se anuló en el sistema (stock y crédito). Si el comprobante ya fue aceptado por SUNAT, emita una nota de crédito o anúlelo desde Documentos.';
    } else if ((comprobantes ?? []).length > 0) {
      comprobante_aviso =
        'La venta se anuló. Había un comprobante pendiente/error: revíselo en Documentos si hace falta.';
    }

    return {
      anulada: true,
      cxc_cerradas: resultado.cxc_cerradas,
      stock_devuelto: resultado.stock_devuelto,
      ...(comprobante_aviso ? { comprobante_aviso } : {}),
    };
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

  private async validarPagosYCredito(
    dto: CrearVentaRequest,
    total: number,
    receptor: { id_cliente?: number; id_empresa?: number; numero_documento?: string },
    usuario?: UsuarioToken,
  ) {
    await this.creditoRepo.asegurarSchema();
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
      const esTarjeta = tipo === 'tarjeta' || nombre.includes('tarjeta');

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

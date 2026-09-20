import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  CuentaBancariaProforma,
  NuevoItemProforma,
  ProformaRepository,
  codigoProforma,
} from '../../repository/Repository/proforma.repository';
import {
  CrearProformaRequest,
  MarcarProformaRequest,
} from '../../models/model/proforma.request';
import { ProformaResponse } from '../../models/model/proforma.response';
import { IProformaBussniees } from '../Ibussnies/IProformaBussniees';
import { ProductoRepository } from '../../repository/Repository/producto.repository';
import { CodigoError, cuerpoError } from '../../util/errores-operativos';
import { WhatsappPasarela } from '../../util/pasarela/whatsapp.pasarela';
import { ConfiguracionRepository } from '../../repository/Repository/configuracion.repository';
import {
  calcularComprobante,
  desagregarIgv,
  PORCENTAJE_IGV_POR_DEFECTO,
  redondear,
} from '../../util/fiscal/calculo-fiscal';
import { CLAVES_EMISOR, emisorConfig } from '../../config/emisor.config';
import {
  ClienteDocumento,
  CuentaBancariaDocumento,
  DatosProformaDocumento,
  EmisorDocumento,
  hoyEnLima,
  nombreArchivoProforma,
  sumarDias,
  textoPlano,
} from '../../util/documentos/proforma-documento';
import { generarProformaPdf } from '../../util/documentos/proforma-pdf';
import { generarProformaExcel } from '../../util/documentos/proforma-excel';
import { obtenerLogoEmisor } from '../../util/documentos/logo-emisor';

/** Archivo listo para enviarlo al navegador. */
export interface DocumentoProforma {
  buffer: Buffer;
  nombreArchivo: string;
  codigo: string;
}

/** Días de vigencia por defecto de una proforma nueva. */
const DIAS_VIGENCIA_POR_DEFECTO = 7;
/** Diferencia máxima (en soles) que se tolera entre total y gravada + IGV. */
const TOLERANCIA_TOTALES = 0.05;
/** Ítems que se listan en el mensaje de WhatsApp antes de resumir. */
const ITEMS_EN_TEXTO_WA = 8;

const CUENTAS_DOCUMENTO_POR_DEFECTO: CuentaBancariaProforma[] = [
  {
    banco: 'BCP',
    tipo_cuenta: 'corriente',
    numero_cuenta: '19479681930096',
    cci: '002194171968193009695',
    titular: null,
    moneda: 'PEN',
    es_yape: false,
  },
  {
    banco: 'BBVA',
    tipo_cuenta: 'corriente',
    numero_cuenta: '0011-0933-0200689626',
    cci: '011-933-000200689626-96',
    titular: null,
    moneda: 'PEN',
    es_yape: false,
  },
];

@Injectable()
export class ProformaBussnies implements IProformaBussniees {

  private readonly log = new Logger(ProformaBussnies.name);

  constructor(
    private readonly repo: ProformaRepository,
    private readonly productoRepo: ProductoRepository,
    private readonly whatsapp: WhatsappPasarela,
    private readonly config: ConfiguracionRepository,
  ) {}

  async getAll(): Promise<ProformaResponse[]> {
    const lista = await this.conError(
      () => this.repo.getAll(),
      'No se pudo leer el listado de cotizaciones',
    );
    const almacenes = await this.repo.nombresAlmacenes(lista.map((p) => p.id_almacen));
    return lista.map((p) => this.mapProforma(p, almacenes));
  }

  async getById(id: number): Promise<ProformaResponse> {
    const p = await this.obtenerEntidad(id);
    const almacenes = await this.repo.nombresAlmacenes([p.id_almacen]);
    return this.mapProforma(p, almacenes);
  }

  async create(dto: CrearProformaRequest): Promise<ProformaResponse> {
    if (!dto.items?.length) {
      throw new BadRequestException(
        cuerpoError(CodigoError.COTIZACION_SIN_ITEMS, 'Agregue al menos un producto a la cotización'),
      );
    }

    const idCliente = dto.id_cliente ? Number(dto.id_cliente) : null;
    const idEmpresa = dto.id_empresa ? Number(dto.id_empresa) : null;
    const nombre = (dto.cliente_nombre ?? '').trim();

    if (!idCliente && !idEmpresa && !nombre) {
      throw new BadRequestException(
        cuerpoError(
          CodigoError.COTIZACION_SIN_CLIENTE,
          'Indique cliente, empresa o un nombre para la cotización',
        ),
      );
    }

    const itemsBase: Array<Omit<NuevoItemProforma, 'subtotal'>> = [];

    for (const item of dto.items) {
      const producto = await this.conError(
        () => this.productoRepo.getById(Number(item.id_producto)),
        'No se pudo leer el catálogo de productos',
      );
      if (!producto) {
        throw new NotFoundException(
          cuerpoError(
            CodigoError.COTIZACION_PRODUCTO_NO_ENCONTRADO,
            `El producto ${item.id_producto} ya no existe en el catálogo`,
          ),
        );
      }

      const nombreProducto = String((producto as any).nombre || `#${item.id_producto}`);
      // La columna cantidad es INTEGER: solo enteros de 1 a más.
      const cantidad = Number(item.cantidad);
      if (!Number.isInteger(cantidad) || cantidad < 1) {
        throw new BadRequestException(
          cuerpoError(
            CodigoError.COTIZACION_CANTIDAD_INVALIDA,
            `La cantidad de "${nombreProducto}" debe ser un número entero de 1 o más`,
          ),
        );
      }

      const precioVenta = Number((producto as any).precio_venta ?? 0);
      const descuento = Number((producto as any).descuento ?? 0);
      const precio = redondear(Math.max(0, precioVenta - descuento));
      if (!(precio > 0)) {
        throw new BadRequestException(
          cuerpoError(
            CodigoError.COTIZACION_PRODUCTO_SIN_PRECIO,
            `El producto "${nombreProducto}" no tiene un precio de venta válido`,
          ),
        );
      }

      itemsBase.push({
        id_producto: Number(item.id_producto),
        cantidad,
        precio_unitario: precio,
        descripcion_snapshot:
          (item.descripcion || (producto as any).nombre || '').toString().slice(0, 250) || null,
        sku_snapshot: (item.sku || (producto as any).sku || '').toString().slice(0, 80) || null,
        unidad_medida_snapshot:
          String((producto as any).unidad_medida || 'NIU').trim().slice(0, 20) || 'NIU',
        descuento_snapshot: Number.isFinite(descuento) ? redondear(Math.max(0, descuento)) : 0,
      });
    }

    const porcentajeIgv = await this.porcentajeIgv();
    const resumen = calcularComprobante(
      itemsBase.map((item) => ({
        cantidad: item.cantidad,
        precio_unitario: item.precio_unitario,
      })),
      porcentajeIgv,
    );
    const items: NuevoItemProforma[] = itemsBase.map((item, indice) => ({
      ...item,
      subtotal: resumen.lineas[indice].total,
    }));

    const dias = Number(dto.dias_vigencia) > 0 ? Number(dto.dias_vigencia) : DIAS_VIGENCIA_POR_DEFECTO;
    const validaHasta = sumarDias(hoyEnLima(), dias);

    const proforma = await this.conError(
      () =>
        this.repo.crearConItems({
          id_empresa: idEmpresa,
          id_cliente: idCliente,
          estado: 'borrador',
          observaciones: (dto.observaciones ?? '').trim() || null,
          valida_hasta: validaHasta,
          id_almacen: dto.id_almacen ? Number(dto.id_almacen) : null,
          cliente_nombre_snapshot: nombre || null,
          telefono_envio: (dto.telefono_envio ?? '').replace(/\D/g, '') || null,
          total_gravada: resumen.total_gravada,
          total_igv: resumen.total_igv,
          total: resumen.total,
          porcentaje_igv: resumen.porcentaje_igv,
          items,
        }),
      'No se pudo guardar la cotización',
    );

    const almacenes = await this.repo.nombresAlmacenes([proforma.id_almacen]);
    return this.mapProforma(proforma, almacenes);
  }

  async marcar(id: number, dto: MarcarProformaRequest): Promise<ProformaResponse> {
    const actual = await this.obtenerEntidad(id);

    if (actual.estado === 'anulada' && dto.estado && dto.estado !== 'anulada') {
      throw new ConflictException(
        cuerpoError(CodigoError.COTIZACION_ESTADO_INVALIDO, 'La cotización ya está anulada'),
      );
    }

    if (actual.estado === 'convertida' && dto.estado && dto.estado !== 'convertida') {
      throw new ConflictException(
        cuerpoError(CodigoError.COTIZACION_YA_CONVERTIDA, `Ya tiene venta #${actual.id_venta}`),
      );
    }

    if (dto.estado === 'convertida' && (!dto.id_venta || Number(dto.id_venta) <= 0)) {
      throw new BadRequestException(
        cuerpoError(
          CodigoError.COTIZACION_ESTADO_INVALIDO,
          'Una cotización convertida debe indicar la venta asociada',
        ),
      );
    }

    if (dto.estado === 'convertida' && actual.estado === 'convertida' && actual.id_venta) {
      throw new ConflictException(
        cuerpoError(
          CodigoError.COTIZACION_YA_CONVERTIDA,
          `Ya tiene venta #${actual.id_venta}`,
        ),
      );
    }

    const cambios: any = {};
    if (dto.estado) cambios.estado = dto.estado;
    if (dto.id_venta != null) cambios.id_venta = Number(dto.id_venta);

    // Sin nada que cambiar, TypeORM lanza UpdateValuesMissingError y saldría
    // un 500. Es un error de quien llama: se avisa con su código.
    if (!Object.keys(cambios).length) {
      throw new BadRequestException(
        cuerpoError(
          CodigoError.COTIZACION_ESTADO_INVALIDO,
          'Indique el estado (o la venta) que quiere asignar a la cotización',
        ),
      );
    }

    const actualizado = await this.conError(
      () => this.repo.actualizar(id, cambios),
      'No se pudo actualizar la cotización',
    );
    if (!actualizado) {
      throw new NotFoundException(
        cuerpoError(CodigoError.COTIZACION_NO_ENCONTRADA, `Cotización ${id} no encontrada`),
      );
    }
    const almacenes = await this.repo.nombresAlmacenes([actualizado.id_almacen]);
    return this.mapProforma(actualizado, almacenes);
  }

  async registrarEnvioWa(id: number, telefono: string): Promise<ProformaResponse> {
    const actual = await this.obtenerEntidad(id);
    await this.conError(
      () =>
        this.repo.actualizar(id, {
          telefono_envio: telefono.replace(/\D/g, ''),
          enviada_wa_en: new Date(),
          estado: actual.estado === 'borrador' ? 'enviada' : actual.estado,
        } as any),
      'No se pudo registrar el envío por WhatsApp',
    );
    return this.getById(id);
  }

  // ── Documentos (PDF / Excel) ─────────────────────────────────────

  /** PDF de la proforma, listo para descargar. */
  async generarPdf(id: number): Promise<DocumentoProforma> {
    const datos = await this.datosDocumento(id);
    const buffer = await this.generar(
      () => generarProformaPdf(datos),
      datos.codigo,
      'PDF',
    );
    return { buffer, nombreArchivo: nombreArchivoProforma(datos.codigo, 'pdf'), codigo: datos.codigo };
  }

  /** Excel (.xlsx) de la proforma, listo para descargar. */
  async generarExcel(id: number): Promise<DocumentoProforma> {
    const datos = await this.datosDocumento(id);
    const buffer = await this.generar(
      () => generarProformaExcel(datos),
      datos.codigo,
      'Excel',
    );
    return { buffer, nombreArchivo: nombreArchivoProforma(datos.codigo, 'xlsx'), codigo: datos.codigo };
  }

  /** Ejecuta el generador y traduce cualquier fallo a COTIZACION_DOCUMENTO_ERROR. */
  private async generar(
    generador: () => Promise<Buffer>,
    codigo: string,
    tipo: string,
  ): Promise<Buffer> {
    try {
      const buffer = await generador();
      if (!buffer?.length) throw new Error('El generador devolvió un archivo vacío');
      return buffer;
    } catch (error: any) {
      this.log.error(
        `No se pudo generar el ${tipo} de la proforma ${codigo}: ${error?.message ?? error}`,
        error?.stack,
      );
      throw new InternalServerErrorException(
        cuerpoError(
          CodigoError.COTIZACION_DOCUMENTO_ERROR,
          `No se pudo generar el ${tipo} de la proforma ${codigo}. Reintente en unos segundos.`,
        ),
      );
    }
  }

  /**
   * Resuelve todo lo que necesitan los generadores: emisor, cliente, almacén y
   * cuentas bancarias. Los datos de apoyo (logo, almacén, cuentas) nunca
   * impiden emitir el documento: si faltan, simplemente no se imprimen.
   */
  private async datosDocumento(id: number): Promise<DatosProformaDocumento> {
    const p = await this.obtenerEntidad(id);

    const [emisor, cuentas, almacenes] = await Promise.all([
      this.resolverEmisor(),
      this.repo.cuentasParaDocumento(),
      this.repo.nombresAlmacenes([p.id_almacen]),
    ]);

    const totales = this.totalesCoherentes(p);

    return {
      emisor,
      codigo: this.codigoDe(p),
      estado: p.estado || 'borrador',
      fecha_emision: p.creado_en ?? null,
      valida_hasta: p.valida_hasta ?? null,
      cliente: this.clienteDocumento(p),
      almacen: p.id_almacen ? almacenes.get(Number(p.id_almacen)) ?? null : null,
      items: (p.items ?? []).map((item: any) => {
        const cantidad = Number(item.cantidad ?? 0);
        const precio = Number(item.precio_unitario ?? 0);
        const importe = Number(item.subtotal ?? 0);
        const producto = (item as any).producto;
        return {
          sku: item.sku_snapshot || item.producto?.sku || null,
          unidad_medida:
            item.unidad_medida_snapshot || producto?.unidad_medida || 'NIU',
          descripcion: item.descripcion_snapshot || item.producto?.nombre || 'Producto',
          cantidad,
          precio_unitario: precio,
          importe: Number.isFinite(importe) && importe > 0 ? importe : redondear(cantidad * precio),
          descuento: Number(item.descuento_snapshot ?? producto?.descuento ?? 0),
        };
      }),
      total_gravada: totales.total_gravada,
      total_igv: totales.total_igv,
      total: totales.total,
      porcentaje_igv: totales.porcentaje_igv,
      observaciones: p.observaciones ?? null,
      cuentas: (cuentas.length ? cuentas : CUENTAS_DOCUMENTO_POR_DEFECTO).map((c) =>
        this.cuentaDocumento(c),
      ),
      generado_en: new Date(),
    };
  }

  /** Datos del emisor: `configuraciones` manda; si falta una clave, el config local. */
  private async resolverEmisor(): Promise<EmisorDocumento> {
    let valores: Record<string, string | null> = {};
    try {
      valores = await this.config.obtenerVarias([...CLAVES_EMISOR]);
    } catch (error: any) {
      this.log.warn(
        `No se pudo leer la configuración del emisor (${error?.message ?? error}); ` +
          'se usan los datos por defecto.',
      );
    }

    const dato = (clave: string, porDefecto: string) =>
      textoPlano(valores[clave] ?? '') || porDefecto;

    const logoUrl = dato('emisor_logo_url', emisorConfig.logo_url);
    // obtenerLogoEmisor nunca lanza: si falla devuelve null y el PDF sale sin logo.
    const logoLeido = await obtenerLogoEmisor(logoUrl);
    const logo =
      logoLeido || (logoUrl !== emisorConfig.logo_url
        ? await obtenerLogoEmisor(emisorConfig.logo_url)
        : null);

    return {
      ruc: dato('emisor_ruc', emisorConfig.ruc),
      razon_social: dato('emisor_razon_social', emisorConfig.razon_social),
      direccion: dato('emisor_direccion', emisorConfig.direccion),
      ubicacion: dato('emisor_ubicacion', emisorConfig.ubicacion),
      logo,
    };
  }

  private clienteDocumento(p: any): ClienteDocumento {
    return {
      nombre: this.nombreCliente(p),
      documento: this.documentoCliente(p),
      direccion: textoPlano(p.cliente?.direccion) || textoPlano(p.empresa?.direccion) || null,
      telefono:
        textoPlano(p.telefono_envio) ||
        textoPlano(p.cliente?.telefono) ||
        textoPlano(p.empresa?.telefonos) ||
        null,
      email: textoPlano(p.cliente?.email) || null,
    };
  }

  private cuentaDocumento(c: CuentaBancariaProforma): CuentaBancariaDocumento {
    return {
      banco: c.banco,
      tipo: c.tipo_cuenta,
      numero: c.numero_cuenta,
      cci: c.cci,
      titular: c.titular,
      moneda: c.moneda,
      es_yape: c.es_yape,
    };
  }

  // ── WhatsApp ────────────────────────────────────────────────────

  armarTextoWa(p: ProformaResponse, razonSocial?: string): string {
    const emisor = textoPlano(razonSocial) || emisorConfig.razon_social;
    const items = p.items ?? [];
    const lineas = items
      .slice(0, ITEMS_EN_TEXTO_WA)
      .map(
        (i) =>
          `• ${i.descripcion || 'Producto'} x${i.cantidad} — S/ ${Number(
            i.subtotal ?? Number(i.precio_unitario) * Number(i.cantidad),
          ).toFixed(2)}`,
      )
      .join('\n');
    const restantes = items.length - ITEMS_EN_TEXTO_WA;
    const extra = restantes > 0 ? `\n… y ${restantes} ítem(s) más` : '';
    return [
      `Hola${p.cliente_nombre ? ` ${p.cliente_nombre}` : ''},`,
      `Cotización *${p.codigo || '#' + p.id_proforma}* — ${emisor}`,
      p.valida_hasta ? `Válida hasta: ${p.valida_hasta}` : null,
      ``,
      lineas + extra,
      ``,
      `*Total: S/ ${Number(p.total).toFixed(2)}* (inc. IGV)`,
      p.observaciones ? `Nota: ${p.observaciones}` : null,
      ``,
      `Adjunto la proforma de cotización.`,
      `¿Desea proceder? Responda a este mensaje.`,
    ]
      .filter((x) => x != null)
      .join('\n');
  }

  whatsappEstado() {
    return this.whatsapp.estado();
  }

  async enviarPorWhatsapp(opts: {
    id_proforma?: number;
    telefono: string;
    texto?: string;
    solo_wa_me?: boolean;
  }) {
    const destino = this.whatsapp.normalizarDestino(opts.telefono);
    if (!destino) {
      throw new BadRequestException(
        cuerpoError(
          CodigoError.COTIZACION_TELEFONO_INVALIDO,
          'Teléfono inválido. Use celular de 9 dígitos (Perú).',
        ),
      );
    }

    let texto = (opts.texto ?? '').trim();
    if (opts.id_proforma) {
      const cot = await this.getById(opts.id_proforma);
      if (!texto) {
        const razonSocial = await this.razonSocialEmisor();
        texto = this.armarTextoWa(cot, razonSocial);
      }

      // Vía ferretería: wa.me + adjunto proforma (sin Meta). Meta queda opcional para después.
      if (opts.solo_wa_me !== false) {
        const waMe = this.whatsapp.urlWaMe(destino, texto);
        const aviso = await this.registrarEnvioSinFallar(opts.id_proforma, destino);
        return {
          modo: 'wa_me' as const,
          ok: true,
          wa_me_url: waMe,
          texto,
          mensaje: aviso
            ? `Abra WhatsApp, adjunte la proforma descargada y envíe. ${aviso}`
            : 'Abra WhatsApp, adjunte la proforma descargada y envíe.',
        };
      }

      const plantillaParams = [
        cot.cliente_nombre || 'cliente',
        cot.codigo || `COT-${cot.id_proforma}`,
        `S/ ${Number(cot.total || 0).toFixed(2)}`,
      ];
      const resultado = await this.whatsapp.enviarTexto({
        telefono: destino,
        texto,
        plantillaParams,
      });
      if (resultado.ok) {
        await this.registrarEnvioSinFallar(opts.id_proforma, destino);
      }
      return { ...resultado, texto };
    }

    if (!texto) {
      throw new BadRequestException(
        cuerpoError(
          CodigoError.COTIZACION_SIN_ITEMS,
          'Indique el texto del mensaje o una cotización',
        ),
      );
    }
    if (opts.solo_wa_me !== false) {
      return {
        modo: 'wa_me' as const,
        ok: true,
        wa_me_url: this.whatsapp.urlWaMe(destino, texto),
        texto,
        mensaje: 'Abra WhatsApp con el enlace.',
      };
    }
    return this.whatsapp.enviarTexto({ telefono: destino, texto });
  }

  /**
   * El mensaje ya está armado: que no se pueda anotar el envío no debe tumbar
   * la respuesta. Devuelve un aviso para el vendedor cuando algo falló.
   */
  private async registrarEnvioSinFallar(id: number, destino: string): Promise<string | null> {
    try {
      await this.registrarEnvioWa(id, destino);
      return null;
    } catch (error: any) {
      this.log.error(
        `No se pudo registrar el envío por WhatsApp de la cotización ${id}: ${error?.message ?? error}`,
        error?.stack,
      );
      return 'No se pudo marcar la cotización como enviada; hágalo a mano desde la lista.';
    }
  }

  private async razonSocialEmisor(): Promise<string> {
    try {
      return await this.config.obtenerTexto('emisor_razon_social', emisorConfig.razon_social);
    } catch (error: any) {
      this.log.warn(`No se pudo leer la razón social del emisor: ${error?.message ?? error}`);
      return emisorConfig.razon_social;
    }
  }

  // ── Apoyo ───────────────────────────────────────────────────────

  /** Lee la proforma o lanza 404. Los fallos de BD salen como error interno. */
  private async obtenerEntidad(id: number) {
    const p = await this.conError(
      () => this.repo.getById(id),
      `No se pudo leer la cotización ${id}`,
    );
    if (!p) {
      throw new NotFoundException(
        cuerpoError(CodigoError.COTIZACION_NO_ENCONTRADA, `Cotización ${id} no encontrada`),
      );
    }
    return p;
  }

  /**
   * Ejecuta una operación contra la base y traduce cualquier fallo inesperado a
   * un 500 con código propio. Las HttpException se relanzan tal cual.
   */
  private async conError<T>(operacion: () => Promise<T>, contexto: string): Promise<T> {
    try {
      return await operacion();
    } catch (error: any) {
      if (error instanceof HttpException) throw error;
      this.log.error(`${contexto}: ${error?.message ?? error}`, error?.stack);
      throw new InternalServerErrorException(
        cuerpoError(CodigoError.COTIZACION_ERROR_INTERNO, `${contexto}. Reintente en unos segundos.`),
      );
    }
  }

  private async porcentajeIgv(): Promise<number> {
    try {
      return await this.config.obtenerNumero('tienda_igv_porcentaje', PORCENTAJE_IGV_POR_DEFECTO);
    } catch (error: any) {
      this.log.warn(`No se pudo leer el IGV configurado: ${error?.message ?? error}`);
      return PORCENTAJE_IGV_POR_DEFECTO;
    }
  }

  /** Código de la proforma; las filas antiguas sin código se muestran por su id. */
  private codigoDe(p: any): string {
    return textoPlano(p.codigo) || codigoProforma(Number(p.id_proforma));
  }

  private nombreCliente(p: any): string | null {
    return (
      textoPlano(p.cliente_nombre_snapshot) ||
      [p.cliente?.nombre, p.cliente?.apellido_paterno, p.cliente?.apellido_materno]
        .map((t) => textoPlano(t))
        .filter(Boolean)
        .join(' ') ||
      textoPlano(p.empresa?.razon_social) ||
      null
    );
  }

  private documentoCliente(p: any): string | null {
    const dni = textoPlano(p.cliente?.dni);
    if (dni) return dni;
    const ruc = textoPlano(p.empresa?.ruc);
    return ruc || null;
  }

  /**
   * Totales listos para mostrar. Las proformas antiguas guardaron el total sin
   * desagregar (gravada e IGV en cero): se recalculan a partir del total para
   * que el documento y la pantalla no muestren un IGV de S/ 0.00. El total
   * cobrado nunca cambia.
   */
  private totalesCoherentes(p: any): {
    total_gravada: number;
    total_igv: number;
    total: number;
    porcentaje_igv: number;
  } {
    const pctBruto = Number(p.porcentaje_igv);
    const porcentaje_igv =
      Number.isFinite(pctBruto) && pctBruto >= 0 ? pctBruto : PORCENTAJE_IGV_POR_DEFECTO;

    const gravada = Number(p.total_gravada ?? 0) || 0;
    const igv = Number(p.total_igv ?? 0) || 0;
    let total = Number(p.total ?? 0) || 0;

    if (total <= 0) {
      // Sin total guardado: se reconstruye sumando los ítems.
      total = redondear(
        (p.items ?? []).reduce((suma: number, item: any) => {
          const importe = Number(item.subtotal ?? 0);
          return (
            suma +
            (Number.isFinite(importe) && importe > 0
              ? importe
              : Number(item.cantidad ?? 0) * Number(item.precio_unitario ?? 0))
          );
        }, 0),
      );
    }

    if (total > 0 && Math.abs(gravada + igv - total) > TOLERANCIA_TOTALES) {
      const desagregado = desagregarIgv(total, porcentaje_igv);
      return {
        total_gravada: desagregado.subtotal,
        total_igv: desagregado.igv,
        total,
        porcentaje_igv,
      };
    }

    return { total_gravada: gravada, total_igv: igv, total, porcentaje_igv };
  }

  private mapProforma(p: any, almacenes?: Map<number, string>): ProformaResponse {
    const totales = this.totalesCoherentes(p);
    const idAlmacen = p.id_almacen ?? null;

    return {
      id_proforma: p.id_proforma,
      codigo: this.codigoDe(p),
      estado: p.estado || 'borrador',
      id_empresa: p.empresa?.id_empresa ?? null,
      id_cliente: p.cliente?.id_cliente ?? null,
      cliente_nombre: this.nombreCliente(p),
      cliente_documento: this.documentoCliente(p),
      cliente_direccion:
        textoPlano(p.cliente?.direccion) || textoPlano(p.empresa?.direccion) || null,
      telefono_envio: p.telefono_envio ?? p.cliente?.telefono ?? null,
      id_almacen: idAlmacen,
      almacen_nombre: idAlmacen ? almacenes?.get(Number(idAlmacen)) ?? null : null,
      observaciones: p.observaciones ?? null,
      valida_hasta: p.valida_hasta ?? null,
      serie: p.serie ?? null,
      numero: p.numero ?? null,
      total_gravada: totales.total_gravada,
      total_igv: totales.total_igv,
      total: totales.total,
      porcentaje_igv: totales.porcentaje_igv,
      id_venta: p.id_venta ?? null,
      enviada_wa_en: p.enviada_wa_en ?? null,
      items:
        p.items?.map((item: any) => ({
          id_producto: item.producto?.id_producto ?? item.id_producto,
          cantidad: Number(item.cantidad),
          precio_unitario: Number(item.precio_unitario ?? 0),
          subtotal: Number(
            item.subtotal ?? Number(item.cantidad) * Number(item.precio_unitario ?? 0),
          ),
          descripcion: item.descripcion_snapshot || item.producto?.nombre || '',
          sku: item.sku_snapshot || item.producto?.sku || '',
        })) ?? [],
      creado_en: p.creado_en,
    };
  }
}

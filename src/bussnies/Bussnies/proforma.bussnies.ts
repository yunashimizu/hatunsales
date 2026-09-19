import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ProformaRepository } from '../../repository/Repository/proforma.repository';
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
  PORCENTAJE_IGV_POR_DEFECTO,
  redondear,
} from '../../util/fiscal/calculo-fiscal';

@Injectable()
export class ProformaBussnies implements IProformaBussniees {

  constructor(
    private readonly repo: ProformaRepository,
    private readonly productoRepo: ProductoRepository,
    private readonly whatsapp: WhatsappPasarela,
    private readonly config: ConfiguracionRepository,
  ) {}

  async getAll(): Promise<ProformaResponse[]> {
    const lista = await this.repo.getAll();
    return lista.map((p) => this.mapProforma(p));
  }

  async getById(id: number): Promise<ProformaResponse> {
    const p = await this.repo.getById(id);
    if (!p) {
      throw new NotFoundException(
        cuerpoError(CodigoError.COTIZACION_NO_ENCONTRADA, `Cotización ${id} no encontrada`),
      );
    }
    return this.mapProforma(p);
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

    const itemsBase: any[] = [];

    for (const item of dto.items) {
      const producto = await this.productoRepo.getById(item.id_producto);
      if (!producto) throw new NotFoundException(`Producto ${item.id_producto} no encontrado`);

      const cantidad = Number(item.cantidad);
      const precioVenta = Number((producto as any).precio_venta ?? 0);
      const descuento = Number((producto as any).descuento ?? 0);
      const precio = redondear(Math.max(0, precioVenta - descuento));
      if (!(cantidad > 0) || !(precio > 0)) {
        throw new BadRequestException(`El producto "${(producto as any).nombre || item.id_producto}" no tiene un precio válido`);
      }

      itemsBase.push({
        producto: { id_producto: item.id_producto } as any,
        cantidad,
        precio_unitario: precio,
        descripcion_snapshot: (item.descripcion || (producto as any).nombre || '').slice(0, 250),
        sku_snapshot: (item.sku || (producto as any).sku || '').slice(0, 80),
      });
    }

    const porcentajeIgv = await this.config.obtenerNumero(
      'tienda_igv_porcentaje',
      PORCENTAJE_IGV_POR_DEFECTO,
    );
    const resumen = calcularComprobante(
      itemsBase.map((item) => ({
        cantidad: item.cantidad,
        precio_unitario: item.precio_unitario,
      })),
      porcentajeIgv,
    );
    const itemsMapped = itemsBase.map((item, indice) => ({
      ...item,
      subtotal: resumen.lineas[indice].total,
    }));

    const dias = Number(dto.dias_vigencia) > 0 ? Number(dto.dias_vigencia) : 7;
    const valida = new Date();
    valida.setDate(valida.getDate() + dias);
    const validaHasta = valida.toISOString().slice(0, 10);

    const numero = await this.repo.siguienteNumero();
    const codigo = `COT-${String(numero).padStart(6, '0')}`;

    const proforma = await this.repo.guardarConItems({
      empresa: idEmpresa ? ({ id_empresa: idEmpresa } as any) : null,
      cliente: idCliente ? ({ id_cliente: idCliente } as any) : null,
      serie: 'COT',
      numero,
      codigo,
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
      items: itemsMapped,
    });

    return this.mapProforma(proforma);
  }

  async marcar(id: number, dto: MarcarProformaRequest): Promise<ProformaResponse> {
    const actual = await this.repo.getById(id);
    if (!actual) {
      throw new NotFoundException(
        cuerpoError(CodigoError.COTIZACION_NO_ENCONTRADA, `Cotización ${id} no encontrada`),
      );
    }

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
      throw new BadRequestException('Una cotización convertida debe indicar la venta asociada');
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

    const actualizado = await this.repo.actualizar(id, cambios);
    return this.mapProforma(actualizado);
  }

  async registrarEnvioWa(id: number, telefono: string) {
    const actual = await this.repo.getById(id);
    if (!actual) {
      throw new NotFoundException(
        cuerpoError(CodigoError.COTIZACION_NO_ENCONTRADA, `Cotización ${id} no encontrada`),
      );
    }
    await this.repo.actualizar(id, {
      telefono_envio: telefono.replace(/\D/g, ''),
      enviada_wa_en: new Date(),
      estado: actual.estado === 'borrador' ? 'enviada' : actual.estado,
    } as any);
    return this.getById(id);
  }

  armarTextoWa(p: ProformaResponse): string {
    const lineas = (p.items || [])
      .slice(0, 8)
      .map(
        (i) =>
          `• ${i.descripcion || 'Producto'} x${i.cantidad} — S/ ${(Number(i.precio_unitario) * Number(i.cantidad)).toFixed(2)}`,
      )
      .join('\n');
    const extra = (p.items?.length || 0) > 8 ? `\n… y ${(p.items.length - 8)} ítem(s) más` : '';
    return [
      `Hola${p.cliente_nombre ? ` ${p.cliente_nombre}` : ''},`,
      `Cotización *${p.codigo || '#' + p.id_proforma}* — HatunSales S.A.C`,
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
      if (!texto) texto = this.armarTextoWa(cot);

      // Vía ferretería: wa.me + adjunto proforma (sin Meta). Meta queda opcional para después.
      if (opts.solo_wa_me !== false) {
        const waMe = this.whatsapp.urlWaMe(destino, texto);
        await this.registrarEnvioWa(opts.id_proforma, destino);
        return {
          modo: 'wa_me' as const,
          ok: true,
          wa_me_url: waMe,
          texto,
          mensaje: 'Abra WhatsApp, adjunte la proforma descargada y envíe.',
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
        await this.registrarEnvioWa(opts.id_proforma, destino);
      }
      return { ...resultado, texto };
    }

    if (!texto) {
      throw new BadRequestException('Indique el texto del mensaje o una cotización');
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

  private mapProforma(p: any): ProformaResponse {
    const nombreCliente =
      p.cliente_nombre_snapshot ||
      [p.cliente?.nombre, p.cliente?.apellido_paterno, p.cliente?.apellido_materno]
        .filter(Boolean)
        .join(' ') ||
      p.empresa?.razon_social ||
      null;

    return {
      id_proforma: p.id_proforma,
      codigo: p.codigo ?? null,
      estado: p.estado || 'borrador',
      id_empresa: p.empresa?.id_empresa ?? null,
      id_cliente: p.cliente?.id_cliente ?? null,
      cliente_nombre: nombreCliente,
      telefono_envio: p.telefono_envio ?? p.cliente?.telefono ?? null,
      id_almacen: p.id_almacen ?? null,
      observaciones: p.observaciones ?? null,
      valida_hasta: p.valida_hasta ?? null,
      serie: p.serie ?? null,
      numero: p.numero ?? null,
      total_gravada: Number(p.total_gravada ?? 0),
      total_igv: Number(p.total_igv ?? 0),
      total: Number(p.total ?? 0),
      porcentaje_igv: Number(p.porcentaje_igv ?? 18),
      id_venta: p.id_venta ?? null,
      enviada_wa_en: p.enviada_wa_en ?? null,
      items:
        p.items?.map((item: any) => ({
          id_producto: item.producto?.id_producto ?? item.id_producto,
          cantidad: Number(item.cantidad),
          precio_unitario: Number(item.precio_unitario ?? 0),
          subtotal: Number(item.subtotal ?? Number(item.cantidad) * Number(item.precio_unitario ?? 0)),
          descripcion: item.descripcion_snapshot || item.producto?.nombre || '',
          sku: item.sku_snapshot || item.producto?.sku || '',
        })) ?? [],
      creado_en: p.creado_en,
    };
  }
}

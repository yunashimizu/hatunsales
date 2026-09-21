import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { GuiaRemisionRepository } from '../../repository/Repository/guia-remision.repository';
import { CrearGuiaRemisionRequest } from '../../models/model/guia-remision.request';
import { GuiaRemisionResponse } from '../../models/model/guia-remision.response';
import { IGuiaRemisionBussniees } from '../Ibussnies/IGuiaRemisionBussniees';
import { emisorConfig } from '../../config/emisor.config';
import { ConfiguracionRepository } from '../../repository/Repository/configuracion.repository';
import { obtenerLogoEmisor } from '../../util/documentos/logo-emisor';
import { generarGuiaRemisionPdf } from '../../util/documentos/guia-remision-pdf';

@Injectable()
export class GuiaRemisionBussnies implements IGuiaRemisionBussniees {

  constructor(
    private readonly repo: GuiaRemisionRepository,
    private readonly config: ConfiguracionRepository,
  ) {}

  async generarPdf(id: number): Promise<{ buffer: Buffer; nombreArchivo: string }> {
    const guia = await this.getById(id);
    const valores = await this.config.obtenerVarias([
      'emisor_ruc', 'emisor_razon_social', 'emisor_direccion', 'emisor_ubicacion', 'emisor_logo_url',
    ]).catch(() => ({} as Record<string, string | null>));
    const dato = (clave: string, defecto: string) => String(valores[clave] ?? '').trim() || defecto;
    const logoUrl = dato('emisor_logo_url', emisorConfig.logo_url);
    const logo = await obtenerLogoEmisor(logoUrl);
    const buffer = await generarGuiaRemisionPdf({
      emisor: {
        ruc: dato('emisor_ruc', emisorConfig.ruc),
        razon_social: dato('emisor_razon_social', emisorConfig.razon_social),
        direccion: dato('emisor_direccion', emisorConfig.direccion),
        ubicacion: dato('emisor_ubicacion', emisorConfig.ubicacion),
        logo,
      },
      codigo: guia.serie && guia.numero ? `${guia.serie}-${String(guia.numero).padStart(8, '0')}` : `BORRADOR-${guia.id_guia}`,
      estado: guia.estado,
      fecha_emision: guia.fecha_emision,
      fecha_inicio_traslado: guia.fecha_inicio_traslado,
      motivo_traslado: guia.motivo_traslado_codigo === '01' ? 'Venta' : guia.motivo_traslado_codigo,
      modalidad_traslado: guia.modalidad_traslado,
      peso_bruto_total: guia.peso_bruto_total,
      unidad_peso: guia.unidad_peso,
      numero_bultos: guia.numero_bultos,
      direccion_origen: guia.direccion_origen,
      direccion_destino: guia.direccion_destino,
      origen_ubigeo: guia.origen_ubigeo,
      destino_ubigeo: guia.destino_ubigeo,
      destinatario: guia.destinatario,
      transporte: {
        placa_principal: guia.transporte.placa_principal,
        conductor_nombre: guia.transporte.conductor_nombre,
        conductor_tipo_doc: guia.transporte.conductor_tipo_doc,
        conductor_numero_doc: guia.transporte.conductor_numero_doc,
        conductor_licencia: guia.transporte.conductor_licencia,
      },
      comprobante: guia.comprobante,
      items: guia.items,
    });
    return { buffer, nombreArchivo: `Guia-Remision-${guia.id_guia}.pdf` };
  }

  async getAll(): Promise<GuiaRemisionResponse[]> {
    return this.repo.getAll();
  }

  async getById(id: number): Promise<GuiaRemisionResponse> {
    const guia = await this.repo.buscarPorId(id);
    if (!guia) throw new NotFoundException(`Guía ${id} no encontrada`);
    return guia;
  }

  async contextoVenta(idVenta: number) {
    const contexto = await this.repo.contextoVenta(idVenta);
    if (!contexto) throw new NotFoundException(`Venta ${idVenta} no encontrada`);
    return contexto;
  }

  async create(dto: CrearGuiaRemisionRequest, idUsuario?: number): Promise<GuiaRemisionResponse> {
    const contexto = await this.repo.contextoVenta(dto.id_venta);
    if (!contexto) throw new NotFoundException(`Venta ${dto.id_venta} no encontrada`);
    if (contexto.venta.estado === 'anulada') {
      throw new BadRequestException('No se puede crear una guía para una venta anulada');
    }
    if (!contexto.items.length) throw new BadRequestException('La venta no tiene productos');
    if (!['1', '6'].includes(contexto.destinatario.tipo_documento)
      || !contexto.destinatario.numero_documento.trim()
      || !contexto.destinatario.denominacion.trim()) {
      throw new BadRequestException('La venta no tiene un destinatario válido');
    }
    if (!contexto.origen.id_almacen || contexto.origen.almacenes.length !== 1) {
      throw new BadRequestException('La venta debe tener un único almacén de origen');
    }
    if (!dto.direccion_origen.trim() || !dto.direccion_destino.trim()) {
      throw new BadRequestException('Indique las direcciones de origen y destino');
    }
    if (!dto.fecha_inicio_traslado
      || dto.peso_bruto_total < 0
      || (dto.numero_bultos != null && dto.numero_bultos < 0)) {
      throw new BadRequestException('Revise la fecha, el peso y la cantidad de bultos');
    }

    const idGuia = await this.repo.crearBorrador(contexto, dto, idUsuario);
    const guia = await this.repo.buscarPorId(idGuia);
    if (!guia) throw new Error(`La guía ${idGuia} no se encontró después de guardarla`);
    return guia;
  }
}

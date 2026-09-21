import { Injectable } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { GuiaRemision } from '../../models/DBModel/guia-remision.entity';
import { CrearGuiaRemisionRequest } from '../../models/model/guia-remision.request';
import { GuiaRemisionItemResponse, GuiaRemisionResponse } from '../../models/model/guia-remision.response';

export interface ContextoVentaGuia {
  venta: {
    id_venta: number;
    fecha: Date;
    total: number;
    estado: string;
    id_cliente?: number;
    id_empresa?: number;
  };
  comprobante?: {
    id_comprobante: number;
    serie: string;
    numero: number;
    estado: string;
    aceptada_sunat: boolean;
  };
  destinatario: {
    tipo_documento: string;
    numero_documento: string;
    denominacion: string;
    direccion: string;
    ubigeo: string;
  };
  items: GuiaRemisionItemResponse[];
  origen: {
    id_almacen: number | null;
    direccion: string;
    ubigeo: string;
    nombre: string;
    almacenes: number[];
  };
}

/**
 * Persistencia de la GRE. La venta y sus salidas de stock son la fuente de
 * verdad; nunca se aceptan cantidades de productos enviadas por el navegador.
 */
@Injectable()
export class GuiaRemisionRepository {
  constructor(
    @InjectRepository(GuiaRemision, 'pgConnection')
    private readonly guiaRepo: Repository<GuiaRemision>,
    @InjectDataSource('pgConnection')
    private readonly dataSource: DataSource,
  ) {
  }

  async getAll(): Promise<GuiaRemisionResponse[]> {
    const filas = await this.dataSource.query(`
      SELECT g.id_guia,
             g.id_venta,
             g.id_comprobante,
             g.serie,
             g.numero,
             COALESCE(g.estado, 'borrador') AS estado,
             g.fecha_emision,
             g.fecha_inicio_traslado,
             g.motivo_traslado_codigo,
             g.modalidad_traslado,
             g.direccion_origen,
             g.direccion_destino,
             COALESCE(g.destinatario_denominacion, e.razon_social,
                      NULLIF(TRIM(CONCAT_WS(' ', c.nombre, c.apellido_paterno, c.apellido_materno)), ''),
                      'Sin destinatario') AS destinatario_denominacion,
             COALESCE(g.destinatario_numero_doc, e.ruc, c.dni::text, '') AS destinatario_numero_doc,
             g.error_mensaje,
             g.sunat_description,
             g.enlace_pdf,
             g.enlace_xml,
             g.creado_en,
             (SELECT COUNT(*)::int FROM guias_remision_items gi WHERE gi.id_guia = g.id_guia) AS cantidad_items
        FROM guias_remision g
        LEFT JOIN empresas e ON e.id_empresa = g.id_empresa
        LEFT JOIN clientes c ON c.id_cliente = g.id_cliente
       ORDER BY g.id_guia DESC
       LIMIT 200
    `);

    return filas.map((fila: any) => this.mapListado(fila));
  }

  async contextoVenta(idVenta: number): Promise<ContextoVentaGuia | null> {
    const cabecera = await this.dataSource.query(`
      SELECT v.id_venta,
             v.fecha,
             COALESCE(v.total, 0) AS total,
             COALESCE(v.estado, 'activa') AS estado,
             v.id_cliente,
             v.id_empresa,
             COALESCE(e.ruc, c.dni::text, '') AS destinatario_numero_doc,
             CASE WHEN e.id_empresa IS NOT NULL THEN '6' ELSE '1' END AS destinatario_tipo_doc,
             COALESCE(
               NULLIF(TRIM(e.razon_social), ''),
               NULLIF(TRIM(CONCAT_WS(' ', c.nombre, c.apellido_paterno, c.apellido_materno)), ''),
               'CLIENTES VARIOS'
             ) AS destinatario_denominacion,
             COALESCE(e.direccion, c.direccion, '') AS destinatario_direccion,
             COALESCE(e.ubigeo, '') AS destinatario_ubigeo
        FROM ventas v
        LEFT JOIN clientes c ON c.id_cliente = v.id_cliente
        LEFT JOIN empresas e ON e.id_empresa = v.id_empresa
       WHERE v.id_venta = $1
       LIMIT 1
    `, [idVenta]);

    if (!cabecera[0]) return null;

    const comprobantes = await this.dataSource.query(`
      SELECT id_comprobante, serie, numero, COALESCE(estado, '') AS estado,
             COALESCE(aceptada_sunat, FALSE) AS aceptada_sunat
        FROM comprobantes
       WHERE id_venta = $1 AND COALESCE(anulado, FALSE) = FALSE
       ORDER BY aceptada_sunat DESC, creado_en DESC
       LIMIT 1
    `, [idVenta]);

    const items = await this.dataSource.query(`
      SELECT (
               SELECT MIN(d.id_detalle)
                 FROM detalle_venta d
                WHERE d.id_venta = s.id_venta AND d.id_producto = s.id_producto
             ) AS id_venta_detalle,
             s.id_producto,
             COALESCE(SUM(s.cantidad), 0) AS cantidad,
             COALESCE(p.sku, p.codigo_barras, s.id_producto::text) AS codigo,
             COALESCE(p.nombre, 'Producto') AS descripcion,
             COALESCE(p.unidad_medida, 'NIU') AS unidad_medida
        FROM venta_stock_salida s
        LEFT JOIN productos p ON p.id_producto = s.id_producto
       WHERE s.id_venta = $1
       GROUP BY s.id_producto, p.sku, p.codigo_barras, p.nombre, p.unidad_medida
       ORDER BY MIN(s.id)
    `, [idVenta]);

    const salidas = await this.dataSource.query(`
      SELECT id_producto, id_almacen, cantidad
        FROM venta_stock_salida
       WHERE id_venta = $1
       ORDER BY id, id_producto
    `, [idVenta]);

    const almacenes: number[] = Array.from(new Set(
      salidas.map((fila: any) => Number(fila.id_almacen)).filter((id: number) => id > 0),
    ));
    const origen = almacenes.length === 1
      ? await this.dataSource.query(`
          SELECT a.id_almacen,
                 COALESCE(NULLIF(TRIM(s.direccion), ''), '') AS direccion,
               '' AS ubigeo,
                 COALESCE(a.nombre, s.nombre, 'Almacén') AS nombre
            FROM almacenes a
            LEFT JOIN sucursales s ON s.id_sucursal = a.id_sucursal
           WHERE a.id_almacen = $1
           LIMIT 1
        `, [almacenes[0]])
      : [];

    return {
      venta: {
        id_venta: Number(cabecera[0].id_venta),
        fecha: cabecera[0].fecha,
        total: Number(cabecera[0].total ?? 0),
        estado: String(cabecera[0].estado ?? 'activa'),
        id_cliente: cabecera[0].id_cliente ? Number(cabecera[0].id_cliente) : undefined,
        id_empresa: cabecera[0].id_empresa ? Number(cabecera[0].id_empresa) : undefined,
      },
      comprobante: comprobantes[0]
        ? {
            id_comprobante: Number(comprobantes[0].id_comprobante),
            serie: comprobantes[0].serie,
            numero: Number(comprobantes[0].numero),
            estado: comprobantes[0].estado,
            aceptada_sunat: Boolean(comprobantes[0].aceptada_sunat),
          }
        : undefined,
      destinatario: {
        tipo_documento: String(cabecera[0].destinatario_tipo_doc ?? ''),
        numero_documento: String(cabecera[0].destinatario_numero_doc ?? ''),
        denominacion: String(cabecera[0].destinatario_denominacion ?? ''),
        direccion: String(cabecera[0].destinatario_direccion ?? ''),
        ubigeo: String(cabecera[0].destinatario_ubigeo ?? ''),
      },
      items: items.map((item: any, indice: number) => ({
        id_producto: Number(item.id_producto),
        id_venta_detalle: Number(item.id_venta_detalle),
        codigo: String(item.codigo ?? ''),
        descripcion: String(item.descripcion ?? 'Producto'),
        cantidad: Number(item.cantidad ?? 0),
        unidad_medida: String(item.unidad_medida ?? 'NIU'),
        orden: indice + 1,
      })),
      origen: {
        id_almacen: almacenes.length === 1 ? almacenes[0] : null,
        direccion: String(origen[0]?.direccion ?? ''),
        ubigeo: String(origen[0]?.ubigeo ?? ''),
        nombre: String(origen[0]?.nombre ?? ''),
        almacenes,
      },
    };
  }

  async buscarPorId(idGuia: number): Promise<GuiaRemisionResponse | null> {
    const filas = await this.dataSource.query(
      'SELECT * FROM guias_remision WHERE id_guia = $1 LIMIT 1',
      [idGuia],
    );
    if (!filas[0]) return null;

    const items = await this.dataSource.query(`
      SELECT id_item, id_producto, id_venta_detalle, codigo, descripcion,
             cantidad, unidad_medida, orden
        FROM guias_remision_items
       WHERE id_guia = $1
       ORDER BY COALESCE(orden, 999999), id_item
    `, [idGuia]);

    const detalle = this.mapDetalle(filas[0], items);
    if (filas[0].id_comprobante) {
      const comprobantes = await this.dataSource.query(
        'SELECT serie, numero FROM comprobantes WHERE id_comprobante = $1 LIMIT 1',
        [filas[0].id_comprobante],
      );
      if (comprobantes[0]) {
        detalle.comprobante = { serie: String(comprobantes[0].serie ?? ''), numero: Number(comprobantes[0].numero ?? 0) };
      }
    }
    return detalle;
  }

  async buscarPorClaveIdempotencia(clave: string): Promise<number | null> {
    const filas = await this.dataSource.query(
      'SELECT id_guia FROM guias_remision WHERE clave_idempotencia = $1 LIMIT 1',
      [clave],
    );
    return filas[0]?.id_guia ? Number(filas[0].id_guia) : null;
  }

  async crearBorrador(
    contexto: ContextoVentaGuia,
    dto: CrearGuiaRemisionRequest,
    idUsuario?: number,
  ): Promise<number> {
    return this.dataSource.transaction(async (manager) => {
      if (dto.clave_idempotencia) {
        const previas = await manager.query(
          'SELECT id_guia FROM guias_remision WHERE clave_idempotencia = $1 LIMIT 1',
          [dto.clave_idempotencia],
        );
        if (previas[0]?.id_guia) return Number(previas[0].id_guia);
      }

      const filas = await manager.query(`
        INSERT INTO guias_remision (
          id_venta, id_comprobante, id_empresa, id_cliente, id_almacen_origen,
          id_usuario, tipo_guia, estado, fecha, fecha_emision,
          fecha_inicio_traslado, motivo_traslado, motivo_traslado_codigo,
          modalidad_traslado, direccion_origen, direccion_destino,
          origen_ubigeo, destino_ubigeo, direccion_envio, peso_total,
          peso_bruto_total, unidad_peso, numero_bultos,
          destinatario_tipo_doc, destinatario_numero_doc, destinatario_denominacion,
          destinatario_direccion, placa_principal, marca_vehiculo,
          conductor_nombre, conductor_tipo_doc, conductor_numero_doc,
          conductor_licencia, transportista_ruc, transportista_denominacion,
          observaciones, clave_idempotencia
        ) VALUES (
          $1, $2, $3, $4, $5, $6, 'remitente', 'borrador', NOW(), $7,
          $8, 'Venta', $9, $10, $11, $12, $13, $14, $12, $15::text,
          $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26,
          $27, $28, $29, $30, $31
        ) RETURNING id_guia
      `, [
        contexto.venta.id_venta,
        dto.id_comprobante ?? contexto.comprobante?.id_comprobante ?? null,
        contexto.venta.id_empresa ?? null,
        contexto.venta.id_cliente ?? null,
        contexto.origen.id_almacen,
        idUsuario ?? null,
        dto.fecha_emision ?? new Date().toISOString().slice(0, 10),
        dto.fecha_inicio_traslado,
        dto.motivo_traslado_codigo,
        dto.modalidad_traslado,
        dto.direccion_origen,
        dto.direccion_destino,
        dto.origen_ubigeo ?? contexto.origen.ubigeo ?? null,
        dto.destino_ubigeo ?? contexto.destinatario.ubigeo ?? null,
        dto.peso_bruto_total,
        dto.unidad_peso,
        dto.numero_bultos ?? null,
        contexto.destinatario.tipo_documento,
        contexto.destinatario.numero_documento,
        contexto.destinatario.denominacion,
        dto.direccion_destino,
        dto.placa_principal ?? null,
        dto.marca_vehiculo ?? null,
        dto.conductor_nombre ?? null,
        dto.conductor_tipo_doc ?? null,
        dto.conductor_numero_doc ?? null,
        dto.conductor_licencia ?? null,
        dto.transportista_ruc ?? null,
        dto.transportista_denominacion ?? null,
        dto.observaciones ?? null,
        dto.clave_idempotencia ?? null,
      ]);

      const idGuia = Number(filas[0]?.id_guia);
      for (const item of contexto.items) {
        await manager.query(`
          INSERT INTO guias_remision_items
            (id_guia, id_producto, id_venta_detalle, codigo, descripcion, cantidad, unidad_medida, orden)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        `, [
          idGuia,
          item.id_producto,
          item.id_venta_detalle ?? null,
          item.codigo,
          item.descripcion,
          item.cantidad,
          item.unidad_medida,
          item.orden ?? 1,
        ]);
      }

      return idGuia;
    });
  }

  async actualizarEstado(idGuia: number, data: Record<string, any>): Promise<void> {
    const entradas = Object.entries(data).filter(([, valor]) => valor !== undefined);
    if (!entradas.length) return;
    const columnas = entradas.map(([columna], indice) => `${columna} = $${indice + 1}`);
    await this.dataSource.query(
      `UPDATE guias_remision SET ${columnas.join(', ')} WHERE id_guia = $${entradas.length + 1}`,
      [...entradas.map(([, valor]) => valor), idGuia],
    );
  }

  private mapListado(fila: any): GuiaRemisionResponse {
    return {
      id_guia: Number(fila.id_guia),
      id_venta: fila.id_venta ? Number(fila.id_venta) : undefined,
      id_comprobante: fila.id_comprobante ? Number(fila.id_comprobante) : undefined,
      tipo_guia: fila.tipo_guia ?? 'remitente',
      serie: fila.serie ?? undefined,
      numero: fila.numero ? Number(fila.numero) : undefined,
      numero_formateado: fila.serie && fila.numero
        ? `${fila.serie}-${String(fila.numero).padStart(8, '0')}`
        : undefined,
      estado: fila.estado ?? 'borrador',
      fecha_emision: fila.fecha_emision ?? undefined,
      fecha_inicio_traslado: fila.fecha_inicio_traslado ?? undefined,
      motivo_traslado_codigo: fila.motivo_traslado_codigo ?? undefined,
      modalidad_traslado: fila.modalidad_traslado ?? undefined,
      direccion_origen: fila.direccion_origen ?? '',
      direccion_destino: fila.direccion_destino ?? '',
      destinatario: {
        tipo_documento: '',
        numero_documento: fila.destinatario_numero_doc ?? '',
        denominacion: fila.destinatario_denominacion ?? '',
        direccion: fila.direccion_destino ?? '',
      },
      transporte: this.transporteVacio(),
      error_mensaje: fila.error_mensaje ?? undefined,
      sunat_description: fila.sunat_description ?? undefined,
      enlace_pdf: fila.enlace_pdf ?? undefined,
      enlace_xml: fila.enlace_xml ?? undefined,
      creado_en: fila.creado_en,
      items: [],
      advertencias: fila.cantidad_items === 0 ? ['La guía no tiene ítems registrados.'] : [],
    };
  }

  private mapDetalle(fila: any, items: any[]): GuiaRemisionResponse {
    return {
      id_guia: Number(fila.id_guia),
      id_venta: fila.id_venta ? Number(fila.id_venta) : undefined,
      id_comprobante: fila.id_comprobante ? Number(fila.id_comprobante) : undefined,
      id_empresa: fila.id_empresa ? Number(fila.id_empresa) : undefined,
      id_cliente: fila.id_cliente ? Number(fila.id_cliente) : undefined,
      tipo_guia: fila.tipo_guia ?? 'remitente',
      sunat_tipo_documento: fila.sunat_tipo_documento ?? undefined,
      serie: fila.serie ?? undefined,
      numero: fila.numero ? Number(fila.numero) : undefined,
      numero_formateado: fila.serie && fila.numero
        ? `${fila.serie}-${String(fila.numero).padStart(8, '0')}`
        : undefined,
      estado: fila.estado ?? 'borrador',
      fecha_emision: fila.fecha_emision ?? undefined,
      fecha_inicio_traslado: fila.fecha_inicio_traslado ?? undefined,
      motivo_traslado_codigo: fila.motivo_traslado_codigo ?? undefined,
      modalidad_traslado: fila.modalidad_traslado ?? undefined,
      direccion_origen: fila.direccion_origen ?? '',
      direccion_destino: fila.direccion_destino ?? '',
      origen_ubigeo: fila.origen_ubigeo ?? undefined,
      destino_ubigeo: fila.destino_ubigeo ?? undefined,
      peso_bruto_total: fila.peso_bruto_total != null ? Number(fila.peso_bruto_total) : undefined,
      unidad_peso: fila.unidad_peso ?? 'KGM',
      numero_bultos: fila.numero_bultos != null ? Number(fila.numero_bultos) : undefined,
      destinatario: {
        tipo_documento: fila.destinatario_tipo_doc ?? '',
        numero_documento: fila.destinatario_numero_doc ?? '',
        denominacion: fila.destinatario_denominacion ?? '',
        direccion: fila.destinatario_direccion ?? fila.direccion_destino ?? '',
      },
      transporte: {
        placa_principal: fila.placa_principal ?? '',
        marca_vehiculo: fila.marca_vehiculo ?? '',
        conductor_nombre: fila.conductor_nombre ?? '',
        conductor_tipo_doc: fila.conductor_tipo_doc ?? '',
        conductor_numero_doc: fila.conductor_numero_doc ?? '',
        conductor_licencia: fila.conductor_licencia ?? '',
        transportista_ruc: fila.transportista_ruc ?? '',
        transportista_denominacion: fila.transportista_denominacion ?? '',
      },
      observaciones: fila.observaciones ?? undefined,
      error_mensaje: fila.error_mensaje ?? undefined,
      sunat_description: fila.sunat_description ?? undefined,
      sunat_responsecode: fila.sunat_responsecode ?? undefined,
      sunat_ticket: fila.sunat_ticket ?? undefined,
      cadena_qr: fila.cadena_qr ?? undefined,
      codigo_hash: fila.codigo_hash ?? undefined,
      enlace_pdf: fila.enlace_pdf ?? undefined,
      enlace_xml: fila.enlace_xml ?? undefined,
      enlace_cdr: fila.enlace_cdr ?? undefined,
      creado_en: fila.creado_en,
      items: items.map((item: any) => ({
        id_item: Number(item.id_item),
        id_producto: Number(item.id_producto),
        id_venta_detalle: item.id_venta_detalle ? Number(item.id_venta_detalle) : undefined,
        codigo: item.codigo ?? '',
        descripcion: item.descripcion ?? 'Producto',
        cantidad: Number(item.cantidad ?? 0),
        unidad_medida: item.unidad_medida ?? 'NIU',
        orden: item.orden ? Number(item.orden) : undefined,
      })),
      advertencias: [],
    };
  }

  private transporteVacio() {
    return {
      placa_principal: '',
      marca_vehiculo: '',
      conductor_nombre: '',
      conductor_tipo_doc: '',
      conductor_numero_doc: '',
      conductor_licencia: '',
      transportista_ruc: '',
      transportista_denominacion: '',
    };
  }
}

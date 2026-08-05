import {
  BadRequestException, ConflictException, Inject, Injectable, NotFoundException,
} from '@nestjs/common';
import { RecepcionRepository, LineaRecepcionInput } from '../../repository/Repository/recepcion.repository';
import { InventarioBussnies } from './inventario.bussnies';
import { ProductoRepository } from '../../repository/Repository/producto.repository';
import { ALMACEN_ARCHIVOS } from '../../util/storage/almacen.interface';
import type { AlmacenArchivos } from '../../util/storage/almacen.interface';
import type { UsuarioToken } from '../../guards/usuario-actual.decorator';
import { CodigoError, cuerpoError } from '../../util/errores-operativos';

@Injectable()
export class RecepcionBussnies {
  constructor(
    private readonly repo: RecepcionRepository,
    private readonly inventario: InventarioBussnies,
    private readonly productos: ProductoRepository,
    @Inject(ALMACEN_ARCHIVOS) private readonly archivos: AlmacenArchivos,
  ) {}

  // ── Proveedores ──────────────────────────────────────────────

  listarProveedores() {
    return this.repo.listarProveedores();
  }

  async crearProveedor(body: any) {
    const nombre = (body?.nombre ?? '').trim();
    if (!nombre) throw new BadRequestException('El nombre del proveedor es obligatorio');
    return this.repo.crearProveedor({
      nombre,
      ruc: body?.ruc,
      telefono: body?.telefono,
      email: body?.email,
      direccion: body?.direccion,
    });
  }

  async actualizarProveedor(id: number, body: any) {
    const nombre = (body?.nombre ?? '').trim();
    if (!nombre) throw new BadRequestException('El nombre del proveedor es obligatorio');
    const actualizado = await this.repo.actualizarProveedor(id, {
      nombre,
      ruc: body?.ruc,
      telefono: body?.telefono,
      email: body?.email,
      direccion: body?.direccion,
    });
    if (!actualizado) throw new NotFoundException('Proveedor no encontrado');
    return actualizado;
  }

  async eliminarProveedor(id: number) {
    try {
      const ok = await this.repo.eliminarProveedor(id);
      if (!ok) throw new NotFoundException('Proveedor no encontrado');
      return { eliminado: true };
    } catch (e: any) {
      if (e?.message === 'PROVEEDOR_EN_USO') {
        throw new ConflictException('No se puede eliminar: el proveedor ya tiene recepciones');
      }
      throw e;
    }
  }

  // ── Recepción ────────────────────────────────────────────────

  listarRecepciones(idProveedor?: number) {
    return this.repo.listarRecepciones(50, idProveedor);
  }

  async detalle(id: number) {
    const det = await this.repo.detalleRecepcion(id);
    if (!det) throw new NotFoundException('Recepción no encontrada');
    return det;
  }

  async confirmar(body: any, usuario?: UsuarioToken) {
    await this.repo.asegurarSchema();

    const idProveedor = Number(body?.id_proveedor);
    const idAlmacen = Number(body?.id_almacen);
    const nroGuia = String(body?.nro_guia ?? '').trim();
    const itemsRaw: any[] = Array.isArray(body?.items) ? body.items : [];

    if (!idProveedor) throw new BadRequestException('Seleccione el proveedor');
    if (!idAlmacen) throw new BadRequestException('Seleccione el almacén de destino');
    if (!nroGuia) throw new BadRequestException('Ingrese el número de guía / remisión');
    if (!itemsRaw.length) {
      throw new BadRequestException(
        cuerpoError(CodigoError.RECEPCION_SIN_ITEMS, 'Agregue al menos un producto'),
      );
    }

    const items: LineaRecepcionInput[] = [];
    for (const raw of itemsRaw) {
      const idProducto = Number(raw.id_producto);
      const cantidadOk = Number(raw.cantidad_ok ?? 0);
      const cantidadObs = Number(raw.cantidad_observada ?? 0);
      if (!idProducto) throw new BadRequestException('Hay una línea sin producto');
      if (cantidadOk < 0 || cantidadObs < 0) {
        throw new BadRequestException('Las cantidades no pueden ser negativas');
      }
      if (cantidadOk + cantidadObs <= 0) {
        throw new BadRequestException('Cada línea debe tener cantidad OK u observada');
      }
      if (cantidadObs > 0 && !(raw.motivo_observacion || raw.nota || '').toString().trim()) {
        throw new BadRequestException('Las líneas observadas requieren un motivo');
      }
      const producto = await this.productos.getById(idProducto);
      if (!producto) throw new NotFoundException(`Producto ${idProducto} no encontrado`);

      const precioCompra =
        raw.precio_compra !== undefined && raw.precio_compra !== null && raw.precio_compra !== ''
          ? Number(raw.precio_compra)
          : null;

      items.push({
        id_producto: idProducto,
        cantidad_ok: cantidadOk,
        cantidad_observada: cantidadObs,
        nota: raw.nota,
        motivo_observacion: raw.motivo_observacion || raw.nota,
        precio_compra:
          precioCompra != null && Number.isFinite(precioCompra) && precioCompra >= 0
            ? precioCompra
            : null,
      });
    }

    const creada = await this.repo.crearRecepcion({
      id_proveedor: idProveedor,
      id_almacen: idAlmacen,
      nro_guia: nroGuia,
      nro_documento: String(body?.nro_documento ?? '').trim(),
      observaciones: String(body?.observaciones ?? '').trim(),
      id_usuario: usuario?.id_usuario,
      items,
    });

    const stockOk: number[] = [];
    const stockFallido: { id_producto: number; error: string }[] = [];

    // Solo lo OK entra al inventario ahora (ajustes reportan fallo parcial).
    for (const item of items) {
      if (item.cantidad_ok > 0) {
        try {
          await this.inventario.ajustar({
            id_producto: item.id_producto,
            id_almacen: idAlmacen,
            cantidad: item.cantidad_ok,
            motivo: 'compra',
            comentario: `Recepción #${creada.id_recepcion} · Guía ${nroGuia}`,
          });
          stockOk.push(item.id_producto);
        } catch (e: any) {
          stockFallido.push({
            id_producto: item.id_producto,
            error: e?.message || 'Error al ajustar stock',
          });
        }
      }

      if (item.precio_compra != null) {
        try {
          await this.productos.update(item.id_producto, {
            precio_compra: item.precio_compra,
          } as any);
        } catch {
          /* no bloquea la recepción */
        }
      }
    }

    let mensaje = creada.observaciones.length
      ? 'Recepción confirmada. Lo observado espera visto bueno.'
      : 'Recepción confirmada. Stock actualizado.';
    if (stockFallido.length) {
      mensaje += ` Atención: ${stockFallido.length} línea(s) no sumaron stock; revise Inventario.`;
    }

    return {
      id_recepcion: creada.id_recepcion,
      observaciones: creada.observaciones,
      stock_ingresado: stockOk,
      stock_fallido: stockFallido,
      mensaje,
    };
  }

  listarObservaciones(estado?: string) {
    return this.repo.listarObservaciones(estado);
  }

  async aprobarObservacion(id: number, usuario?: UsuarioToken, comentario?: string) {
    const obs = await this.repo.buscarObservacion(id);
    if (!obs) throw new NotFoundException('Observación no encontrada');
    if (obs.estado !== 'pendiente') {
      throw new BadRequestException('Esta observación ya fue revisada');
    }

    const cantidad = Number(obs.cantidad);
    if (cantidad <= 0) throw new BadRequestException('Cantidad inválida');

    await this.inventario.ajustar({
      id_producto: Number(obs.id_producto),
      id_almacen: Number(obs.id_almacen),
      cantidad,
      motivo: 'compra',
      comentario: `Obs. aprobada #${id} · Guía ${obs.nro_guia}${comentario ? ` · ${comentario}` : ''}`,
    });

    const actualizada = await this.repo.marcarObservacion(id, 'aprobado', usuario?.id_usuario, comentario);
    return { ...actualizada, stock_ingresado: cantidad };
  }

  async rechazarObservacion(id: number, usuario?: UsuarioToken, comentario?: string) {
    const obs = await this.repo.buscarObservacion(id);
    if (!obs) throw new NotFoundException('Observación no encontrada');
    if (obs.estado !== 'pendiente') {
      throw new BadRequestException('Esta observación ya fue revisada');
    }
    const actualizada = await this.repo.marcarObservacion(
      id,
      'rechazado',
      usuario?.id_usuario,
      comentario || 'Rechazado',
    );
    return actualizada;
  }

  async subirFoto(idObservacion: number, archivo: {
    originalname: string; mimetype: string; buffer: Buffer; size: number;
  }) {
    const obs = await this.repo.buscarObservacion(idObservacion);
    if (!obs) throw new NotFoundException('Observación no encontrada');
    if (!archivo?.buffer?.length) throw new BadRequestException('No se recibió imagen');

    const mime = (archivo.mimetype || '').toLowerCase();
    if (!mime.startsWith('image/')) {
      throw new BadRequestException('Solo se permiten imágenes');
    }

    const subida = await this.archivos.guardar({
      buffer: archivo.buffer,
      nombre_original: archivo.originalname,
      mime: archivo.mimetype,
      carpeta: `recepcion/${idObservacion}`,
    });

    return this.repo.agregarAdjunto(idObservacion, subida.url, subida.mime);
  }
}

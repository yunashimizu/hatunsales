import {
  BadRequestException, ConflictException, Inject, Injectable, NotFoundException,
} from '@nestjs/common';
import {
  RecepcionRepository, LineaRecepcionInput, ResultadoRevision,
} from '../../repository/Repository/recepcion.repository';
import { InventarioBussnies } from './inventario.bussnies';
import { ALMACEN_ARCHIVOS } from '../../util/storage/almacen.interface';
import type { AlmacenArchivos } from '../../util/storage/almacen.interface';
import type { UsuarioToken } from '../../guards/usuario-actual.decorator';
import { CodigoError, cuerpoError } from '../../util/errores-operativos';

/** productos.precio_compra es NUMERIC(10,2). */
const PRECIO_COMPRA_MAXIMO = 99_999_999.99;

@Injectable()
export class RecepcionBussnies {
  constructor(
    private readonly repo: RecepcionRepository,
    private readonly inventario: InventarioBussnies,
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

  /**
   * Confirma la recepción en una sola transacción (todo o nada): cabecera, líneas,
   * observaciones, ingreso de lo OK al inventario y precio de compra. Antes cada línea
   * sumaba stock en su propia transacción después de crear la recepción: un fallo dejaba
   * stock parcial y un reintento (respuesta perdida, doble envío) duplicaba recepción y
   * stock. La `clave_idempotencia` (cuerpo o cabecera Idempotency-Key) hace que el
   * reintento devuelva la recepción ya registrada.
   */
  async confirmar(body: any, usuario?: UsuarioToken, claveCabecera?: string) {
    const idProveedor = Number(body?.id_proveedor);
    const idAlmacen = Number(body?.id_almacen);
    const nroGuia = String(body?.nro_guia ?? '').trim();
    const itemsRaw: any[] = Array.isArray(body?.items) ? body.items : [];
    const clave = String(body?.clave_idempotencia ?? claveCabecera ?? '').trim().slice(0, 80) || null;

    if (!idProveedor) throw new BadRequestException('Seleccione el proveedor');
    if (!idAlmacen) throw new BadRequestException('Seleccione el almacén de destino');
    if (!nroGuia) throw new BadRequestException('Ingrese el número de guía / remisión');
    if (!itemsRaw.length) {
      throw new BadRequestException(
        cuerpoError(CodigoError.RECEPCION_SIN_ITEMS, 'Agregue al menos un producto'),
      );
    }

    const items: LineaRecepcionInput[] = itemsRaw.map((raw) => this.validarLinea(raw));

    const existentes = await this.repo.productosExistentes(items.map((i) => i.id_producto));
    const faltante = items.find((i) => !existentes.has(i.id_producto));
    if (faltante) throw new NotFoundException(`Producto ${faltante.id_producto} no encontrado`);

    const comentarioStock = (idRecepcion: number) => `Recepción #${idRecepcion} · Guía ${nroGuia}`;
    // Mismo orden de candados (por producto) en recepciones simultáneas: evita bloqueos cruzados.
    const conStock = items
      .filter((i) => i.cantidad_ok > 0)
      .sort((a, b) => a.id_producto - b.id_producto);

    const registrada = await this.repo.registrarRecepcion(
      {
        id_proveedor: idProveedor,
        id_almacen: idAlmacen,
        nro_guia: nroGuia,
        nro_documento: String(body?.nro_documento ?? '').trim(),
        observaciones: String(body?.observaciones ?? '').trim(),
        id_usuario: usuario?.id_usuario,
        items,
        clave,
      },
      async (manager, creada) => {
        for (const item of conStock) {
          await this.inventario.ajustarEnTransaccion(manager, {
            id_producto: item.id_producto,
            id_almacen: idAlmacen,
            cantidad: item.cantidad_ok,
            motivo: 'compra',
            comentario: comentarioStock(creada.id_recepcion),
          });
        }
        for (const item of items) {
          if (item.precio_compra != null) {
            await this.repo.actualizarPrecioCompra(manager, item.id_producto, item.precio_compra);
          }
        }
      },
    );

    const mensaje = registrada.repetida
      ? `Esta recepción ya estaba registrada (#${registrada.id_recepcion}); no se volvió a sumar stock.`
      : registrada.observaciones.length
        ? 'Recepción confirmada. Lo observado espera visto bueno.'
        : 'Recepción confirmada. Stock actualizado.';

    return {
      id_recepcion: registrada.id_recepcion,
      observaciones: registrada.observaciones,
      stock_ingresado: registrada.repetida ? [] : conStock.map((i) => i.id_producto),
      // Se conserva por compatibilidad con el front: con la transacción única ya no hay fallos parciales.
      stock_fallido: [] as { id_producto: number; error: string }[],
      repetida: registrada.repetida,
      mensaje,
    };
  }

  /** Valida una línea de la guía. Las cantidades van al inventario (entero): se exigen enteras. */
  private validarLinea(raw: any): LineaRecepcionInput {
    const idProducto = Number(raw?.id_producto);
    const cantidadOk = Number(raw?.cantidad_ok ?? 0);
    const cantidadObs = Number(raw?.cantidad_observada ?? 0);
    if (!idProducto) throw new BadRequestException('Hay una línea sin producto');
    if (!Number.isFinite(cantidadOk) || !Number.isFinite(cantidadObs) || cantidadOk < 0 || cantidadObs < 0) {
      throw new BadRequestException('Las cantidades no pueden ser negativas');
    }
    if (!Number.isInteger(cantidadOk) || !Number.isInteger(cantidadObs)) {
      throw new BadRequestException(
        `Las cantidades del producto ${idProducto} deben ser números enteros de unidades (sin decimales)`,
      );
    }
    if (cantidadOk + cantidadObs <= 0) {
      throw new BadRequestException('Cada línea debe tener cantidad OK u observada');
    }
    if (cantidadObs > 0 && !(raw.motivo_observacion || raw.nota || '').toString().trim()) {
      throw new BadRequestException('Las líneas observadas requieren un motivo');
    }

    const precioCompra =
      raw.precio_compra !== undefined && raw.precio_compra !== null && raw.precio_compra !== ''
        ? Number(raw.precio_compra)
        : null;
    if (precioCompra != null && precioCompra > PRECIO_COMPRA_MAXIMO) {
      throw new BadRequestException(`El precio de compra del producto ${idProducto} es demasiado alto`);
    }

    return {
      id_producto: idProducto,
      cantidad_ok: cantidadOk,
      cantidad_observada: cantidadObs,
      nota: raw.nota,
      motivo_observacion: raw.motivo_observacion || raw.nota,
      precio_compra:
        precioCompra != null && Number.isFinite(precioCompra) && precioCompra >= 0
          ? precioCompra
          : null,
    };
  }

  listarObservaciones(estado?: string) {
    return this.repo.listarObservaciones(estado);
  }

  /**
   * Visto bueno: marca la observación y suma el stock en la MISMA transacción, y solo si
   * seguía pendiente. Antes se leía el estado, se sumaba el stock y recién después se
   * marcaba: un doble clic o dos usuarios a la vez sumaban el stock dos veces, y un
   * rechazo cruzado dejaba stock de una observación rechazada.
   */
  async aprobarObservacion(id: number, usuario?: UsuarioToken, comentario?: string) {
    let cantidad = 0;
    const revision = await this.repo.revisarObservacion(
      id,
      'aprobado',
      usuario?.id_usuario,
      comentario,
      async (manager, obs) => {
        cantidad = Number(obs.cantidad);
        if (!(cantidad > 0)) throw new BadRequestException('Cantidad inválida');
        await this.inventario.ajustarEnTransaccion(manager, {
          id_producto: Number(obs.id_producto),
          id_almacen: Number(obs.id_almacen),
          cantidad,
          motivo: 'compra',
          comentario: `Obs. aprobada #${id} · Guía ${obs.nro_guia}${comentario ? ` · ${comentario}` : ''}`,
        });
      },
    );
    return { ...this.observacionRevisada(revision), stock_ingresado: cantidad };
  }

  async rechazarObservacion(id: number, usuario?: UsuarioToken, comentario?: string) {
    const revision = await this.repo.revisarObservacion(
      id,
      'rechazado',
      usuario?.id_usuario,
      comentario || 'Rechazado',
    );
    return this.observacionRevisada(revision);
  }

  private observacionRevisada(revision: ResultadoRevision) {
    if (revision.resultado === 'no_existe') throw new NotFoundException('Observación no encontrada');
    if (revision.resultado === 'ya_revisada') {
      throw new BadRequestException(
        `Esta observación ya fue revisada (${revision.estado}). Actualice la lista.`,
      );
    }
    return revision.observacion;
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

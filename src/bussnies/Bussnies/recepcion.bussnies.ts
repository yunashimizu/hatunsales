import {
  BadRequestException, ConflictException, Inject, Injectable, NotFoundException, Optional,
} from '@nestjs/common';
import {
  RecepcionRepository, LineaRecepcionInput, ResultadoRevision, RecepcionConGuia, RecepcionRegistrada, INDICE_GUIA_UNICA,
} from '../../repository/Repository/recepcion.repository';
import { ControlStockService } from '../../stock/control-stock.service';
import type { ModoGuiaRepetida } from '../../stock/control-stock';
import { BitacoraService } from '../../bitacora/bitacora.service';
import { ACCIONES_BITACORA } from '../../bitacora/bitacora.acciones';
import { InventarioBussnies } from './inventario.bussnies';
import { ALMACEN_ARCHIVOS } from '../../util/storage/almacen.interface';
import type { AlmacenArchivos } from '../../util/storage/almacen.interface';
import type { UsuarioToken } from '../../guards/usuario-actual.decorator';
import { CodigoError, cuerpoError } from '../../util/errores-operativos';
import { almacenamientoConfig } from '../../config/almacenamiento.config';
import { esRucValido } from '../../sunat/nucleo/documentos-identidad';

/** 409 de la guía repetida (8.4): el front lo reconoce por este código. */
export const CODIGO_GUIA_REPETIDA = 'RECEPCION_GUIA_REPETIDA';

/** Lo que la respuesta de la recepción informa de una guía ya registrada (solo se añade; null si no la hay). */
export interface GuiaRepetidaRespuesta {
  modo: ModoGuiaRepetida;
  recepcion_previa: RecepcionConGuia;
  mensaje: string;
}

function textoGuiaRepetida(previa: RecepcionConGuia): string {
  const fecha = previa.fecha ? new Date(previa.fecha).toISOString().slice(0, 10) : '';
  return `La guía ${previa.nro_guia} de este proveedor ya se registró en la recepción #${previa.id_recepcion}` +
    `${fecha ? ` del ${fecha}` : ''}${previa.almacen ? ` (${previa.almacen})` : ''}. ` +
    'Si es la misma mercadería, no la vuelva a ingresar: el stock se sumaría dos veces.';
}

/** productos.precio_compra es NUMERIC(10,2). */
const PRECIO_COMPRA_MAXIMO = 99_999_999.99;

@Injectable()
export class RecepcionBussnies {
  constructor(
    private readonly repo: RecepcionRepository,
    private readonly inventario: InventarioBussnies,
    @Inject(ALMACEN_ARCHIVOS) private readonly archivos: AlmacenArchivos,
    /** Fase 8.4: modo de la guía repetida (`avisar` por defecto). Sin él, `avisar`. */
    @Optional() private readonly controlStock?: ControlStockService,
    @Optional() private readonly bitacora?: BitacoraService,
  ) {}

  // ── Proveedores ──────────────────────────────────────────────

  listarProveedores() {
    return this.repo.listarProveedores();
  }

  /**
   * El RUC es opcional, pero si viene informado tiene que ser válido (dígito verificador).
   * Al EDITAR (`idEditado`) solo se rechaza si el RUC cambió respecto del guardado: un proveedor
   * con un RUC antiguo mal digitado que nadie tocó se puede seguir editando (teléfono, correo…).
   */
  private async exigirRucSiViene(ruc: unknown, idEditado?: number): Promise<void> {
    const texto = String(ruc ?? '').trim();
    if (!texto || esRucValido(texto)) return;
    if (idEditado !== undefined) {
      const actual = await this.repo.obtenerProveedor(idEditado);
      if (!actual) throw new NotFoundException('Proveedor no encontrado');
      if (String(actual.ruc ?? '').trim() === texto) return;
    }
    throw new BadRequestException('RUC no válido');
  }

  async crearProveedor(body: any) {
    const nombre = (body?.nombre ?? '').trim();
    if (!nombre) throw new BadRequestException('El nombre del proveedor es obligatorio');
    await this.exigirRucSiViene(body?.ruc);
    const datos = {
      nombre,
      ruc: body?.ruc,
      telefono: body?.telefono,
      email: body?.email,
      direccion: body?.direccion,
    };
    const ruc = String(body?.ruc ?? '').trim();
    if (!ruc) return this.repo.crearProveedor(datos);
    // Fase 9.5: con candado por RUC, comprobar que no exista otro y crear en la misma transacción.
    return this.conRucUnico(() => this.repo.conCandadoProveedorRuc(ruc, async (manager) => {
      await this.exigirRucNoRepetido(ruc, undefined, manager);
      return this.repo.crearProveedor(datos, manager);
    }));
  }

  async actualizarProveedor(id: number, body: any) {
    const nombre = (body?.nombre ?? '').trim();
    if (!nombre) throw new BadRequestException('El nombre del proveedor es obligatorio');
    await this.exigirRucSiViene(body?.ruc, id);
    const datos = {
      nombre,
      ruc: body?.ruc,
      telefono: body?.telefono,
      email: body?.email,
      direccion: body?.direccion,
    };
    const ruc = String(body?.ruc ?? '').trim();
    // Fase 9.5: solo se comprueba si el RUC cambia. Editar sin tocarlo (o vaciarlo) nunca se bloquea.
    let cambiaRuc = false;
    if (ruc) {
      const actual = await this.repo.obtenerProveedor(id);
      if (!actual) throw new NotFoundException('Proveedor no encontrado');
      cambiaRuc = String(actual.ruc ?? '').trim() !== ruc;
    }
    const actualizado = cambiaRuc
      ? await this.conRucUnico(() => this.repo.conCandadoProveedorRuc(ruc, async (manager) => {
          await this.exigirRucNoRepetido(ruc, id, manager);
          return this.repo.actualizarProveedor(id, datos, manager);
        }))
      : await this.repo.actualizarProveedor(id, datos);
    if (!actualizado) throw new NotFoundException('Proveedor no encontrado');
    return actualizado;
  }

  /** Fase 9.5: 409 `PROVEEDOR_RUC_REPETIDO` con el nombre del proveedor que ya tiene ese RUC. */
  private async exigirRucNoRepetido(ruc: string, excluirId: number | undefined, manager: any): Promise<void> {
    const otro = await this.repo.proveedorConRuc(ruc, excluirId, manager);
    if (!otro) return;
    throw new ConflictException({
      ...cuerpoError(
        CodigoError.PROVEEDOR_RUC_REPETIDO,
        `Ya existe un proveedor con el RUC ${ruc}: «${otro.nombre || `proveedor ${otro.id_proveedor}`}». Use ese proveedor o corrija el RUC.`,
      ),
      proveedor_existente: { id_proveedor: Number(otro.id_proveedor), nombre: otro.nombre },
    });
  }

  /** Con el índice único activo (9.2), la carrera que pase el candado responde igual: 409, no 500. */
  private async conRucUnico<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error: any) {
      if (String(error?.code ?? error?.driverError?.code ?? '') === '23505') {
        throw new ConflictException(cuerpoError(CodigoError.PROVEEDOR_RUC_REPETIDO, 'Ya existe un proveedor con ese RUC.'));
      }
      throw error;
    }
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

  /**
   * Fase 8.4: ¿esa guía de ese proveedor ya se recibió? Para que el front avise ANTES de confirmar.
   * `modo` dice qué hará la confirmación (`avisar` solo informa; `bloquear` responde 409 salvo confirmación).
   */
  async guiaRepetida(idProveedor: number, nroGuia: string) {
    const modo = (await this.controlStock?.modoGuiaRepetida()) ?? 'avisar';
    const previa = await this.repo.recepcionConGuia(idProveedor, nroGuia);
    return {
      repetida: previa !== null,
      modo,
      recepcion_previa: previa,
      mensaje: previa ? textoGuiaRepetida(previa) : null,
    };
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

    // Fase 8.4: guía ya registrada del mismo proveedor. Se mira dentro de la transacción (con candado por
    // guía) y después de reconocer un reintento idempotente, que no es una guía repetida.
    const modoGuia: ModoGuiaRepetida = (await this.controlStock?.modoGuiaRepetida()) ?? 'avisar';
    const confirmarRepetida = body?.confirmar_guia_repetida === true;
    // (`as`: se asigna dentro del callback y TypeScript no lo ve; sin él lo daría por null para siempre).
    let previa = null as RecepcionConGuia | null;

    let registrada: RecepcionRegistrada;
    try {
      registrada = await this.repo.registrarRecepcion(
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
            }, {
              // Fase 8.1: el movimiento guarda la recepción y quién la confirmó.
              id_usuario: usuario?.id_usuario ?? null,
              tipo_documento: 'recepcion',
              id_documento: creada.id_recepcion,
            });
          }
          for (const item of items) {
            if (item.precio_compra != null) {
              await this.repo.actualizarPrecioCompra(manager, item.id_producto, item.precio_compra);
            }
          }
        },
        async (manager) => {
          previa = await this.repo.recepcionConGuia(idProveedor, nroGuia, manager);
          if (previa && modoGuia === 'bloquear' && !confirmarRepetida) throw this.guiaRepetidaConflicto(previa);
        },
      );
    } catch (error: any) {
      // Con el índice opcional de fase21 activo, la guía repetida no entra nunca (ni confirmada).
      const restriccion = String(error?.constraint ?? error?.driverError?.constraint ?? '');
      if (String(error?.code ?? error?.driverError?.code ?? '') === '23505' && restriccion === INDICE_GUIA_UNICA) {
        const anterior = await this.repo.recepcionConGuia(idProveedor, nroGuia);
        throw new ConflictException({
          codigo: CODIGO_GUIA_REPETIDA,
          recepcion_previa: anterior,
          confirmable: false,
          message: `${anterior ? textoGuiaRepetida(anterior) : `La guía ${nroGuia} de este proveedor ya está registrada.`} ` +
            'La base de datos no admite guías repetidas del mismo proveedor.',
        });
      }
      throw error;
    }

    const guiaRepetida: GuiaRepetidaRespuesta | null =
      previa && !registrada.repetida
        ? { modo: modoGuia, recepcion_previa: previa, mensaje: textoGuiaRepetida(previa) }
        : null;
    if (guiaRepetida) {
      await this.bitacora?.registrarCon(() => ({
        accion: ACCIONES_BITACORA.RECEPCION_GUIA_REPETIDA,
        id_usuario: usuario?.id_usuario ?? null,
        rol: usuario?.rol ?? null,
        id_almacen: idAlmacen,
        entidad: 'recepcion',
        id_entidad: registrada.id_recepcion,
        antes: { id_recepcion: guiaRepetida.recepcion_previa.id_recepcion },
        despues: { nro_guia: nroGuia, id_proveedor: idProveedor, modo: modoGuia, confirmada: confirmarRepetida },
      }));
    }

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
      // Fase 8.4 (solo se añade): la guía ya estaba registrada (en `avisar`, o confirmada en `bloquear`).
      guia_repetida: guiaRepetida,
    };
  }

  /** 409 de la guía repetida en modo `bloquear`: el front puede reenviar con `confirmar_guia_repetida: true`. */
  private guiaRepetidaConflicto(previa: RecepcionConGuia): ConflictException {
    return new ConflictException({
      codigo: CODIGO_GUIA_REPETIDA,
      recepcion_previa: previa,
      confirmable: true,
      message: `${textoGuiaRepetida(previa)} Si de verdad es otra entrega, confirme que la guía se repite.`,
    });
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
        }, {
          // Fase 8.1: el movimiento guarda la observación aprobada y quién dio el visto bueno.
          id_usuario: usuario?.id_usuario ?? null,
          tipo_documento: 'observacion_recepcion',
          id_documento: id,
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

    // Lista cerrada (la misma de las fotos de producto): un `image/svg+xml` con
    // script, servido desde /archivos en el dominio de la API, ejecutaría JS.
    const mime = (archivo.mimetype || '').toLowerCase();
    if (!almacenamientoConfig.tiposPermitidos.includes(mime)) {
      throw new BadRequestException('Solo se permiten imágenes JPG, PNG, WebP, AVIF o GIF');
    }

    const subida = await this.archivos.guardar({
      buffer: archivo.buffer,
      nombre_original: archivo.originalname,
      // Se guarda el tipo ya validado, no el texto declarado por el cliente.
      mime,
      carpeta: `recepcion/${idObservacion}`,
    });

    return this.repo.agregarAdjunto(idObservacion, subida.url, subida.mime);
  }
}

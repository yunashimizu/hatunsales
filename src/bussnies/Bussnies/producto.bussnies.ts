import {
  BadRequestException, ConflictException, HttpException, Injectable, InternalServerErrorException, Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, DeepPartial, EntityManager } from 'typeorm';
import { Producto } from '../../models/DBModel/producto.entity';
import { ProductoRepository, FilaProducto, FilaProductoSinCodigoSunat } from '../../repository/Repository/producto.repository';
import { InventarioRepository } from '../../repository/Repository/inventario.repository';
import { CrearProductoRequest, ActualizarProductoRequest } from '../../models/model/producto.request';
import { ProductoResponse } from '../../models/model/producto.response';
import { IProductoBussniees } from '../Ibussnies/IProductoBussniees';
import { InventarioBussnies, traducirErrorStock } from './inventario.bussnies';
import { ALIAS_UNIDADES, normalizarUnidad } from '../../sunat/catalogos/sunat.catalogos';
import { GRUPOS_UNIDADES, UNIDADES_AMIGABLES } from '../../sunat/catalogos/unidades-amigables';
import type { UnidadAmigable } from '../../sunat/catalogos/unidades-amigables';
import { ean13Interno } from '../../util/codigo-barras.util';

/** Código de producto SUNAT (catálogo 25, UNSPSC): exactamente 8 dígitos. */
const PATRON_CODIGO_SUNAT = /^\d{8}$/;
const MSJ_CODIGO_SUNAT = 'El código de producto SUNAT debe tener exactamente 8 dígitos (catálogo 25, UNSPSC).';

/** Resultado de la carga masiva de códigos SUNAT: lo que no se pudo asignar no aborta el resto. */
export interface ResultadoAsignacionCodigosSunat {
  actualizados: number;
  rechazados: Array<{ id_producto: number; motivo: string }>;
}

/** Intentos máximos al buscar un código interno que no exista ya en productos. */
const MAX_INTENTOS_CODIGO_INTERNO = 5;

@Injectable()
export class ProductoBussnies implements IProductoBussniees {

  private readonly logger = new Logger(ProductoBussnies.name);

  constructor(
    private readonly repo: ProductoRepository,
    private readonly inventarioRepo: InventarioRepository,
    @InjectDataSource('pgConnection')
    private readonly dataSource: DataSource,
    // Para el ajuste de stock dentro del mismo PUT de edición (misma etiqueta de kardex que
    // POST /inventario/ajuste). No hay ciclo: InventarioBussnies depende del repositorio.
    private readonly inventarioBussnies: InventarioBussnies,
  ) {}

  async getAll(): Promise<ProductoResponse[]> {
    const lista = await this.repo.listarDetallado();
    return lista.map((p) => this.mapFila(p));
  }

  async getById(id: number): Promise<ProductoResponse> {
    const producto = await this.repo.detallePorId(id);
    if (!producto) throw new NotFoundException(`Producto ${id} no encontrado`);
    return this.mapFila(producto);
  }

  /**
   * Alta de producto con su stock inicial en UNA transacción: si el stock no
   * se puede registrar, tampoco queda el producto a medias (antes quedaba
   * creado sin stock y el panel mostraba "No se pudo guardar", con lo que al
   * reintentar se duplicaba).
   */
  async create(dto: CrearProductoRequest): Promise<ProductoResponse> {
    const unidadMedida = this.unidadValidada(dto.unidad_medida);
    const codigoSunat = this.normalizarCodigoSunat(dto.codigo_sunat);
    await this.verificarUnicidad(dto.codigo_barras, dto.sku);

    const idAlmacen = dto.id_almacen ? Number(dto.id_almacen) : undefined;
    if (idAlmacen && !(await this.inventarioRepo.existeAlmacen(idAlmacen))) {
      throw new BadRequestException(`El almacén ${idAlmacen} no existe`);
    }

    // Stock inicial opcional: vive en `inventario`, no en `productos`.
    const stockInicial = dto.stock !== undefined && dto.stock !== null
      ? Math.max(0, Math.trunc(Number(dto.stock) || 0))
      : null;

    let idProducto: number;
    try {
      idProducto = await this.dataSource.transaction(async (manager) => {
        const productos = manager.getRepository(Producto);
        const producto = await productos.save(productos.create({
          nombre: dto.nombre?.trim(),
          descripcion: dto.descripcion ?? '',
          descripcion_corta: dto.descripcion_corta ?? '',
          codigo_barras: dto.codigo_barras?.trim() ?? '',
          sku: dto.sku?.trim() ?? '',
          slug: this.generarSlug(dto.nombre),
          precio_compra: dto.precio_compra ?? 0,
          precio_venta: dto.precio_venta ?? 0,
          descuento: dto.descuento ?? 0,
          unidad_medida: unidadMedida,
          codigo_sunat: codigoSunat ?? null,
          estado: dto.estado ?? true,
          destacado: dto.destacado ?? false,
          categoria: dto.id_categoria
            ? ({ id_categoria: dto.id_categoria } as any)
            : null,
          marca: dto.id_marca ? ({ id_marca: dto.id_marca } as any) : null,
        } as DeepPartial<Producto>));

        if (stockInicial !== null) {
          await this.registrarStockInicial(manager, producto.id_producto, stockInicial, idAlmacen);
        }
        return producto.id_producto;
      });
    } catch (error) {
      throw this.traducirErrorBd(error, 'No se pudo crear el producto');
    }

    return this.getById(idProducto);
  }

  /**
   * Fila de inventario del producto recién dado de alta. Con cantidad, entra
   * como movimiento «Stock inicial» para que el kardex cuadre con el stock.
   */
  private async registrarStockInicial(
    manager: EntityManager,
    idProducto: number,
    stock: number,
    idAlmacen?: number,
  ): Promise<void> {
    let almacenId = idAlmacen ? Number(idAlmacen) : 0;

    if (!almacenId) {
      const almacenes = await this.inventarioRepo.almacenes();
      almacenId = almacenes[0]?.id_almacen ? Number(almacenes[0].id_almacen) : 0;
    }

    if (!almacenId) {
      this.logger.warn(
        `Producto ${idProducto} creado sin fila de inventario: no hay almacén configurado`,
      );
      return;
    }

    if (stock > 0) {
      await this.inventarioRepo.ajustar(
        idProducto, almacenId, stock, 'Stock inicial · Alta de producto', manager,
      );
    } else {
      // El producto nació en esta misma transacción: no puede tener fila todavía.
      await this.inventarioRepo.insertarFilaVacia(manager, idProducto, almacenId);
    }
  }

  /** Errores de PostgreSQL / stock → respuesta 4xx con un motivo legible. */
  private traducirErrorBd(error: any, porDefecto: string): Error {
    if (error instanceof HttpException) return error;

    const codigo = String(error?.code ?? error?.driverError?.code ?? '');
    const mensaje = String(error?.message ?? '');

    if (codigo === '23505') {
      return new ConflictException('Ya existe un producto con ese código de barras o SKU');
    }
    if (codigo === '22001') {
      return new BadRequestException('Uno de los textos es demasiado largo (el nombre admite hasta 150 caracteres)');
    }
    if (codigo === '22003') {
      return new BadRequestException('Uno de los montos o cantidades es demasiado grande. Revise precios, descuento y stock.');
    }
    if (mensaje.startsWith('STOCK_')) {
      return new BadRequestException(traducirErrorStock(mensaje) || porDefecto);
    }

    this.logger.error(`${porDefecto}: ${mensaje}`);
    return error instanceof Error ? error : new Error(porDefecto);
  }

  /**
   * Edición parcial. Sin leer el producto antes: el UPDATE dice si existía (`affected`), y el
   * detalle se lee una sola vez al final. Con `ajuste_stock`, el UPDATE y el ajuste del stock van
   * en UNA transacción: el ajuste solo se aplica si el stock real sigue siendo el que vio la
   * ficha (si no, 409 `STOCK_DESACTUALIZADO` y no queda nada escrito, ni siquiera el producto).
   */
  async update(dto: ActualizarProductoRequest, id: number): Promise<ProductoResponse> {
    // Validaciones sin base de datos primero: un 400 no debe costar viajes.
    const codigoSunat = this.normalizarCodigoSunat(dto.codigo_sunat);
    const cambios = this.cambiosDeEdicion(dto, codigoSunat);
    await this.verificarUnicidad(dto.codigo_barras, dto.sku, id);

    const hayCambios = Object.keys(cambios).length > 0;
    const ajuste = dto.ajuste_stock;

    try {
      if (ajuste) {
        await this.dataSource.transaction(async (manager) => {
          if (hayCambios) {
            const resultado = await manager.getRepository(Producto).update(id, cambios as any);
            if (!((resultado?.affected ?? 0) > 0)) throw new NotFoundException(`Producto ${id} no encontrado`);
          } else {
            // Solo stock: sin UPDATE que lo diga, se comprueba que el producto exista (si no,
            // la FK de inventario respondería con un error técnico).
            const filas = await manager.query('SELECT 1 FROM productos WHERE id_producto = $1', [id]);
            if (!filas?.length) throw new NotFoundException(`Producto ${id} no encontrado`);
          }

          const stockNuevo = Math.trunc(Number(ajuste.stock_nuevo));
          const stockAnterior = Math.trunc(Number(ajuste.stock_anterior));
          const diferencia = stockNuevo - stockAnterior;
          if (diferencia !== 0) {
            await this.inventarioBussnies.ajustarEnTransaccion(manager, {
              id_producto: id,
              id_almacen: Number(ajuste.id_almacen),
              cantidad: diferencia,
              motivo: 'correccion',
              comentario: 'Ajuste de stock desde edición de producto',
              stock_esperado: stockAnterior,
            });
          }
        });
      } else if (hayCambios) {
        if (!(await this.repo.actualizarSiExiste(id, cambios as any))) {
          throw new NotFoundException(`Producto ${id} no encontrado`);
        }
      }
    } catch (error) {
      throw this.traducirErrorBd(error, 'No se pudo actualizar el producto');
    }

    // Sin cambios ni ajuste, esta lectura es también la que responde 404 si no existe.
    return this.getById(id);
  }

  /**
   * Solo se tocan los campos que llegaron: así una edición parcial desde el panel no borra
   * datos que ese formulario no muestra.
   */
  private cambiosDeEdicion(dto: ActualizarProductoRequest, codigoSunat: string | null | undefined): Record<string, any> {
    const cambios: Record<string, any> = {
      nombre: dto.nombre?.trim(),
      descripcion: dto.descripcion,
      descripcion_corta: dto.descripcion_corta,
      codigo_barras: dto.codigo_barras?.trim(),
      sku: dto.sku?.trim(),
      precio_compra: dto.precio_compra,
      precio_venta: dto.precio_venta,
      descuento: dto.descuento,
      // undefined = «no tocar»; si llega algo, se valida igual que en el alta.
      unidad_medida: dto.unidad_medida === undefined ? undefined : this.unidadValidada(dto.unidad_medida),
      // undefined = «no tocar»; null = vaciar el código.
      codigo_sunat: codigoSunat,
      estado: dto.estado,
      destacado: dto.destacado,
    };

    if (dto.nombre?.trim()) cambios['slug'] = this.generarSlug(dto.nombre);

    if (dto.id_categoria !== undefined) {
      cambios['categoria'] = dto.id_categoria
        ? ({ id_categoria: dto.id_categoria } as any)
        : null;
    }
    if (dto.id_marca !== undefined) {
      cambios['marca'] = dto.id_marca ? ({ id_marca: dto.id_marca } as any) : null;
    }

    Object.keys(cambios).forEach((clave) => {
      if (cambios[clave] === undefined) delete cambios[clave];
    });
    return cambios;
  }

  /** Catálogo de unidades para el selector: grupos, unidades visibles y sinónimos aceptados. */
  unidadesMedida(): { grupos: string[]; unidades: UnidadAmigable[]; alias: Record<string, string> } {
    return {
      grupos: [...GRUPOS_UNIDADES],
      unidades: UNIDADES_AMIGABLES.filter((u) => u.visible),
      alias: { ...ALIAS_UNIDADES },
    };
  }

  /**
   * Unidad que se guarda en el producto: siempre un código del catálogo 03 de SUNAT.
   * Vacía → NIU; sinónimo (UND, kg, Plancha) → su código; desconocida → 400, porque
   * caer a NIU en silencio guardaría una unidad que el usuario no eligió.
   */
  private unidadValidada(valor: string | null | undefined): string {
    if (valor === undefined || valor === null || String(valor).trim() === '') return 'NIU';
    const { codigo, advertencia } = normalizarUnidad(valor);
    if (advertencia) {
      throw new BadRequestException(
        `Unidad de medida no válida: «${String(valor).trim()}». Elija una de la lista.`,
      );
    }
    return codigo;
  }

  /**
   * Código de producto SUNAT que se guarda: `undefined` → no tocar (edición parcial);
   * vacío o solo espacios → `null` (quitarlo); otro texto → 8 dígitos exactos o 400.
   */
  normalizarCodigoSunat(valor: unknown): string | null | undefined {
    if (valor === undefined) return undefined;
    if (valor === null) return null;
    const texto = String(valor).replace(/\s+/g, '');
    if (texto === '') return null;
    if (!PATRON_CODIGO_SUNAT.test(texto)) throw new BadRequestException(MSJ_CODIGO_SUNAT);
    return texto;
  }

  /** Productos activos sin código SUNAT (tarjeta de carga del panel). */
  async productosSinCodigoSunat(limite?: number): Promise<{ total: number; datos: FilaProductoSinCodigoSunat[] }> {
    return this.repo.listarSinCodigoSunat(limite);
  }

  /**
   * Carga masiva: agrupa por código y hace un UPDATE por código. Un id inexistente o un código
   * inválido no aborta el resto: se informa en `rechazados`. Si un id llega varias veces, vale la última.
   */
  async asignarCodigosSunat(
    asignaciones: Array<{ id_producto: number; codigo_sunat: string }>,
  ): Promise<ResultadoAsignacionCodigosSunat> {
    const rechazados: ResultadoAsignacionCodigosSunat['rechazados'] = [];
    const porProducto = new Map<number, string>();

    for (const a of asignaciones ?? []) {
      const id = Number(a?.id_producto);
      const codigo = String(a?.codigo_sunat ?? '').replace(/\s+/g, '');
      if (!Number.isInteger(id) || id <= 0) {
        rechazados.push({ id_producto: id, motivo: 'Identificador de producto no válido' });
      } else if (!PATRON_CODIGO_SUNAT.test(codigo)) {
        rechazados.push({ id_producto: id, motivo: MSJ_CODIGO_SUNAT });
      } else {
        porProducto.set(id, codigo);
      }
    }

    const porCodigo = new Map<string, number[]>();
    for (const [id, codigo] of porProducto) {
      porCodigo.set(codigo, [...(porCodigo.get(codigo) ?? []), id]);
    }

    let actualizados = 0;
    for (const [codigo, ids] of porCodigo) {
      let hechos: number[];
      try {
        hechos = await this.repo.asignarCodigoSunat(ids, codigo);
      } catch (error) {
        throw this.traducirErrorBd(error, 'No se pudo asignar el código SUNAT');
      }
      const encontrados = new Set(hechos.map(Number));
      actualizados += encontrados.size;
      for (const id of ids) {
        if (!encontrados.has(id)) rechazados.push({ id_producto: id, motivo: 'El producto no existe' });
      }
    }

    return { actualizados, rechazados };
  }

  /** Borrado directo: `affected` dice si existía (antes se leía el producto primero). */
  async delete(id: number): Promise<number> {
    let borrados: number;
    try {
      borrados = await this.repo.delete(id);
    } catch (error: any) {
      // 23503: tiene ventas, inventario, kardex u otros registros que lo referencian.
      if (String(error?.code ?? error?.driverError?.code ?? '') === '23503') {
        throw new ConflictException(
          'No se puede eliminar: el producto tiene ventas, stock o movimientos registrados. Desactívelo en su lugar.',
        );
      }
      throw error;
    }
    if (!borrados) throw new NotFoundException(`Producto ${id} no encontrado`);
    return borrados;
  }

  async buscarPorCodigoBarras(codigo_barras: string): Promise<ProductoResponse> {
    const producto = await this.repo.buscarPorCodigoBarras(codigo_barras);
    if (!producto) throw new NotFoundException(`Código de barras ${codigo_barras} no encontrado`);
    return this.getById(producto.id_producto);
  }

  /**
   * Genera un código EAN-13 interno («2» + secuencia + verificador) que no exista ya como barras ni SKU
   * de algún producto. Reintenta con el siguiente número hasta MAX_INTENTOS_CODIGO_INTERNO veces.
   */
  async generarCodigoInterno(): Promise<{ codigo: string }> {
    for (let intento = 0; intento < MAX_INTENTOS_CODIGO_INTERNO; intento++) {
      let numero: number;
      try {
        numero = await this.repo.siguienteCodigoInterno();
      } catch (error: any) {
        const codigo = String(error?.code ?? error?.driverError?.code ?? '');
        if (codigo === '42P01') {
          throw new InternalServerErrorException('Falta correr sql/codigo_interno_secuencia.sql');
        }
        throw error;
      }
      let candidato: string;
      try {
        candidato = ean13Interno(numero);
      } catch {
        throw new InternalServerErrorException('La secuencia de códigos internos agotó los 11 dígitos');
      }
      if (!(await this.repo.buscarPorCodigoBarras(candidato))) return { codigo: candidato };
    }
    throw new InternalServerErrorException('No se pudo generar un código interno libre; intente de nuevo');
  }

  // ── Auxiliares ───────────────────────────────────────────────

  /**
   * Barras y SKU deben ser únicos entre sí y entre ellos: el lector busca por barras y cae a SKU,
   * así que un código no puede ser barras de un producto y SKU de otro. La carrera entre dos altas
   * simultáneas la cubre el índice único (`traducirErrorBd` traduce el 23505).
   *
   * Una sola consulta (`buscarChoquesDeCodigos`, por índice) y la decisión en memoria, con la
   * misma prioridad y los mismos textos que cuando eran hasta cuatro consultas seguidas:
   *   1. barras = barras de otro (exacto tras trim);
   *   2. barras = SKU de otro (sin distinguir mayúsculas, como la caída a SKU del lector);
   *   3. SKU = SKU de otro (exacto, como el `findOne({ sku })` de antes);
   *   4. SKU = barras de otro (sin distinguir mayúsculas).
   */
  private async verificarUnicidad(codigoBarras?: string, sku?: string, idActual?: number): Promise<void> {
    const codigo = codigoBarras?.trim();
    const codigoInterno = sku?.trim();
    const codigos = [codigo, codigoInterno].filter((c): c is string => !!c);
    if (!codigos.length) return;

    const otros = (await this.repo.buscarChoquesDeCodigos(codigos))
      .filter((p) => Number(p.id_producto) !== Number(idActual))
      .sort((a, b) => Number(a.id_producto) - Number(b.id_producto));
    if (!otros.length) return;

    const barrasDe = (p: { codigo_barras: string | null }) => (p.codigo_barras ?? '').trim();
    const skuDe = (p: { sku: string | null }) => (p.sku ?? '').trim();

    if (codigo) {
      const porBarras = otros.find((p) => barrasDe(p) === codigo);
      if (porBarras) {
        throw new ConflictException(`Ya existe un producto con ese código de barras${this.nombreDe(porBarras)}`);
      }
      const porSku = otros.find((p) => skuDe(p) !== '' && skuDe(p).toLowerCase() === codigo.toLowerCase());
      if (porSku) {
        throw new ConflictException(`Ese código de barras ya es el SKU de otro producto${this.nombreDe(porSku)}`);
      }
    }

    if (codigoInterno) {
      const porSku = otros.find((p) => skuDe(p) === codigoInterno);
      if (porSku) {
        throw new ConflictException(`Ya existe un producto con ese SKU${this.nombreDe(porSku)}`);
      }
      const porBarras = otros.find(
        (p) => barrasDe(p) !== '' && barrasDe(p).toLowerCase() === codigoInterno.toLowerCase(),
      );
      if (porBarras) {
        throw new ConflictException(`Ese SKU ya es el código de barras de otro producto${this.nombreDe(porBarras)}`);
      }
    }
  }

  private nombreDe(producto: { nombre?: string | null }): string {
    return producto.nombre ? ` (${producto.nombre})` : '';
  }

  private generarSlug(nombre?: string): string {
    return (nombre ?? '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 120);
  }

  private mapFila(p: FilaProducto): ProductoResponse {
    return {
      id_producto: p.id_producto,
      nombre: p.nombre ?? '',
      descripcion: p.descripcion ?? '',
      descripcion_corta: p.descripcion_corta ?? '',
      codigo_barras: p.codigo_barras ?? '',
      sku: p.sku ?? '',
      precio_compra: Number(p.precio_compra ?? 0),
      precio_venta: Number(p.precio_venta ?? 0),
      descuento: Number(p.descuento ?? 0),
      unidad_medida: p.unidad_medida ?? '',
      codigo_sunat: p.codigo_sunat ?? null,
      id_categoria: p.id_categoria ?? undefined,
      categoria: p.categoria ?? '',
      id_marca: p.id_marca ?? undefined,
      marca: p.marca ?? '',
      estado: p.estado ?? true,
      destacado: p.destacado ?? false,
      imagen_url: p.imagen_url ?? '',
      thumb_url: p.thumb_url ?? p.imagen_url ?? '',
      total_imagenes: Number(p.total_imagenes ?? 0),
      stock_total: Number(p.stock_total ?? 0),
      creado_en: p.creado_en,
    };
  }
}

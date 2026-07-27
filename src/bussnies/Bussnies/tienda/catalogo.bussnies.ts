import { Injectable, NotFoundException } from '@nestjs/common';
import { CatalogoRepository, FiltrosCatalogo } from '../../../repository/Repository/tienda/catalogo.repository';
import { CatalogoQueryRequest } from '../../../models/model/tienda/catalogo.request';
import {
  CategoriaTiendaResponse,
  FiltrosDisponiblesResponse,
  MarcaTiendaResponse,
  PaginaResponse,
  ProductoDetalleResponse,
  ProductoTiendaResponse,
} from '../../../models/model/tienda/catalogo.response';

const LIMITE_POR_DEFECTO = 12;
const LIMITE_MAXIMO = 60;

@Injectable()
export class CatalogoBussnies {

  constructor(private readonly repo: CatalogoRepository) {}

  async listar(query: CatalogoQueryRequest): Promise<PaginaResponse<ProductoTiendaResponse>> {
    const filtros = this.normalizarFiltros(query);
    const { rows, total } = await this.repo.buscar(filtros);

    return {
      items: rows.map((row) => this.mapProducto(row)),
      total,
      pagina: filtros.pagina,
      limite: filtros.limite,
      total_paginas: Math.max(1, Math.ceil(total / filtros.limite)),
    };
  }

  async destacados(limite = 8): Promise<ProductoTiendaResponse[]> {
    const { rows } = await this.repo.buscar({
      solo_destacado: true,
      orden: 'relevancia',
      pagina: 1,
      limite,
    });

    // Si nadie marcó productos como destacados, mostramos los más recientes
    // para que la portada nunca se vea vacía.
    if (rows.length === 0) {
      const recientes = await this.repo.buscar({ orden: 'nuevo', pagina: 1, limite });
      return recientes.rows.map((row) => this.mapProducto(row));
    }

    return rows.map((row) => this.mapProducto(row));
  }

  async ofertas(limite = 8): Promise<ProductoTiendaResponse[]> {
    const { rows } = await this.repo.buscar({
      solo_oferta: true,
      orden: 'relevancia',
      pagina: 1,
      limite,
    });
    return rows.map((row) => this.mapProducto(row));
  }

  async detalle(id: number): Promise<ProductoDetalleResponse> {
    const producto = await this.repo.obtenerPorId(id);
    if (!producto) throw new NotFoundException(`Producto ${id} no encontrado`);
    return this.armarDetalle(producto);
  }

  async detallePorSlug(slug: string): Promise<ProductoDetalleResponse> {
    const producto = await this.repo.obtenerPorSlug(slug);
    if (!producto) throw new NotFoundException(`Producto "${slug}" no encontrado`);
    return this.armarDetalle(producto);
  }

  async categorias(): Promise<CategoriaTiendaResponse[]> {
    const filas = await this.repo.obtenerCategorias();
    return filas.map((c) => ({
      id_categoria: Number(c.id_categoria),
      nombre: c.nombre ?? '',
      slug: c.slug ?? undefined,
      descripcion: c.descripcion ?? undefined,
      icono: c.icono ?? undefined,
      imagen_url: c.imagen_url ?? undefined,
      total_productos: Number(c.total_productos ?? 0),
    }));
  }

  async marcas(): Promise<MarcaTiendaResponse[]> {
    const filas = await this.repo.obtenerMarcas();
    return filas.map((m) => ({
      id_marca: Number(m.id_marca),
      nombre: m.nombre ?? '',
      slug: m.slug ?? undefined,
      logo_url: m.logo_url ?? undefined,
      total_productos: Number(m.total_productos ?? 0),
    }));
  }

  async filtros(idCategoria?: number): Promise<FiltrosDisponiblesResponse> {
    const [categorias, marcas, rango, atributos] = await Promise.all([
      this.categorias(),
      this.marcas(),
      this.repo.obtenerRangoPrecios(),
      this.repo.obtenerAtributosFiltrables(idCategoria),
    ]);

    const agrupados = new Map<string, { valor: string; total: number }[]>();
    for (const fila of atributos) {
      const lista = agrupados.get(fila.nombre) ?? [];
      lista.push({ valor: fila.valor, total: Number(fila.total ?? 0) });
      agrupados.set(fila.nombre, lista);
    }

    return {
      categorias,
      marcas,
      precio_min: Math.floor(rango.min),
      precio_max: Math.ceil(rango.max),
      atributos: [...agrupados.entries()].map(([nombre, valores]) => ({ nombre, valores })),
    };
  }

  async banners(): Promise<any[]> {
    return this.repo.obtenerBanners();
  }

  async buscarRapido(texto: string, limite = 8): Promise<ProductoTiendaResponse[]> {
    if (!texto || texto.trim().length < 2) return [];
    const { rows } = await this.repo.buscar({ q: texto.trim(), pagina: 1, limite });
    return rows.map((row) => this.mapProducto(row));
  }

  // -------------------------------------------------------------- privados

  private async armarDetalle(producto: any): Promise<ProductoDetalleResponse> {
    const id = Number(producto.id_producto);

    const [imagenes, especificaciones, stockSucursales, relacionados] = await Promise.all([
      this.repo.obtenerImagenes(id),
      this.repo.obtenerEspecificaciones(id),
      this.repo.obtenerStockPorSucursal(id),
      this.repo.obtenerRelacionados(id, producto.id_categoria ? Number(producto.id_categoria) : null, 4),
    ]);

    return {
      ...this.mapProducto(producto),
      imagenes: imagenes.map((img) => ({
        id_imagen: Number(img.id_imagen),
        url: img.url,
        thumb_url: img.thumb_url ?? undefined,
        is_primary: Boolean(img.is_primary),
      })),
      especificaciones: especificaciones.map((e) => ({ nombre: e.nombre, valor: e.valor })),
      stock_sucursales: stockSucursales.map((s) => ({
        id_sucursal: Number(s.id_sucursal),
        sucursal: s.sucursal ?? '',
        direccion: s.direccion ?? undefined,
        stock: Number(s.stock ?? 0),
      })),
      relacionados: relacionados.map((r) => this.mapProducto(r)),
    };
  }

  private normalizarFiltros(query: CatalogoQueryRequest): FiltrosCatalogo {
    const limite = Math.min(Number(query.limite ?? LIMITE_POR_DEFECTO), LIMITE_MAXIMO);

    return {
      q: query.q?.trim() || undefined,
      id_categoria: query.id_categoria ? Number(query.id_categoria) : undefined,
      id_marca: query.id_marca ? Number(query.id_marca) : undefined,
      precio_min: query.precio_min !== undefined ? Number(query.precio_min) : undefined,
      precio_max: query.precio_max !== undefined ? Number(query.precio_max) : undefined,
      solo_stock: query.solo_stock === '1' || String(query.solo_stock) === 'true',
      solo_oferta: query.solo_oferta === '1' || String(query.solo_oferta) === 'true',
      solo_destacado: query.solo_destacado === '1' || String(query.solo_destacado) === 'true',
      atributos: this.parsearAtributos(query.atributos),
      orden: query.orden,
      pagina: Math.max(1, Number(query.pagina ?? 1)),
      limite: Math.max(1, limite),
    };
  }

  /** Convierte "Voltaje:220V,Material:Acero" en pares nombre/valor. */
  private parsearAtributos(texto?: string): { nombre: string; valor: string }[] {
    if (!texto) return [];

    return texto
      .split(',')
      .map((par) => par.split(':'))
      .filter((partes) => partes.length === 2 && partes[0].trim() && partes[1].trim())
      .map(([nombre, valor]) => ({ nombre: nombre.trim(), valor: valor.trim() }));
  }

  private mapProducto(row: any): ProductoTiendaResponse {
    const stock = Number(row.stock ?? 0);

    return {
      id_producto: Number(row.id_producto),
      nombre: row.nombre ?? '',
      slug: row.slug ?? undefined,
      descripcion: row.descripcion ?? undefined,
      descripcion_corta: row.descripcion_corta ?? undefined,
      sku: row.sku ?? undefined,
      codigo_barras: row.codigo_barras ?? undefined,
      precio: Number(row.precio_venta ?? 0),
      precio_final: Number(row.precio_final ?? row.precio_venta ?? 0),
      descuento: Number(row.descuento ?? 0),
      unidad_medida: row.unidad_medida ?? undefined,
      destacado: Boolean(row.destacado),
      id_categoria: row.id_categoria ? Number(row.id_categoria) : undefined,
      categoria: row.categoria ?? undefined,
      id_marca: row.id_marca ? Number(row.id_marca) : undefined,
      marca: row.marca ?? undefined,
      stock,
      disponible: stock > 0,
      rating: Number(row.rating ?? 0),
      total_resenas: Number(row.total_resenas ?? 0),
      imagen: row.imagen_principal ?? null,
    };
  }
}

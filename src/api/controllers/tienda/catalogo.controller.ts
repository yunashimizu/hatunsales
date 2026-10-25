import { Controller, Get, Header, Param, Query } from '@nestjs/common';
import { CatalogoBussnies } from '../../../bussnies/Bussnies/tienda/catalogo.bussnies';
import { CuentaTiendaBussnies } from '../../../bussnies/Bussnies/tienda/cuenta.bussnies';
import { CatalogoQueryRequest } from '../../../models/model/tienda/catalogo.request';
import { IdEnteroPipe } from '../../../util/http/pipes/id-entero.pipe';

/**
 * Categorías, marcas y banners no llevan stock ni precios: el navegador puede
 * guardarlos un minuto y ahorrarse el viaje al volver a la portada.
 */
const CACHE_LISTAS_PUBLICAS = 'public, max-age=60';

/** Número opcional de la URL: ausente = sin filtro; si llega, tiene que ser un id válido. */
function idOpcional(valor: string | undefined, nombre: string): number | undefined {
  if (valor === undefined || valor === '') return undefined;
  return new IdEnteroPipe().transform(valor, { type: 'query', data: nombre });
}

/** `limite` de la URL tal cual llegó; el servicio lo valida y lo topa. */
function limitePedido(valor: string | undefined): number | undefined {
  return valor === undefined ? undefined : Number(valor);
}

/**
 * Catálogo público de la tienda. No requiere autenticación: cualquier visitante
 * puede navegar productos, categorías y marcas. Nunca expone `precio_compra`.
 * Los ids se validan antes de llegar a la BD (un id que no es número es un 400).
 */
@Controller('tienda')
export class CatalogoController {

  constructor(
    private readonly service: CatalogoBussnies,
    private readonly cuenta: CuentaTiendaBussnies,
  ) {}

  @Get('productos')
  listarProductos(@Query() query: CatalogoQueryRequest) {
    return this.service.listar(query);
  }

  @Get('productos/destacados')
  destacados(@Query('limite') limite?: string) {
    return this.service.destacados(limitePedido(limite));
  }

  @Get('productos/ofertas')
  ofertas(@Query('limite') limite?: string) {
    return this.service.ofertas(limitePedido(limite));
  }

  @Get('productos/buscar')
  buscar(@Query('q') q: unknown, @Query('limite') limite?: string) {
    return this.service.buscarRapido(q, limitePedido(limite));
  }

  @Get('productos/slug/:slug')
  detallePorSlug(@Param('slug') slug: string) {
    return this.service.detallePorSlug(slug);
  }

  @Get('productos/:id')
  detalle(@Param('id', IdEnteroPipe) id: number) {
    return this.service.detalle(id);
  }

  @Get('productos/:id/resenas')
  resenas(@Param('id', IdEnteroPipe) id: number) {
    return this.cuenta.listarResenas(id);
  }

  @Get('categorias')
  @Header('Cache-Control', CACHE_LISTAS_PUBLICAS)
  categorias() {
    return this.service.categorias();
  }

  @Get('marcas')
  @Header('Cache-Control', CACHE_LISTAS_PUBLICAS)
  marcas() {
    return this.service.marcas();
  }

  @Get('filtros')
  filtros(@Query('id_categoria') idCategoria?: string) {
    return this.service.filtros(idOpcional(idCategoria, 'id_categoria'));
  }

  @Get('banners')
  @Header('Cache-Control', CACHE_LISTAS_PUBLICAS)
  banners() {
    return this.service.banners();
  }
}

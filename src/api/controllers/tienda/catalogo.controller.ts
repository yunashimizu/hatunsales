import { Controller, Get, Param, Query } from '@nestjs/common';
import { CatalogoBussnies } from '../../../bussnies/Bussnies/tienda/catalogo.bussnies';
import { CuentaTiendaBussnies } from '../../../bussnies/Bussnies/tienda/cuenta.bussnies';
import { CatalogoQueryRequest } from '../../../models/model/tienda/catalogo.request';

/**
 * Catálogo público de la tienda. No requiere autenticación: cualquier visitante
 * puede navegar productos, categorías y marcas. Nunca expone `precio_compra`.
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
    return this.service.destacados(limite ? Number(limite) : 8);
  }

  @Get('productos/ofertas')
  ofertas(@Query('limite') limite?: string) {
    return this.service.ofertas(limite ? Number(limite) : 8);
  }

  @Get('productos/buscar')
  buscar(@Query('q') q: string, @Query('limite') limite?: string) {
    return this.service.buscarRapido(q, limite ? Number(limite) : 8);
  }

  @Get('productos/slug/:slug')
  detallePorSlug(@Param('slug') slug: string) {
    return this.service.detallePorSlug(slug);
  }

  @Get('productos/:id')
  detalle(@Param('id') id: string) {
    return this.service.detalle(Number(id));
  }

  @Get('productos/:id/resenas')
  resenas(@Param('id') id: string) {
    return this.cuenta.listarResenas(Number(id));
  }

  @Get('categorias')
  categorias() {
    return this.service.categorias();
  }

  @Get('marcas')
  marcas() {
    return this.service.marcas();
  }

  @Get('filtros')
  filtros(@Query('id_categoria') idCategoria?: string) {
    return this.service.filtros(idCategoria ? Number(idCategoria) : undefined);
  }

  @Get('banners')
  banners() {
    return this.service.banners();
  }
}

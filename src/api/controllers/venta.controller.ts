import { Body, Controller, Get, Header, HttpCode, Param, ParseIntPipe, Post, Query, ServiceUnavailableException, UseGuards } from '@nestjs/common';
import { VentaBussnies } from '../../bussnies/Bussnies/venta.bussnies';
import { VentaDocumentosBussnies } from '../../bussnies/Bussnies/venta-documentos.bussnies';
import { CrearVentaRequest, EmitirComprobanteVentaRequest } from '../../models/model/venta/venta.request';
import { AnularVentaRequest } from '../../models/model/venta/anular-venta.request';
import { ListarVentasRequest, ListarVentasSinComprobanteRequest } from '../../models/model/venta/listar-ventas.request';
import { JwtGuard } from '../../guards/jwt.guard';
import { RolesGuard } from '../../guards/roles.guard';
import { Roles } from '../../guards/roles.decorator';
import { UsuarioActual } from '../../guards/usuario-actual.decorator';
import type { UsuarioToken } from '../../guards/usuario-actual.decorator';

@Controller('venta')
@UseGuards(JwtGuard, RolesGuard)
@Roles('admin', 'vendedor', 'caja')
export class VentaController {

  constructor(
    private readonly service: VentaBussnies,
    private readonly documentosVenta?: VentaDocumentosBussnies,
  ) {}

  /** Autocompletado de productos del punto de venta. */
  @Get('productos')
  buscarProductos(
    @Query('q') q: string,
    @Query('limite') limite?: string,
    @Query('id_almacen') idAlmacen?: string,
  ) {
    const alm = idAlmacen ? Number(idAlmacen) : undefined;
    return this.service.buscarProductos(
      q ?? '',
      Number(limite) || 12,
      Number.isFinite(alm) && (alm as number) > 0 ? alm : undefined,
    );
  }

  /**
   * Catálogo activo para cache local del mostrador. Sin max-age (stock y precio cambian):
   * el navegador revalida cada vez con el ETag que Express calcula y, si nada cambió,
   * recibe un 304 sin cuerpo en lugar del catálogo entero (D14).
   */
  @Get('productos/catalogo')
  @Header('Cache-Control', 'private, no-cache')
  catalogoProductos(
    @Query('limite') limite?: string,
    @Query('id_almacen') idAlmacen?: string,
  ) {
    const alm = idAlmacen ? Number(idAlmacen) : undefined;
    return this.service.catalogoProductos(
      Number(limite) || 5000,
      Number.isFinite(alm) && (alm as number) > 0 ? alm : undefined,
    );
  }

  /**
   * Búsqueda por código con el código en la query (`?codigo=`): los códigos Code 39/128 pueden traer
   * `/`, `?`, `#` o `%`, que rompen la ruta. Se declara ANTES de `productos/barcode/:codigo`.
   */
  @Get('productos/barcode')
  porCodigoBarrasQuery(
    @Query('codigo') codigo?: string,
    @Query('id_almacen') idAlmacen?: string,
  ) {
    const alm = idAlmacen ? Number(idAlmacen) : undefined;
    return this.service.buscarPorCodigoBarras(
      codigo ?? '',
      Number.isFinite(alm) && (alm as number) > 0 ? alm : undefined,
    );
  }

  /** Ruta anterior (código en la URL); se conserva para clientes ya desplegados. */
  @Get('productos/barcode/:codigo')
  porCodigoBarras(
    @Param('codigo') codigo: string,
    @Query('id_almacen') idAlmacen?: string,
  ) {
    const alm = idAlmacen ? Number(idAlmacen) : undefined;
    return this.service.buscarPorCodigoBarras(
      codigo,
      Number.isFinite(alm) && (alm as number) > 0 ? alm : undefined,
    );
  }

  /** Almacenes + default para el selector de sede/caja del POS. */
  @Get('contexto-pos')
  contextoPos() {
    return this.service.contextoPos();
  }

  @Get('metodos-pago')
  metodosPago() {
    return this.service.metodosPago();
  }

  /** Devuelve el comprobante calculado sin registrar la venta. */
  @Post('preview')
  preview(@Body() body: CrearVentaRequest) {
    return this.service.previsualizar(body);
  }

  @Post()
  registrar(@Body() body: CrearVentaRequest, @UsuarioActual() usuario: UsuarioToken) {
    return this.service.registrar(body, usuario);
  }

  /**
   * Historial de ventas: cliente, documento o serie-número (texto), días de Lima, estado, con o sin
   * comprobante y origen; cada fila trae su comprobante vigente y cuántas notas y guías tiene.
   */
  @Get()
  listar(@Query() filtro: ListarVentasRequest) {
    return this.service.listar(filtro);
  }

  /** Ventas activas sin factura ni boleta vigente (pestaña «Ventas sin comprobante» de Documentos). Va antes de ':id'. */
  @Get('sin-comprobante')
  @Roles('admin', 'vendedor', 'caja')
  ventasSinComprobante(@Query() filtro: ListarVentasSinComprobanteRequest) {
    return this.negocioDocumentos().sinComprobante(filtro);
  }

  /** Comprobante, notas de crédito y guías de la venta, con lo que se puede hacer y los avisos (D10). */
  @Get(':id/documentos')
  @Roles('admin', 'vendedor', 'caja')
  documentos(@Param('id', ParseIntPipe) id: number, @UsuarioActual() usuario: UsuarioToken) {
    return this.negocioDocumentos().documentos(id, usuario);
  }

  @Get(':id')
  obtener(@Param('id') id: string) {
    return this.service.obtener(Number(id));
  }

  /** Emite la factura o boleta de una venta que quedó sin comprobante, con los montos ya cobrados. */
  @Post(':id/emitir-comprobante')
  @Roles('admin', 'vendedor', 'caja')
  @HttpCode(200)
  emitirComprobante(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: EmitirComprobanteVentaRequest,
    @UsuarioActual() usuario: UsuarioToken,
  ) {
    return this.service.emitirComprobanteDeVenta(id, body, usuario);
  }

  /**
   * Anula la venta (D9). Responde estado 'anulada' | 'anulacion_en_curso' (se emitió la nota de crédito
   * y se anula cuando SUNAT la acepte) | 'anulacion_rechazada'; 409 si hay que verificar en SUNAT.
   */
  @Post(':id/anular')
  @Roles('admin')
  @HttpCode(200)
  anular(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: AnularVentaRequest,
    @UsuarioActual() usuario: UsuarioToken,
  ) {
    return this.service.anular(id, body ?? {}, usuario);
  }

  /** Nest siempre lo inyecta; el parámetro es opcional para que las pruebas que solo usan VentaBussnies no lo armen. */
  private negocioDocumentos(): VentaDocumentosBussnies {
    if (!this.documentosVenta) {
      throw new ServiceUnavailableException('Los documentos de la venta no están disponibles en este momento. Intente de nuevo en unos minutos.');
    }
    return this.documentosVenta;
  }
}

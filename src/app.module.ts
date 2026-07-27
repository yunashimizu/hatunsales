import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { TypeOrmModule } from '@nestjs/typeorm';
import { postgresConfig, sqliteConfig } from './config/database.config';
import { Usuario } from './models/DBModel/user.entity';
import { Usuarios as UsuarioAuth } from './models/DBModel/usuarios.entity';          // ← agregar
import { VwUsuarioPermisos } from './models/DBModel/vw-usuario-permisos.entity';   // ← agregar
import { Log } from './models/DBModel/log.entity';
import { UserController } from './api/controllers/user.controller';
import { LogController } from './api/controllers/log.controller';
import { AuthController } from './api/controllers/auth.controller';
import { UserService } from './bussnies/Bussnies/user-bussnies';
import { HatunsalesRepository } from './repository/Repository/user-repository';
import { LogRepository } from './repository/Repository/log-repository';
import { AuthBussnies } from './bussnies/Bussnies/auth.bussnies';
import { JwtStrategy } from './guards/jwt.strategy';
import { JwtModule } from '@nestjs/jwt';
import { jwtConfig } from './config/jwt.config';
import { loginController } from './api/controllers/login.controller';
import { AdminController } from './api/controllers/admin.controller';
import { AdminBussnies } from './bussnies/Bussnies/admin.bussnies';
import { SunatRepository } from './repository/Repository/sunat.repository';
import { SunatBussnies } from './bussnies/Bussnies/sunat.bussnies';
import { SunatController } from './api/controllers/sunat.controller';
import { Cliente } from './models/DBModel/cliente.entity';
import { Documento } from './models/DBModel/documento.entity';
import { Empresa } from './models/DBModel/empresa.entity';
import { Proveedor } from './models/DBModel/proveedor.entity';
import { Rol } from './models/DBModel/role.entity';
import { Comprobante } from './models/DBModel/c-electronico/comprobante.entity';
import { ComprobanteItem } from './models/DBModel/c-electronico/comprobante-item.entity';
import { TipoComprobante } from './models/DBModel/c-electronico/tipos-comprobante.entity';
import { Moneda } from './models/DBModel/c-electronico/moneda.entity';
import { ComprobanteController } from './api/controllers/comprobante.controller';
import { ComprobanteRepository } from './repository/Repository/comprobante.repository';
import { ComprobanteBussnies } from './bussnies/Bussnies/comprobante.bussnies';
import { Producto } from './models/DBModel/producto.entity';
import { Inventario } from './models/DBModel/inventario.entity';
import { GuiaRemision } from './models/DBModel/guia-remision.entity';
import { GuiaRemisionItem } from './models/DBModel/guia-remision-item.entity';
import { Proforma } from './models/DBModel/proforma.entity';
import { ProformaItem } from './models/DBModel/proforma-item.entity';
import { Sucursal } from './models/DBModel/sucursal.entity';
import { StockSucursal } from './models/DBModel/stock-sucursal.entity';
import { Categoria } from './models/DBModel/categoria.entity';
import { Marca } from './models/DBModel/marca.entity';
import { ProductoImagen } from './models/DBModel/producto-imagen.entity';
import { Seccion } from './models/DBModel/seccion.entity';
import { MovimientoInventario } from './models/DBModel/movimiento-inventario.entity';
import { ProductoController } from './api/controllers/producto.controller';
import { ProductoImagenController } from './api/controllers/producto-imagen.controller';
import { InventarioController } from './api/controllers/inventario.controller';
import { GuiaRemisionController } from './api/controllers/guia-remision.controller';
import { ProformaController } from './api/controllers/proforma.controller';
import { ProductoRepository } from './repository/Repository/producto.repository';
import { InventarioRepository } from './repository/Repository/inventario.repository';
import { GuiaRemisionRepository } from './repository/Repository/guia-remision.repository';
import { ProformaRepository } from './repository/Repository/proforma.repository';
import { ReportesRepository } from './repository/Repository/reportes.repository';
import { SucursalRepository } from './repository/Repository/sucursal.repository';
import { ProductoImagenRepository } from './repository/Repository/producto-imagen.repository';
import { StockSucursalRepository } from './repository/Repository/stock-sucursal.repository';
import { MovimientoInventarioRepository } from './repository/Repository/movimiento-inventario.repository';
import { CategoriaRepository } from './repository/Repository/categoria.repository';
import { MarcaRepository } from './repository/Repository/marca.repository';
import { ProductoBussnies } from './bussnies/Bussnies/producto.bussnies';
import { InventarioBussnies } from './bussnies/Bussnies/inventario.bussnies';
import { GuiaRemisionBussnies } from './bussnies/Bussnies/guia-remision.bussnies';
import { ProformaBussnies } from './bussnies/Bussnies/proforma.bussnies';
import { ReportesBussnies } from './bussnies/Bussnies/reportes.bussnies';
import { ReportesController } from './api/controllers/reportes.controller';
import { StockSucursalBussnies } from './bussnies/Bussnies/stock-sucursal.bussnies';
import { StockSucursalController } from './api/controllers/stock-sucursal.controller';
import { ClienteController } from './api/controllers/cliente.controller';
import { ClienteBussnies } from './bussnies/Bussnies/cliente.bussnies';
import { ClienteRepository } from './repository/Repository/cliente.repository';
import { ProductoImagenBussnies } from './bussnies/Bussnies/producto-imagen.bussnies';
import { CategoriaController } from './api/controllers/categoria.controller';
import { RolController } from './api/controllers/rol.controller';
import { RolesAdminController } from './api/controllers/roles-admin.controller';
import { StorageService } from './util/storage/storage.service';

// ----------------------------------------------------------------- tienda
import { Almacen } from './models/DBModel/almacen.entity';
import { Banner } from './models/DBModel/tienda/banner.entity';
import { ProductoAtributo } from './models/DBModel/tienda/producto-atributo.entity';
import { DireccionEnvio } from './models/DBModel/tienda/direccion-envio.entity';
import { MetodoEnvio } from './models/DBModel/tienda/metodo-envio.entity';
import { MetodoPago } from './models/DBModel/tienda/metodo-pago.entity';
import { Cupon } from './models/DBModel/tienda/cupon.entity';
import { Carrito } from './models/DBModel/tienda/carrito.entity';
import { CarritoItem } from './models/DBModel/tienda/carrito-item.entity';
import { Pedido } from './models/DBModel/tienda/pedido.entity';
import { PedidoItem } from './models/DBModel/tienda/pedido-item.entity';
import { PedidoEstado } from './models/DBModel/tienda/pedido-estado.entity';
import { PedidoPago } from './models/DBModel/tienda/pedido-pago.entity';
import { Favorito } from './models/DBModel/tienda/favorito.entity';
import { Resena } from './models/DBModel/tienda/resena.entity';

import { CatalogoRepository } from './repository/Repository/tienda/catalogo.repository';
import { CarritoRepository } from './repository/Repository/tienda/carrito.repository';
import { PedidoRepository } from './repository/Repository/tienda/pedido.repository';
import { CuentaTiendaRepository } from './repository/Repository/tienda/cuenta.repository';
import { CheckoutRepository } from './repository/Repository/tienda/checkout.repository';
import { StockTiendaRepository } from './repository/Repository/tienda/stock-tienda.repository';
import { VentaTiendaRepository } from './repository/Repository/tienda/venta-tienda.repository';

import { CatalogoBussnies } from './bussnies/Bussnies/tienda/catalogo.bussnies';
import { CarritoBussnies } from './bussnies/Bussnies/tienda/carrito.bussnies';
import { PedidoBussnies } from './bussnies/Bussnies/tienda/pedido.bussnies';
import { CuentaTiendaBussnies } from './bussnies/Bussnies/tienda/cuenta.bussnies';
import { CheckoutBussnies } from './bussnies/Bussnies/tienda/checkout.bussnies';
import { PagoBussnies } from './bussnies/Bussnies/tienda/pago.bussnies';

import { CulqiPasarela } from './util/pasarela/culqi.pasarela';
import { PasarelaSimulada } from './util/pasarela/simulada.pasarela';
import { pasarelaProvider } from './util/pasarela/pasarela.provider';

import { CatalogoController } from './api/controllers/tienda/catalogo.controller';
import { CarritoController } from './api/controllers/tienda/carrito.controller';
import { CheckoutController, PagoWebhookController } from './api/controllers/tienda/checkout.controller';
import { PedidoController, PedidoAdminController } from './api/controllers/tienda/pedido.controller';
import { CuentaTiendaController } from './api/controllers/tienda/cuenta.controller';

@Module({
  imports: [
    TypeOrmModule.forRoot(postgresConfig),
    TypeOrmModule.forRoot(sqliteConfig),
    TypeOrmModule.forFeature(
      [Usuario, UsuarioAuth, VwUsuarioPermisos, Cliente, Documento, Empresa, Proveedor, Rol,
        Producto, Inventario, GuiaRemision, GuiaRemisionItem, Proforma, ProformaItem,
        Sucursal, StockSucursal, Categoria, Marca, ProductoImagen, Seccion, MovimientoInventario,
        Comprobante, ComprobanteItem, TipoComprobante, Moneda,
        Almacen, Banner, ProductoAtributo, DireccionEnvio, MetodoEnvio, MetodoPago, Cupon,
        Carrito, CarritoItem, Pedido, PedidoItem, PedidoEstado, PedidoPago, Favorito, Resena],
      'pgConnection',
    ),
    TypeOrmModule.forFeature([Log], 'sqliteConnection'),
    JwtModule.register({
      secret: jwtConfig.secret,
      signOptions: { expiresIn: '1h' },
      global: true,
    }),
  ],
  controllers: [AppController, UserController, LogController, AuthController,
  loginController, AdminController, SunatController, ComprobanteController, ClienteController,
  ProductoController, InventarioController, GuiaRemisionController, ProformaController,
  ReportesController, StockSucursalController, ProductoImagenController, CategoriaController, RolController, RolesAdminController,
  CatalogoController, CarritoController, CheckoutController, PagoWebhookController,
  PedidoController, PedidoAdminController, CuentaTiendaController],
  providers: [AppService, UserService, SunatRepository, SunatBussnies, HatunsalesRepository,
  LogRepository, AuthBussnies, AdminBussnies, JwtStrategy, ComprobanteRepository, ComprobanteBussnies,
  ClienteBussnies, ClienteRepository, ProductoRepository, ProductoBussnies,
  InventarioRepository, InventarioBussnies, GuiaRemisionRepository, GuiaRemisionBussnies,
  ProformaRepository, ProformaBussnies, ReportesRepository, ReportesBussnies,
  SucursalRepository, CategoriaRepository, MarcaRepository, ProductoImagenRepository, StockSucursalRepository,
   MovimientoInventarioRepository, StockSucursalBussnies, ProductoImagenBussnies, StorageService,
   CatalogoRepository, CarritoRepository, PedidoRepository, CuentaTiendaRepository, CheckoutRepository,
   StockTiendaRepository, VentaTiendaRepository,
   CatalogoBussnies, CarritoBussnies, PedidoBussnies, CuentaTiendaBussnies, CheckoutBussnies, PagoBussnies,
   CulqiPasarela, PasarelaSimulada, pasarelaProvider],
})
export class AppModule {}
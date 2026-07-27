import { TypeOrmModuleOptions } from '@nestjs/typeorm';
import { Usuario } from '../models/DBModel/user.entity';
import { Usuarios } from '../models/DBModel/usuarios.entity';           // ← agregar
import { VwUsuarioPermisos } from '../models/DBModel/vw-usuario-permisos.entity'; // ← agregar
import { Rol } from '../models/DBModel/role.entity';                   // ← agregar
import { Permiso } from '../models/DBModel/permiso.entity';            // ← agregar
import { Log } from '../models/DBModel/log.entity';
import { Cliente } from 'src/models/DBModel/cliente.entity';
import { Documento } from 'src/models/DBModel/documento.entity';
import { Empresa } from 'src/models/DBModel/empresa.entity';
import { Proveedor } from 'src/models/DBModel/proveedor.entity';
import { Comprobante } from 'src/models/DBModel/c-electronico/comprobante.entity';
import { ComprobanteItem } from 'src/models/DBModel/c-electronico/comprobante-item.entity';
import { TipoComprobante } from 'src/models/DBModel/c-electronico/tipos-comprobante.entity';
import { Moneda } from 'src/models/DBModel/c-electronico/moneda.entity';
import { Producto } from '../models/DBModel/producto.entity';
import { Inventario } from '../models/DBModel/inventario.entity';
import { GuiaRemision } from '../models/DBModel/guia-remision.entity';
import { GuiaRemisionItem } from '../models/DBModel/guia-remision-item.entity';
import { Proforma } from '../models/DBModel/proforma.entity';
import { ProformaItem } from '../models/DBModel/proforma-item.entity';
import { Sucursal } from '../models/DBModel/sucursal.entity';
import { StockSucursal } from '../models/DBModel/stock-sucursal.entity';
import { Categoria } from '../models/DBModel/categoria.entity';
import { Marca } from '../models/DBModel/marca.entity';
import { ProductoImagen } from '../models/DBModel/producto-imagen.entity';
import { Seccion } from '../models/DBModel/seccion.entity';
import { Almacen } from '../models/DBModel/almacen.entity';
import { Banner } from '../models/DBModel/tienda/banner.entity';
import { ProductoAtributo } from '../models/DBModel/tienda/producto-atributo.entity';
import { DireccionEnvio } from '../models/DBModel/tienda/direccion-envio.entity';
import { MetodoEnvio } from '../models/DBModel/tienda/metodo-envio.entity';
import { MetodoPago } from '../models/DBModel/tienda/metodo-pago.entity';
import { Cupon } from '../models/DBModel/tienda/cupon.entity';
import { Carrito } from '../models/DBModel/tienda/carrito.entity';
import { CarritoItem } from '../models/DBModel/tienda/carrito-item.entity';
import { Pedido } from '../models/DBModel/tienda/pedido.entity';
import { PedidoItem } from '../models/DBModel/tienda/pedido-item.entity';
import { PedidoEstado } from '../models/DBModel/tienda/pedido-estado.entity';
import { PedidoPago } from '../models/DBModel/tienda/pedido-pago.entity';
import { Favorito } from '../models/DBModel/tienda/favorito.entity';
import { Resena } from '../models/DBModel/tienda/resena.entity';

export const postgresConfig: TypeOrmModuleOptions = {
  name: 'pgConnection',
  type: 'postgres',
  host: 'sakura.proxy.rlwy.net',
  port: 23642,
  username: 'postgres',
  password: 'bhIIAPOxvaOpaKxjVgyJgyNEAeRKuotI',
  database: 'railway',
  entities: [Usuario, Usuarios, VwUsuarioPermisos, Rol, Permiso, Cliente, Documento, Empresa, Proveedor,
    Producto, Inventario, GuiaRemision, GuiaRemisionItem, Proforma, ProformaItem,
    Sucursal, StockSucursal, Categoria, Marca, ProductoImagen, Seccion, Almacen,
    Comprobante, ComprobanteItem, TipoComprobante, Moneda,
    // Módulo tienda
    Banner, ProductoAtributo, DireccionEnvio, MetodoEnvio, MetodoPago, Cupon,
    Carrito, CarritoItem, Pedido, PedidoItem, PedidoEstado, PedidoPago, Favorito, Resena,
  ],
  synchronize: false,
};

export const sqliteConfig: TypeOrmModuleOptions = {
  name: 'sqliteConnection',
  type: 'better-sqlite3',
  database: 'logs.sqlite',
  entities: [Log],
  synchronize: true,
};
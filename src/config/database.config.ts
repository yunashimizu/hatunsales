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

export const postgresConfig: TypeOrmModuleOptions = {
  /*
  name: 'pgConnection',
  type: 'postgres',
  host: 'localhost',
  port: 5432,
  username: 'postgres',
  password: 'forgeNova',
  database: 'hatunsales_db',
  */
  name: 'pgConnection',
  type: 'postgres',
  url: process.env.DATABASE_URL,
  autoLoadEntities: true,
  entities: [Usuario, Usuarios, VwUsuarioPermisos, Rol, Permiso, Cliente, Documento, Empresa, Proveedor,
    Producto, Inventario, GuiaRemision, GuiaRemisionItem, Proforma, ProformaItem,
    Sucursal, StockSucursal, Categoria, Marca, ProductoImagen, Seccion,
    Comprobante, ComprobanteItem, TipoComprobante, Moneda,
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
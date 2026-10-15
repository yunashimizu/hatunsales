import { TypeOrmModuleOptions } from '@nestjs/typeorm';
import { Usuario } from '../models/DBModel/user.entity';
import { Usuarios } from '../models/DBModel/usuarios.entity';
import { VwUsuarioPermisos } from '../models/DBModel/vw-usuario-permisos.entity';
import { Rol } from '../models/DBModel/role.entity';
import { Permiso } from '../models/DBModel/permiso.entity';
import { Cliente } from '../models/DBModel/cliente.entity';
import { Documento } from '../models/DBModel/documento.entity';
import { Empresa } from '../models/DBModel/empresa.entity';
import { Proveedor } from '../models/DBModel/proveedor.entity';
import { Comprobante } from '../models/DBModel/c-electronico/comprobante.entity';
import { ComprobanteItem } from '../models/DBModel/c-electronico/comprobante-item.entity';
import { TipoComprobante } from '../models/DBModel/c-electronico/tipos-comprobante.entity';
import { Moneda } from '../models/DBModel/c-electronico/moneda.entity';
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
import { MovimientoInventario } from '../models/DBModel/movimiento-inventario.entity';
import { CuentaPorCobrar } from '../models/DBModel/cuenta-por-cobrar.entity';
import { AbonoCredito } from '../models/DBModel/abono-credito.entity';
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
import { RegistroTypeorm } from './registro-typeorm';
import { booleanoEntorno, numeroEntorno, versionDespliegue } from './runtime.config';

/**
 * Entidades de 'pgConnection'. Además, con `autoLoadEntities` TypeORM carga
 * todas las que se registren con `TypeOrmModule.forFeature([...], 'pgConnection')`
 * (incluidas las de REGISTROS en src/registro), así que un dominio nuevo no
 * necesita tocar esta lista. MovimientoInventario, CuentaPorCobrar y
 * AbonoCredito se listan explícitamente porque /stock y crédito las usan
 * fuera de forFeature y antes daban EntityMetadataNotFoundError.
 */
const postgresEntities = [
  Usuario, Usuarios, VwUsuarioPermisos, Rol, Permiso, Cliente, Documento, Empresa, Proveedor,
  Producto, Inventario, GuiaRemision, GuiaRemisionItem, Proforma, ProformaItem,
  Sucursal, StockSucursal, Categoria, Marca, ProductoImagen, Seccion, Almacen,
  MovimientoInventario, CuentaPorCobrar, AbonoCredito,
  Comprobante, ComprobanteItem, TipoComprobante, Moneda,
  Banner, ProductoAtributo, DireccionEnvio, MetodoEnvio, MetodoPago, Cupon,
  Carrito, CarritoItem, Pedido, PedidoItem, PedidoEstado, PedidoPago, Favorito, Resena,
];

/** Nombre visible en pg_stat_activity: distingue la instancia vieja de la nueva durante un deploy. */
export function nombreAplicacionBd(): string {
  const version = versionDespliegue();
  return version === 'local' ? 'hatunsales-api' : `hatunsales-api@${version}`;
}

/**
 * Opciones del pool de node-postgres (van en `extra`). Sin ellas el pool espera
 * para siempre cuando se agota y no hay statement_timeout: una consulta o una
 * transacción colgada retiene sus bloqueos sin límite.
 */
export function opcionesPoolPostgres(): Record<string, unknown> {
  const statementTimeout = numeroEntorno('DB_STATEMENT_TIMEOUT_MS', 60_000, { min: 1_000, max: 600_000 });
  const lockTimeout = numeroEntorno('DB_LOCK_TIMEOUT_MS', 0, { min: 0, max: 600_000 });
  return {
    max: Math.floor(numeroEntorno('DB_POOL_MAX', 15, { min: 1, max: 100 })),
    idleTimeoutMillis: numeroEntorno('DB_IDLE_MS', 60_000, { min: 1_000, max: 3_600_000 }),
    connectionTimeoutMillis: numeroEntorno('DB_CONNECT_TIMEOUT_MS', 10_000, { min: 1_000, max: 120_000 }),
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
    // Corte en el servidor (cancela la consulta y libera bloqueos)…
    statement_timeout: statementTimeout,
    // …y, por si la red se cuelga, corte en el cliente un poco después.
    query_timeout: statementTimeout + 5_000,
    idle_in_transaction_session_timeout: numeroEntorno('DB_IDLE_TX_TIMEOUT_MS', 60_000, { min: 1_000, max: 3_600_000 }),
    ...(lockTimeout > 0 ? { lock_timeout: lockTimeout } : {}),
    application_name: nombreAplicacionBd(),
  };
}

type OpcionSsl = false | { rejectUnauthorized: boolean } | undefined;

/**
 * TLS: con DATABASE_URL se usa siempre (proxy público de Railway) salvo DB_SSL=false.
 * Con PG* y sin DB_SSL se deja como antes (undefined: node-postgres mira PGSSLMODE).
 */
function opcionesSsl(conUrl: boolean): OpcionSsl {
  if (!process.env.DB_SSL?.trim()) return conUrl ? { rejectUnauthorized: false } : undefined;
  return booleanoEntorno('DB_SSL', conUrl) ? { rejectUnauthorized: false } : false;
}

function opcionesComunes() {
  return {
    name: 'pgConnection',
    type: 'postgres' as const,
    entities: postgresEntities,
    // Carga también las entidades registradas con forFeature (incluye REGISTROS de app.module.ts)
    autoLoadEntities: true,
    synchronize: false,
    logging: ['error', 'warn'] as ('error' | 'warn')[],
    logger: new RegistroTypeorm(),
    maxQueryExecutionTime: numeroEntorno('DB_SLOW_MS', 1_000, { min: 50, max: 600_000 }),
    extra: opcionesPoolPostgres(),
  };
}

function postgresDesdeEnv(): TypeOrmModuleOptions {
  const databaseUrl = process.env.DATABASE_URL?.trim();

  if (databaseUrl) {
    return { ...opcionesComunes(), url: databaseUrl, ssl: opcionesSsl(true) };
  }

  return {
    ...opcionesComunes(),
    host: process.env.PGHOST ?? 'localhost',
    port: Number(process.env.PGPORT ?? 5432),
    username: process.env.PGUSER ?? 'postgres',
    password: process.env.PGPASSWORD ?? '',
    database: process.env.PGDATABASE ?? 'railway',
    ssl: opcionesSsl(false),
  };
}

/** True si hay URL completa o host + password para conectar. */
export function postgresConfigurado(): boolean {
  if (process.env.DATABASE_URL?.trim()) return true;
  const host = process.env.PGHOST?.trim();
  const password = process.env.PGPASSWORD?.trim();
  return Boolean(host && password);
}

export const postgresConfig: TypeOrmModuleOptions = postgresDesdeEnv();

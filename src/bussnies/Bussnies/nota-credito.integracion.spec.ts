import { ConflictException, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { EsquemaCajaService } from '../../caja/esquema/esquema-caja.service';
import { Comprobante } from '../../models/DBModel/c-electronico/comprobante.entity';
import { ComprobanteItem } from '../../models/DBModel/c-electronico/comprobante-item.entity';
import { Moneda } from '../../models/DBModel/c-electronico/moneda.entity';
import { TipoComprobante } from '../../models/DBModel/c-electronico/tipos-comprobante.entity';
import { Cliente } from '../../models/DBModel/cliente.entity';
import { Documento } from '../../models/DBModel/documento.entity';
import { Rol } from '../../models/DBModel/role.entity';
import { Usuarios } from '../../models/DBModel/usuarios.entity';
import { ComprobanteRepository } from '../../repository/Repository/comprobante.repository';
import { NotaCreditoRepository } from '../../repository/Repository/nota-credito.repository';
import { VentaRepository } from '../../repository/Repository/venta.repository';
import { OyentesEnvioFiscal } from '../../sunat/emision/emision.contrato';
import type { DocumentoPreparado, EventoEnvioCompletado, ResultadoEmision } from '../../sunat/emision/emision.contrato';
import type { DocumentoCpe } from '../../sunat/nucleo/documento-fiscal.types';
import { calcularComprobante } from '../../util/fiscal/calculo-fiscal';
import { CODIGO_RECARGO_TARJETA, DESCRIPCION_RECARGO_TARJETA, UNIDAD_RECARGO_TARJETA } from '../../util/precios/recargo-tarjeta';
import { EfectosNotasTarea } from '../tareas/efectos-notas.tarea';
import { ComprobanteBussnies } from './comprobante.bussnies';
import { NotaCreditoBussnies } from './nota-credito.bussnies';

/**
 * Integración con PostgreSQL REAL (PLAN V3, D8/D9). Se salta sin HS_PG_PRUEBAS_URL, así `npm test` no la
 * necesita. Con la variable apuntando a una COPIA de la base de pruebas con fase12 y fase14 aplicadas
 * (nunca Railway) usa los repositorios reales, el motor de comprobantes real (ComprobanteBussnies) y una
 * emisión simulada que guarda el envío como lo haría la real pero no llama a SUNAT.
 */
const URL = process.env.HS_PG_PRUEBAS_URL;
const describirConBd = URL ? describe : describe.skip;

const PRODUCTO_A = 1;
const PRODUCTO_B = 2;
const ALMACEN = 1;
const USUARIO = 1;

const SERIES = { factura: 'F001', boleta: 'B001', nc_factura: 'FC01', nc_boleta: 'BC01', nd_factura: 'FD01', nd_boleta: 'BD01' };
const EMISOR = {
  ruc: '20610206337',
  razonSocial: 'HATUNSALES S.A.C.',
  direccion: 'AV. PRUEBA 123',
  ubigeo: '150101',
  distrito: 'LIMA',
  provincia: 'LIMA',
  departamento: 'LIMA',
};

const MENSAJE_RECHAZO = '2800 - El dato ingresado en el tipo de documento de identidad del receptor no esta permitido.';

interface LineaOrigen {
  id_producto: number | null;
  codigo: string;
  descripcion: string;
  unidad: string;
  cantidad: number;
  precio: number;
  /** 1 gravado (por defecto), 8 exonerado, 9 inafecto. */
  tipo_de_igv?: number;
}

describirConBd('Notas de crédito y anulación contra PostgreSQL real (HS_PG_PRUEBAS_URL)', () => {
  let ds: DataSource;
  let ventas: VentaRepository;
  let negocio: NotaCreditoBussnies;
  let oyentes: OyentesEnvioFiscal;
  let siguienteNumeroOrigen = 0;
  /** Qué responde SUNAT (simulada) al enviar: la real guarda el resultado y avisa a los oyentes igual. */
  let alEnviar: 'pendiente' | 'aceptar' | 'rechazar' = 'pendiente';

  /** Emisión simulada: guarda envío y estado igual que EmisionDirecta, sin red. */
  const emision = {
    modo: jest.fn(async () => ({ activo: true as const, ambiente: 'produccion' as const })),
    contexto: jest.fn(async () => ({ ambiente: 'produccion', emisor: EMISOR, series: SERIES, aviso: null, correlativo_inicial: {} })),
    prepararDocumento: jest.fn(async (documento: DocumentoCpe): Promise<DocumentoPreparado> => ({
      ambiente: 'produccion',
      documento,
      material: {} as never,
      preparado: {
        nombreBase: `${EMISOR.ruc}-${documento.tipo}-${documento.serie}-${documento.numero}`,
        cadenaQr: `${EMISOR.ruc}|${documento.tipo}|${documento.serie}|${documento.numero}`,
        digestValue: 'digest-prueba',
      } as never,
    })),
    registrarEnvio: jest.fn(async (tx: { query: (sql: string, p?: unknown[]) => Promise<any> }, preparado: DocumentoPreparado, idComprobante: number, idUsuario: number | null) => {
      const doc = preparado.documento;
      const filas = await tx.query(
        `INSERT INTO fiscal_envios (id_comprobante, tipo_documento, ambiente, proveedor, operacion, estado, intento, identificador, bloqueado_hasta, id_usuario)
         VALUES ($1, $2, 'produccion', 'sunat_directo', 'emitir', 'ENVIANDO', 1, $3, NOW() + INTERVAL '60 seconds', $4)
         RETURNING id_envio`,
        [idComprobante, doc.tipo, `${EMISOR.ruc}-${doc.tipo}-${doc.serie}-${doc.numero}`, idUsuario],
      );
      const idEnvio = Number(filas[0].id_envio);
      await tx.query(`UPDATE comprobantes SET estado_sunat = 'ENVIANDO', id_envio_ultimo = $2 WHERE id_comprobante = $1`, [idComprobante, idEnvio]);
      return idEnvio;
    }),
    enviarRegistrado: jest.fn(async (idEnvio: number): Promise<ResultadoEmision> => {
      const filas = await ds.query('SELECT id_comprobante FROM fiscal_envios WHERE id_envio = $1', [idEnvio]);
      const idComprobante = Number(filas[0].id_comprobante);
      if (alEnviar === 'aceptar') {
        await marcarAceptado(idComprobante, idEnvio);
        return resultado(idEnvio, idComprobante, true);
      }
      if (alEnviar === 'rechazar') {
        // Lo que guarda EnvioFiscalRepository.completar con un rechazo 2xxx: comprobante en error, sin efectos.
        await ds.query(`UPDATE fiscal_envios SET estado = 'RECHAZADO', codigo_sunat = '2800', bloqueado_hasta = NULL WHERE id_envio = $1`, [idEnvio]);
        await ds.query(
          `UPDATE comprobantes SET estado = 'error', estado_sunat = 'RECHAZADO', aceptada_sunat = FALSE, error_mensaje = $2 WHERE id_comprobante = $1`,
          [idComprobante, MENSAJE_RECHAZO],
        );
        await oyentes.notificar({ ...eventoAceptado(idComprobante, idEnvio), estado: 'RECHAZADO', aceptado: false });
        return { ...resultado(idEnvio, idComprobante, false), estado: 'RECHAZADO', codigo: '2800', mensaje: MENSAJE_RECHAZO, accion: 'EMITIR_NUEVO' };
      }
      await ds.query('UPDATE fiscal_envios SET bloqueado_hasta = NULL WHERE id_envio = $1', [idEnvio]);
      return resultado(idEnvio, idComprobante, false);
    }),
    recuperarCdr: jest.fn(),
    confirmarAceptadoManual: jest.fn(),
  };

  function resultado(idEnvio: number, idComprobante: number, aceptado: boolean): ResultadoEmision {
    return {
      ambiente: 'produccion',
      id_envio: idEnvio,
      nombre_base: `envio-${idEnvio}`,
      estado: aceptado ? 'ACEPTADO' : 'ENVIANDO',
      aceptado,
      codigo: aceptado ? '0' : null,
      mensaje: aceptado ? 'La Nota de Crédito ha sido aceptada' : null,
      observaciones: [],
      digest: 'digest-prueba',
      cadena_qr: 'qr',
      archivos: ['xml_firmado', 'zip'],
      id_comprobante: idComprobante,
    };
  }

  /** Lo que hace la emisión real cuando SUNAT acepta: guarda el resultado y avisa a los oyentes. */
  async function marcarAceptado(idComprobante: number, idEnvio: number): Promise<void> {
    await ds.query(`UPDATE fiscal_envios SET estado = 'ACEPTADO', bloqueado_hasta = NULL WHERE id_envio = $1`, [idEnvio]);
    await ds.query(
      `UPDATE comprobantes SET estado = 'emitido', estado_sunat = 'ACEPTADO', aceptada_sunat = TRUE, emitido_en = NOW() WHERE id_comprobante = $1`,
      [idComprobante],
    );
    await oyentes.notificar(eventoAceptado(idComprobante, idEnvio));
  }

  function eventoAceptado(idComprobante: number, idEnvio: number): EventoEnvioCompletado {
    return { id_envio: idEnvio, id_comprobante: idComprobante, ambiente: 'produccion', tipo_documento: '07', estado: 'ACEPTADO', aceptado: true, origen: 'envio' };
  }

  async function aceptarNota(idNota: number): Promise<void> {
    const filas = await ds.query('SELECT id_envio_ultimo FROM comprobantes WHERE id_comprobante = $1', [idNota]);
    await marcarAceptado(idNota, Number(filas[0].id_envio_ultimo));
  }

  async function stock(idProducto: number): Promise<number> {
    const filas = await ds.query('SELECT stock FROM inventario WHERE id_producto = $1 AND id_almacen = $2', [idProducto, ALMACEN]);
    return Number(filas[0].stock);
  }

  /** Venta real (VentaRepository.registrar): descuenta stock del almacén y deja venta_stock_salida. */
  async function venta(lineas: { id_producto: number; cantidad: number; precio: number }[], credito?: { id_cliente: number; monto: number }): Promise<number> {
    const resumen = calcularComprobante(lineas.map((l) => ({ cantidad: l.cantidad, precio_unitario: l.precio, descuento: 0 })));
    const registrada = await ventas.registrar(
      {
        id_cliente: credito?.id_cliente,
        subtotal: resumen.total_gravada,
        igv: resumen.total_igv,
        descuento: 0,
        total: resumen.total,
        origen: 'mostrador',
        ...(credito ? { credito: { monto: credito.monto, dias: 15, id_cliente: credito.id_cliente } } : {}),
      },
      lineas.map((l, i) => ({
        id_producto: l.id_producto,
        descripcion: `Producto ${l.id_producto}`,
        cantidad: l.cantidad,
        precio_unitario: l.precio,
        descuento: 0,
        subtotal: resumen.lineas[i].subtotal,
        igv: resumen.lineas[i].igv,
        total: resumen.lineas[i].total,
        precio_lista_unitario: l.precio,
        descuento_unitario_aplicado: 0,
        descuento_total_linea: 0,
        precio_unitario_final: l.precio,
        id_regla_mayorista: null,
      })),
      credito
        ? [{ id_metodo: 10, monto: credito.monto }, ...(resumen.total > credito.monto ? [{ id_metodo: 1, monto: resumen.total - credito.monto }] : [])]
        : [{ id_metodo: 1, monto: resumen.total }],
      { descontarStock: true, idAlmacenPreferido: ALMACEN },
    );
    return registrada.id_venta;
  }

  /** Factura de producción para la venta como la dejaría la emisión real: aceptada por SUNAT (o rechazada). */
  async function facturaAceptada(idVenta: number, lineas: LineaOrigen[], opciones: { rechazada?: boolean } = {}): Promise<{ id: number; items: number[] }> {
    const resumen = calcularComprobante(
      lineas.map((l) => ({ cantidad: l.cantidad, precio_unitario: l.precio, descuento: 0, tipo_de_igv: l.tipo_de_igv ?? 1 })),
    );
    const rechazada = opciones.rechazada === true;
    siguienteNumeroOrigen += 1;
    const filas = await ds.query(
      `INSERT INTO comprobantes
         (id_venta, id_tipo, id_moneda, serie, numero, cliente_tipo_doc, cliente_numero_doc, cliente_denominacion,
          fecha_de_emision, fecha_de_vencimiento, porcentaje_igv, total_gravada, total_exonerada, total_inafecta,
          total_descuento, total_igv, total, estado, aceptada_sunat, estado_sunat, proveedor_fiscal, ambiente_fiscal,
          anulado, creado_en)
       VALUES ($1, 1, 1, 'F001', $2, 6, '20123456789', 'CLIENTE DE PRUEBA S.A.C.', '22-10-2026', '22-10-2026', 18,
               $3, $4, $5, 0, $6, $7, $8, $9, $10, 'sunat_directo', 'produccion', FALSE, NOW())
       RETURNING id_comprobante`,
      [
        idVenta, siguienteNumeroOrigen, resumen.total_gravada, resumen.total_exonerada, resumen.total_inafecta, resumen.total_igv, resumen.total,
        rechazada ? 'error' : 'emitido', !rechazada, rechazada ? 'RECHAZADO' : 'ACEPTADO',
      ],
    );
    const id = Number(filas[0].id_comprobante);
    const items: number[] = [];
    for (const [i, l] of lineas.entries()) {
      const linea = resumen.lineas[i];
      const insertado = await ds.query(
        `INSERT INTO comprobante_items
           (id_comprobante, id_producto, unidad_de_medida, codigo, descripcion, cantidad, valor_unitario, precio_unitario,
            descuento, subtotal, tipo_de_igv, igv, total)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 0, $9, $10, $11, $12)
         RETURNING id_item`,
        [id, l.id_producto, l.unidad, l.codigo, l.descripcion, l.cantidad, linea.valor_unitario, l.precio, linea.subtotal, l.tipo_de_igv ?? 1, linea.igv, linea.total],
      );
      items.push(Number(insertado[0].id_item));
    }
    return { id, items };
  }

  /** Cuenta por cobrar de la venta (saldo y estado). */
  async function cxc(idVenta: number): Promise<{ saldo: number; estado: string }> {
    const filas = await ds.query('SELECT saldo, estado FROM cuentas_por_cobrar WHERE id_venta = $1', [idVenta]);
    return { saldo: Number(filas[0].saldo), estado: String(filas[0].estado) };
  }

  async function clienteCredito(): Promise<number> {
    const filas = await ds.query(
      `INSERT INTO clientes (nombre, credito_activo, limite_credito, dias_credito) VALUES ('CLIENTE CREDITO PRUEBA', TRUE, 1000, 15) RETURNING id_cliente`,
    );
    return Number(filas[0].id_cliente);
  }

  async function notasDe(idOrigen: number): Promise<any[]> {
    return ds.query(
      `SELECT id_comprobante, nota_motivo, total, efecto_nota, reingresar_stock, efectos_aplicados, estado_sunat
         FROM comprobantes WHERE id_comprobante_modificado = $1 ORDER BY id_comprobante`,
      [idOrigen],
    );
  }

  beforeAll(async () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    ds = new DataSource({
      type: 'postgres',
      url: URL,
      entities: [Comprobante, ComprobanteItem, TipoComprobante, Moneda, Cliente, Documento, Usuarios, Rol],
      synchronize: false,
      logging: false,
    });
    await ds.initialize();
    const columnas = await ds.query(
      `SELECT count(*)::int AS n FROM information_schema.columns
        WHERE (table_name = 'comprobantes' AND column_name IN ('efecto_nota', 'reingresar_stock', 'efectos_aplicados', 'efectos_aplicados_en'))
           OR (table_name = 'comprobante_items' AND column_name = 'id_item_origen')
           OR (table_name = 'venta_stock_salida' AND column_name = 'cantidad_devuelta')`,
    );
    if (Number(columnas[0].n) !== 6) throw new Error('La base de HS_PG_PRUEBAS_URL no tiene sql/fase14_notas_credito_enlace.sql aplicado.');

    const maximo = await ds.query(`SELECT COALESCE(MAX(numero), 0) AS n FROM comprobantes WHERE serie = 'F001'`);
    siguienteNumeroOrigen = Number(maximo[0].n);
    await ds.query('UPDATE inventario SET stock = 500 WHERE id_almacen = $1 AND id_producto = ANY($2::int[])', [ALMACEN, [PRODUCTO_A, PRODUCTO_B]]);

    const esquema = new EsquemaCajaService(ds);
    ventas = new VentaRepository(ds, esquema);
    const motor = new ComprobanteBussnies(
      new ComprobanteRepository(ds.getRepository(Comprobante)),
      {} as never,
      { obtenerTexto: async (_clave: string, defecto: string) => defecto } as never,
      emision as never,
    );
    negocio = new NotaCreditoBussnies(
      new NotaCreditoRepository(ds, esquema),
      ventas,
      motor,
      emision as never,
      { registrar: jest.fn(async () => undefined) } as never,
    );
    negocio.onModuleInit();
    oyentes = new OyentesEnvioFiscal();
    new EfectosNotasTarea(negocio, oyentes, { tareasActivas: async () => false } as never).onModuleInit();
  });

  afterAll(async () => {
    await ds?.destroy();
    jest.restoreAllMocks();
  });

  beforeEach(() => {
    alEnviar = 'pendiente';
  });

  it('venta → NC 07 parcial aceptada → anular venta: el stock vuelve exactamente al inicial y el saldo queda en cero', async () => {
    const inicialA = await stock(PRODUCTO_A);
    const inicialB = await stock(PRODUCTO_B);
    const idVenta = await venta([
      { id_producto: PRODUCTO_A, cantidad: 3, precio: 10 },
      { id_producto: PRODUCTO_B, cantidad: 2, precio: 35 },
    ]);
    expect(await stock(PRODUCTO_A)).toBe(inicialA - 3);
    expect(await stock(PRODUCTO_B)).toBe(inicialB - 2);
    const origen = await facturaAceptada(idVenta, [
      { id_producto: PRODUCTO_A, codigo: 'A-1', descripcion: 'MARTILLO', unidad: 'NIU', cantidad: 3, precio: 10 },
      { id_producto: PRODUCTO_B, codigo: 'B-1', descripcion: 'CEMENTO', unidad: 'NIU', cantidad: 2, precio: 35 },
      { id_producto: null, codigo: CODIGO_RECARGO_TARJETA, descripcion: `${DESCRIPCION_RECARGO_TARJETA} (3%)`, unidad: UNIDAD_RECARGO_TARJETA, cantidad: 1, precio: 3 },
    ]);

    const parcial = await negocio.emitir(
      origen.id,
      { motivo: '07', sustento: 'Devolución de un martillo', items: [{ id_item: origen.items[0], cantidad: 1 }] },
      USUARIO,
    );
    expect(parcial).toMatchObject({ estado: 'pendiente', efecto: 'devolucion', efectos_aplicados: false });

    // INSERT de la nota (motor de X2) con las columnas de fase14 y el ítem de origen de cada línea.
    const [nota] = await notasDe(origen.id);
    expect(nota).toMatchObject({ nota_motivo: '07', efecto_nota: 'devolucion', reingresar_stock: true, efectos_aplicados: false });
    const lineas = await ds.query('SELECT id_item_origen, cantidad, total FROM comprobante_items WHERE id_comprobante = $1 ORDER BY id_item', [nota.id_comprobante]);
    expect(lineas.map((l: any) => Number(l.id_item_origen))).toEqual([origen.items[0], origen.items[2]]);
    // 10 de 100 en productos → 10 % del recargo de 3.00.
    expect(lineas.map((l: any) => Number(l.total))).toEqual([10, 0.3]);
    expect(Number(nota.total)).toBe(10.3);
    expect(await stock(PRODUCTO_A)).toBe(inicialA - 3);

    await aceptarNota(nota.id_comprobante);
    expect(await stock(PRODUCTO_A)).toBe(inicialA - 2);
    const devuelta = await ds.query('SELECT SUM(cantidad_devuelta) AS d FROM venta_stock_salida WHERE id_venta = $1 AND id_producto = $2', [idVenta, PRODUCTO_A]);
    expect(Number(devuelta[0].d)).toBe(1);

    const anulacion = await negocio.anularVenta(idVenta, { motivo: 'El cliente desiste de la compra' }, USUARIO);
    expect(anulacion).toMatchObject({ estado: 'anulacion_en_curso', anulada: false, nota: { motivo: '07', aceptada_sunat: false } });
    expect(await stock(PRODUCTO_A)).toBe(inicialA - 2);

    await aceptarNota(anulacion.nota!.id_comprobante);
    expect(await stock(PRODUCTO_A)).toBe(inicialA);
    expect(await stock(PRODUCTO_B)).toBe(inicialB);
    const estado = await ds.query('SELECT estado FROM ventas WHERE id_venta = $1', [idVenta]);
    expect(estado[0].estado).toBe('anulada');
    const notas = await notasDe(origen.id);
    expect(notas.map((n) => n.efecto_nota)).toEqual(['devolucion', 'anular_venta']);
    expect(notas.every((n) => n.efectos_aplicados === true)).toBe(true);
    expect(notas.reduce((s, n) => s + Number(n.total), 0)).toBeCloseTo(103, 2);
    const anulado = await ds.query('SELECT anulado FROM comprobantes WHERE id_comprobante = $1', [origen.id]);
    expect(anulado[0].anulado).toBe(true);
  });

  it('anular una venta con NC 01 aceptada al instante: el stock vuelve UNA sola vez aunque se repitan el aviso, el barrido y la anulación', async () => {
    const inicial = await stock(PRODUCTO_A);
    const idVenta = await venta([{ id_producto: PRODUCTO_A, cantidad: 2, precio: 15 }]);
    const origen = await facturaAceptada(idVenta, [
      { id_producto: PRODUCTO_A, codigo: 'A-1', descripcion: 'MARTILLO', unidad: 'NIU', cantidad: 2, precio: 15 },
    ]);
    alEnviar = 'aceptar';

    const anulacion = await negocio.anularVenta(idVenta, {}, USUARIO);

    expect(anulacion).toMatchObject({ estado: 'anulada', anulada: true, nota: { motivo: '01', aceptada_sunat: true, total: 30 } });
    expect(await stock(PRODUCTO_A)).toBe(inicial);

    const idNota = anulacion.nota!.id_comprobante;
    const envio = await ds.query('SELECT id_envio_ultimo FROM comprobantes WHERE id_comprobante = $1', [idNota]);
    await oyentes.notificar(eventoAceptado(idNota, Number(envio[0].id_envio_ultimo)));
    expect(await negocio.aplicarEfectos(idNota)).toBeNull();
    expect(await negocio.anularVenta(idVenta, {}, USUARIO)).toMatchObject({ estado: 'anulada', ya_anulada: true });
    expect(await stock(PRODUCTO_A)).toBe(inicial);
  });

  it('efectos de una nota aceptada pedidos dos veces a la vez: se aplican una sola vez (y la deuda baja una vez)', async () => {
    const idCliente = await clienteCredito();
    const inicial = await stock(PRODUCTO_B);
    const idVenta = await venta([{ id_producto: PRODUCTO_B, cantidad: 4, precio: 35 }], { id_cliente: idCliente, monto: 100 });
    const origen = await facturaAceptada(idVenta, [
      { id_producto: PRODUCTO_B, codigo: 'B-1', descripcion: 'CEMENTO', unidad: 'NIU', cantidad: 4, precio: 35 },
    ]);

    const nota = await negocio.emitir(origen.id, { motivo: '06', sustento: 'Devolución total de la mercadería' }, USUARIO);
    expect(nota.estado).toBe('pendiente');
    await ds.query(`UPDATE comprobantes SET estado = 'emitido', estado_sunat = 'ACEPTADO', aceptada_sunat = TRUE WHERE id_comprobante = $1`, [nota.id_comprobante]);

    const resultados = await Promise.all([negocio.aplicarEfectos(nota.id_comprobante!), negocio.aplicarEfectos(nota.id_comprobante!)]);

    expect(resultados.filter((r) => r !== null)).toHaveLength(1);
    expect(await stock(PRODUCTO_B)).toBe(inicial);
    const cxc = await ds.query('SELECT saldo, estado FROM cuentas_por_cobrar WHERE id_venta = $1', [idVenta]);
    // La nota (S/ 140) supera la deuda (S/ 100): baja hasta cero y se cierra sin abonos → anulada.
    expect(Number(cxc[0].saldo)).toBe(0);
    expect(cxc[0].estado).toBe('anulado');
    expect(await negocio.aplicarEfectos(nota.id_comprobante!)).toBeNull();
    expect(await stock(PRODUCTO_B)).toBe(inicial);
  });

  it('dos notas simultáneas del mismo comprobante: pasa una sola y la otra responde 409', async () => {
    const idVenta = await venta([{ id_producto: PRODUCTO_A, cantidad: 2, precio: 15 }]);
    const origen = await facturaAceptada(idVenta, [
      { id_producto: PRODUCTO_A, codigo: 'A-1', descripcion: 'MARTILLO', unidad: 'NIU', cantidad: 2, precio: 15 },
    ]);
    const pedido = { motivo: '07', sustento: 'Devolución de un martillo', items: [{ id_item: origen.items[0], cantidad: 1 }] };

    const resultados = await Promise.allSettled([negocio.emitir(origen.id, pedido, USUARIO), negocio.emitir(origen.id, pedido, USUARIO)]);

    expect(resultados.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rechazo = resultados.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rechazo.reason).toBeInstanceOf(ConflictException);
    expect((rechazo.reason as ConflictException).getResponse()).toMatchObject({ codigo: 'NOTA_CREDITO_EN_CURSO' });
    expect(await notasDe(origen.id)).toHaveLength(1);
  });

  it('NC 10 por monto sobre una factura gravada + exonerada al crédito: una línea por tramo; al aceptarse baja la deuda y no mueve stock', async () => {
    const idCliente = await clienteCredito();
    const inicialA = await stock(PRODUCTO_A);
    const idVenta = await venta(
      [{ id_producto: PRODUCTO_A, cantidad: 3, precio: 10 }, { id_producto: PRODUCTO_B, cantidad: 2, precio: 35 }],
      { id_cliente: idCliente, monto: 100 },
    );
    const origen = await facturaAceptada(idVenta, [
      { id_producto: PRODUCTO_A, codigo: 'A-1', descripcion: 'MARTILLO', unidad: 'NIU', cantidad: 3, precio: 10 },
      { id_producto: PRODUCTO_B, codigo: 'B-1', descripcion: 'LIBRO TECNICO', unidad: 'NIU', cantidad: 2, precio: 35, tipo_de_igv: 8 },
    ]);
    const antes = await negocio.contexto(origen.id);
    expect(antes).toMatchObject({ permitido: true, saldo: 100, venta: { a_credito: true, saldo_cxc: 100 } });
    expect(antes.motivos.map((m) => m.codigo)).toEqual(expect.arrayContaining(['09', '10']));

    alEnviar = 'aceptar';
    const nota = await negocio.emitir(origen.id, { motivo: '10', sustento: 'Bonificación comercial acordada', monto: 10 }, USUARIO);

    expect(nota).toMatchObject({ estado: 'emitido', aceptada_sunat: true, efecto: 'ninguno', efectos_aplicados: true });
    const lineas = await ds.query(
      'SELECT id_item_origen, tipo_de_igv, codigo, unidad_de_medida, total FROM comprobante_items WHERE id_comprobante = $1 ORDER BY id_item',
      [nota.id_comprobante],
    );
    expect(lineas.map((l: any) => [l.id_item_origen, Number(l.tipo_de_igv), l.codigo, l.unidad_de_medida, Number(l.total)])).toEqual([
      [null, 1, 'AJUSTE-NC', 'ZZ', 3],
      [null, 8, 'AJUSTE-NC', 'ZZ', 7],
    ]);
    const [cabecera] = await ds.query(
      'SELECT total, total_exonerada, efecto_nota, reingresar_stock, efectos_aplicados FROM comprobantes WHERE id_comprobante = $1',
      [nota.id_comprobante],
    );
    expect(cabecera).toMatchObject({ efecto_nota: 'ninguno', reingresar_stock: false, efectos_aplicados: true });
    expect([Number(cabecera.total), Number(cabecera.total_exonerada)]).toEqual([10, 7]);
    expect(await stock(PRODUCTO_A)).toBe(inicialA - 3);
    expect(await cxc(idVenta)).toEqual({ saldo: 90, estado: 'pendiente' });

    // Lo disponible de cada línea descuenta la parte de la nota que tocó a su tramo (3 del gravado, 7 del exonerado).
    const despues = await negocio.contexto(origen.id);
    expect(despues.saldo).toBe(90);
    expect(despues.items.map((i) => i.importe_disponible)).toEqual([27, 63]);
    expect(despues.motivos.map((m) => m.codigo)).not.toContain('01');
  });

  it('NC rechazada por SUNAT: responde «error» con el motivo, queda registrada sin efectos, no resta saldo y se puede emitir otra', async () => {
    const inicial = await stock(PRODUCTO_A);
    const idVenta = await venta([{ id_producto: PRODUCTO_A, cantidad: 2, precio: 15 }]);
    const origen = await facturaAceptada(idVenta, [
      { id_producto: PRODUCTO_A, codigo: 'A-1', descripcion: 'MARTILLO', unidad: 'NIU', cantidad: 2, precio: 15 },
    ]);
    const pedido = { motivo: '07', sustento: 'Devolución de un martillo', items: [{ id_item: origen.items[0], cantidad: 1 }] };
    alEnviar = 'rechazar';

    const rechazada = await negocio.emitir(origen.id, pedido, USUARIO);

    expect(rechazada).toMatchObject({
      estado: 'error',
      aceptada_sunat: false,
      estado_sunat: 'RECHAZADO',
      sunat_responsecode: '2800',
      accion_sunat: 'EMITIR_NUEVO',
      error: MENSAJE_RECHAZO,
      efectos_aplicados: false,
    });
    expect(rechazada.avisos[0]).toContain('SUNAT no aceptó la nota');
    expect(await notasDe(origen.id)).toEqual([expect.objectContaining({ estado_sunat: 'RECHAZADO', efectos_aplicados: false })]);
    expect(await negocio.aplicarEfectos(rechazada.id_comprobante!)).toBeNull();
    expect(await stock(PRODUCTO_A)).toBe(inicial - 2);

    const contexto = await negocio.contexto(origen.id);
    expect(contexto).toMatchObject({ permitido: true, saldo: 30 });
    expect(contexto.notas_previas).toEqual([expect.objectContaining({ id: rechazada.id_comprobante, vigente: false, en_curso: false })]);
    expect(contexto.avisos.join(' ')).toContain('SUNAT rechazó la nota');

    alEnviar = 'aceptar';
    const otra = await negocio.emitir(origen.id, pedido, USUARIO);
    expect(otra).toMatchObject({ estado: 'emitido', efectos_aplicados: true });
    expect(otra.numero).toBe(Number(rechazada.numero) + 1);
    expect(await stock(PRODUCTO_A)).toBe(inicial - 1);
  });

  it('emisión inactiva: 503 con el motivo legible, sin dejar filas ni consumir número', async () => {
    const idVenta = await venta([{ id_producto: PRODUCTO_A, cantidad: 1, precio: 15 }]);
    const origen = await facturaAceptada(idVenta, [
      { id_producto: PRODUCTO_A, codigo: 'A-1', descripcion: 'MARTILLO', unidad: 'NIU', cantidad: 1, precio: 15 },
    ]);
    const serieNotas = async () =>
      (await ds.query(`SELECT count(*)::int AS n, COALESCE(MAX(numero), 0)::int AS ultimo FROM comprobantes WHERE serie = 'FC01'`))[0];
    const envios = async () => Number((await ds.query('SELECT count(*)::int AS n FROM fiscal_envios'))[0].n);
    const antes = { notas: await serieNotas(), envios: await envios() };
    emision.modo.mockResolvedValueOnce({
      activo: false,
      ambiente: 'produccion',
      codigo: 'FISCAL_EMISION_INACTIVA',
      motivo: 'La emisión electrónica de producción no está activada: la venta se registra sin comprobante. Actívela en Facturación SUNAT cuando la lista de requisitos esté completa.',
    } as never);

    const error = await negocio.emitir(origen.id, { motivo: '06', sustento: 'Devolución total' }, USUARIO).catch((e: unknown) => e);

    expect((error as { getStatus: () => number }).getStatus()).toBe(503);
    expect((error as Error).message).toBe(
      'No se emitió la nota de crédito. La emisión electrónica de producción no está activada. Actívela en Facturación SUNAT cuando la lista de requisitos esté completa.',
    );
    expect(await serieNotas()).toEqual(antes.notas);
    expect(await envios()).toBe(antes.envios);
    expect(await notasDe(origen.id)).toEqual([]);
  });

  it('anular una venta que tuvo un comprobante rechazado: al aceptarse la nota quedan anulados la venta y TODOS sus comprobantes', async () => {
    const idVenta = await venta([{ id_producto: PRODUCTO_B, cantidad: 1, precio: 35 }]);
    const linea: LineaOrigen = { id_producto: PRODUCTO_B, codigo: 'B-1', descripcion: 'CEMENTO', unidad: 'NIU', cantidad: 1, precio: 35 };
    const rechazada = await facturaAceptada(idVenta, [linea], { rechazada: true });
    const origen = await facturaAceptada(idVenta, [linea]);
    const anulados = async () =>
      (await ds.query('SELECT anulado FROM comprobantes WHERE id_comprobante = ANY($1::int[]) ORDER BY id_comprobante', [[rechazada.id, origen.id]]))
        .map((f: any) => f.anulado);

    const anulacion = await negocio.anularVenta(idVenta, { motivo: 'El cliente desiste de la compra' }, USUARIO);

    expect(anulacion.estado).toBe('anulacion_en_curso');
    expect(anulacion.avisos.join(' ')).toContain('nunca fue aceptado por SUNAT: se anulará en el sistema junto con la venta');
    expect(await anulados()).toEqual([false, false]);

    await aceptarNota(anulacion.nota!.id_comprobante);

    expect(await anulados()).toEqual([true, true]);
    expect((await ds.query('SELECT estado FROM ventas WHERE id_venta = $1', [idVenta]))[0].estado).toBe('anulada');
  });
});

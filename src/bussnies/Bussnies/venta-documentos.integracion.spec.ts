import { Logger, NotFoundException } from '@nestjs/common';
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
import type { UsuarioToken } from '../../guards/usuario-actual.decorator';
import type { VentaHistorialFila } from '../../models/model/venta/venta-documentos.response';
import { ComprobanteRepository } from '../../repository/Repository/comprobante.repository';
import { GuiaRemisionRepository } from '../../repository/Repository/guia-remision.repository';
import { NotaCreditoRepository } from '../../repository/Repository/nota-credito.repository';
import { VentaDocumentosRepository } from '../../repository/Repository/venta-documentos.repository';
import { VentaRepository } from '../../repository/Repository/venta.repository';
import { ComprobanteBussnies } from './comprobante.bussnies';
import { NotaCreditoBussnies } from './nota-credito.bussnies';
import { VentaDocumentosBussnies } from './venta-documentos.bussnies';

/**
 * Integración con PostgreSQL REAL (PLAN V3, D10). Se salta sin HS_PG_PRUEBAS_URL, así `npm test` no la
 * necesita. Con la variable apuntando a una COPIA de la base de pruebas con fase12, fase13 y fase14 aplicadas
 * (nunca Railway) verifica el SQL de los documentos de la venta, de las ventas sin comprobante y del historial
 * (filtros, días de Lima y comodines escapados) con los repositorios reales, el detalle real de Documentos
 * (ComprobanteBussnies) y el saldo real de notas (NotaCreditoBussnies). La emisión y la GRE son dobles: nada
 * sale a SUNAT. Cada corrida usa una marca propia en los nombres, así puede repetirse sobre la misma copia.
 */
const URL = process.env.HS_PG_PRUEBAS_URL;
const describirConBd = URL ? describe : describe.skip;

const ADMIN = { id_usuario: 1, rol: 'admin' } as UsuarioToken;
const VENDEDOR = { id_usuario: 1, rol: 'vendedor' } as UsuarioToken;
const EMISOR = {
  ruc: '20610206337',
  razonSocial: 'HATUNSALES S.A.C.',
  direccion: 'AV. PRUEBA 123',
  ubigeo: '150101',
  distrito: 'LIMA',
  provincia: 'LIMA',
  departamento: 'LIMA',
};
const SERIES = { factura: 'F001', boleta: 'B001', nc_factura: 'FC01', nc_boleta: 'BC01', nd_factura: 'FD01', nd_boleta: 'BD01' };
const MOTIVO_GRE = 'La GRE no tiene ambiente de pruebas en SUNAT: solo se puede validar sin enviar.';
const RECHAZO = '2800 - El dato ingresado en el tipo de documento de identidad del receptor no esta permitido.';
const EFECTIVO = 1;
const TARJETA = 3;

interface ComprobanteNuevo {
  id_venta: number;
  id_tipo: number;
  serie: string;
  total: number;
  creado_en: string;
  estado?: string;
  estado_sunat?: string | null;
  aceptada?: boolean;
  anulado?: boolean;
  motivo_anulacion?: string | null;
  error_mensaje?: string | null;
  proveedor?: string;
  ambiente?: string | null;
  nota?: { id_origen: number; serie_origen: string; numero_origen: number; motivo: string; efecto: string; efectos_aplicados: boolean };
}

describirConBd('Documentos de la venta e historial contra PostgreSQL real (HS_PG_PRUEBAS_URL)', () => {
  let ds: DataSource;
  let negocio: VentaDocumentosBussnies;
  let ventas: VentaRepository;
  let siguienteNumero = 0;
  const marca = `VPR${Date.now().toString(36).toUpperCase()}`;
  const v: Record<string, number> = {};
  const c: Record<string, { id: number; numero: number }> = {};

  const emision = {
    modo: jest.fn(async () => ({ activo: true as const, ambiente: 'produccion' as const })),
    contexto: jest.fn(async () => ({ ambiente: 'produccion', emisor: EMISOR, series: SERIES, aviso: null, correlativo_inicial: {} })),
    obtenerEnvio: jest.fn(async () => null),
  };

  async function uno(sql: string, params: unknown[] = []): Promise<any> {
    const filas = await ds.query(sql, params);
    return filas[0];
  }

  async function cliente(nombre: string, dni: number | null = null): Promise<number> {
    return Number((await uno('INSERT INTO clientes (nombre, dni) VALUES ($1, $2) RETURNING id_cliente', [nombre, dni])).id_cliente);
  }

  /** Venta con sus líneas y pagos; `fechaUtc` es la hora UTC que guarda ventas.fecha. */
  async function venta(datos: {
    fechaUtc: string;
    total: number;
    id_cliente?: number;
    id_empresa?: number;
    estado?: string;
    lineas: { id_producto: number; cantidad: number; precio: number }[];
    pagos: { id_metodo: number; monto: number }[];
  }): Promise<number> {
    const id = Number(
      (await uno(
        `INSERT INTO ventas (id_cliente, id_empresa, fecha, subtotal, igv, total, origen, estado)
         VALUES ($1, $2, $3::timestamp, $4, 0, $4, 'mostrador', $5) RETURNING id_venta`,
        [datos.id_cliente ?? null, datos.id_empresa ?? null, datos.fechaUtc, datos.total, datos.estado ?? 'activa'],
      )).id_venta,
    );
    for (const l of datos.lineas) {
      await ds.query(
        'INSERT INTO detalle_venta (id_venta, id_producto, cantidad, precio, subtotal, igv, total) VALUES ($1, $2, $3, $4, $5, 0, $5)',
        [id, l.id_producto, l.cantidad, l.precio, l.cantidad * l.precio],
      );
    }
    for (const p of datos.pagos) {
      await ds.query('INSERT INTO venta_pago (id_venta, id_metodo, monto) VALUES ($1, $2, $3)', [id, p.id_metodo, p.monto]);
    }
    return id;
  }

  async function comprobante(datos: ComprobanteNuevo): Promise<{ id: number; numero: number }> {
    siguienteNumero += 1;
    const numero = siguienteNumero;
    const nota = datos.nota;
    const fila = await uno(
      `INSERT INTO comprobantes
         (id_venta, id_tipo, id_moneda, serie, numero, cliente_tipo_doc, cliente_numero_doc, cliente_denominacion,
          fecha_de_emision, fecha_de_vencimiento, porcentaje_igv, total_gravada, total_igv, total, estado, estado_sunat,
          aceptada_sunat, anulado, motivo_anulacion, error_mensaje, proveedor_fiscal, ambiente_fiscal, creado_en,
          id_comprobante_modificado, doc_modificado_tipo, doc_modificado_serie, doc_modificado_numero, nota_motivo,
          nota_sustento, efecto_nota, reingresar_stock, efectos_aplicados)
       VALUES ($1, $2, 1, $3, $4, 6, '20999999991', $5, '24-10-2026', '24-10-2026', 18, $6, 0, $6, $7, $8, $9, $10, $11, $12,
               $13, $14, $15::timestamp, $16, $17, $18, $19, $20, $21, $22, $23, COALESCE($24, FALSE))
       RETURNING id_comprobante`,
      [
        datos.id_venta, datos.id_tipo, datos.serie, numero, `CLIENTE ${marca}`, datos.total, datos.estado ?? 'emitido',
        datos.estado_sunat === undefined ? 'ACEPTADO' : datos.estado_sunat, datos.aceptada ?? true, datos.anulado ?? false,
        datos.motivo_anulacion ?? null, datos.error_mensaje ?? null, datos.proveedor ?? 'sunat_directo',
        datos.ambiente === undefined ? 'produccion' : datos.ambiente, datos.creado_en,
        nota?.id_origen ?? null, nota ? '01' : null, nota?.serie_origen ?? null, nota?.numero_origen ?? null, nota?.motivo ?? null,
        nota ? 'Devolución de prueba' : null, nota?.efecto ?? null, nota ? true : null, nota?.efectos_aplicados ?? null,
      ],
    );
    return { id: Number(fila.id_comprobante), numero };
  }

  async function guia(datos: { id_venta: number; id_comprobante?: number; estado: string; numero?: number; items: { id_producto: number; cantidad: number }[] }): Promise<number> {
    const id = Number(
      (await uno(
        `INSERT INTO guias_remision (id_venta, id_comprobante, serie, numero, estado, fecha_emision, motivo_traslado_codigo, modalidad_traslado, creado_en)
         VALUES ($1, $2, $3, $4, $5, $6::date, '01', '02', NOW()) RETURNING id_guia`,
        [datos.id_venta, datos.id_comprobante ?? null, datos.numero ? 'T001' : null, datos.numero ?? null, datos.estado, datos.numero ? '2026-10-24' : null],
      )).id_guia,
    );
    for (const [orden, item] of datos.items.entries()) {
      await ds.query(
        'INSERT INTO guias_remision_items (id_guia, id_producto, cantidad, descripcion, orden) VALUES ($1, $2, $3, $4, $5)',
        [id, item.id_producto, item.cantidad, `Producto ${item.id_producto}`, orden + 1],
      );
    }
    return id;
  }

  const ids = (filas: { id_venta: number }[]) => filas.map((f) => f.id_venta).filter((id) => Object.values(v).includes(id));

  beforeAll(async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    ds = new DataSource({
      type: 'postgres',
      url: URL,
      entities: [Comprobante, ComprobanteItem, TipoComprobante, Moneda, Cliente, Documento, Usuarios, Rol],
      synchronize: false,
      logging: false,
    });
    await ds.initialize();
    const migraciones = await uno(
      `SELECT (SELECT count(*)::int FROM information_schema.columns
                WHERE table_name = 'comprobantes' AND column_name IN ('hora_emision', 'efecto_nota', 'efectos_aplicados')) AS columnas,
              to_regclass('uq_comprobantes_venta_principal') IS NOT NULL AS fase12,
              to_regclass('ix_guias_remision_items_guia') IS NOT NULL AS fase13`,
    );
    if (Number(migraciones.columnas) !== 3 || !migraciones.fase12 || !migraciones.fase13) {
      throw new Error('La base de HS_PG_PRUEBAS_URL necesita sql/fase12, fase13 y fase14 aplicados.');
    }
    siguienteNumero = Number((await uno('SELECT COALESCE(MAX(numero), 0) AS n FROM comprobantes')).n) + 1000;

    const empresa = Number((await uno('INSERT INTO empresas (razon_social, ruc) VALUES ($1, $2) RETURNING id_empresa', [`EMPRESA ${marca} SAC`, '20999999991'])).id_empresa);
    const persona = await cliente(`PERSONA ${marca}`, 1234567);
    const conPorcentaje = await cliente(`${marca} 50% DSCTO_VIP`);
    const sinPorcentaje = await cliente(`${marca} 50X DSCTOXVIP`);
    const otro = await cliente(`OTRO ${marca}`);

    // v1: 2026-10-24 23:30 en Lima (04:30 UTC del 25): factura aceptada con su envío, nota 07 aceptada y dos guías.
    v.v1 = await venta({
      fechaUtc: '2026-10-25 04:30:00',
      total: 118,
      id_empresa: empresa,
      lineas: [{ id_producto: 1, cantidad: 2, precio: 50 }, { id_producto: 2, cantidad: 1, precio: 18 }],
      pagos: [{ id_metodo: EFECTIVO, monto: 100 }, { id_metodo: TARJETA, monto: 18 }],
    });
    c.factura = await comprobante({ id_venta: v.v1, id_tipo: 1, serie: 'F001', total: 118, creado_en: '2026-10-25 04:31:00' });
    const envio = await uno(
      `INSERT INTO fiscal_envios (id_comprobante, tipo_documento, ambiente, proveedor, operacion, estado, intento, identificador, codigo_sunat, mensaje_sunat, respuesta_json)
       VALUES ($1, '01', 'produccion', 'sunat_directo', 'emitir', 'ACEPTADO', 1, $2, '0', 'La Factura ha sido aceptada', $3::jsonb) RETURNING id_envio`,
      [c.factura.id, `${EMISOR.ruc}-01-F001-${c.factura.numero}`, JSON.stringify({ clasificacion: { estado: 'ACEPTADO', accion: 'NINGUNA' } })],
    );
    await ds.query('UPDATE comprobantes SET id_envio_ultimo = $2 WHERE id_comprobante = $1', [c.factura.id, Number(envio.id_envio)]);
    c.nota = await comprobante({
      id_venta: v.v1, id_tipo: 7, serie: 'FC01', total: 10, creado_en: '2026-10-25 04:40:00',
      nota: { id_origen: c.factura.id, serie_origen: 'F001', numero_origen: c.factura.numero, motivo: '07', efecto: 'devolucion', efectos_aplicados: true },
    });
    await guia({ id_venta: v.v1, id_comprobante: c.factura.id, estado: 'aceptado', numero: siguienteNumero + 1, items: [{ id_producto: 1, cantidad: 1 }] });
    await guia({ id_venta: v.v1, estado: 'borrador', items: [{ id_producto: 2, cantidad: 1 }] });

    // v2: 24/10 10:00 en Lima: su boleta fue rechazada (sin comprobante vigente).
    v.v2 = await venta({ fechaUtc: '2026-10-24 15:00:00', total: 25, id_cliente: persona, lineas: [{ id_producto: 1, cantidad: 1, precio: 25 }], pagos: [{ id_metodo: EFECTIVO, monto: 25 }] });
    c.rechazada = await comprobante({
      id_venta: v.v2, id_tipo: 2, serie: 'B001', total: 25, creado_en: '2026-10-24 15:01:00', estado: 'error', estado_sunat: 'RECHAZADO', aceptada: false, error_mensaje: RECHAZO,
    });

    // v3 y v4: 23/10 en Lima, sin comprobante; sus clientes se distinguen solo por % y _ literales.
    v.v3 = await venta({ fechaUtc: '2026-10-23 17:00:00', total: 10, id_cliente: conPorcentaje, lineas: [{ id_producto: 2, cantidad: 1, precio: 10 }], pagos: [{ id_metodo: EFECTIVO, monto: 10 }] });
    v.v4 = await venta({ fechaUtc: '2026-10-23 18:00:00', total: 11, id_cliente: sinPorcentaje, lineas: [{ id_producto: 2, cantidad: 1, precio: 11 }], pagos: [{ id_metodo: EFECTIVO, monto: 11 }] });

    // v5: venta anulada con su boleta anulada.
    v.v5 = await venta({ fechaUtc: '2026-10-22 16:00:00', total: 12, id_cliente: otro, estado: 'anulada', lineas: [{ id_producto: 1, cantidad: 1, precio: 12 }], pagos: [{ id_metodo: EFECTIVO, monto: 12 }] });
    await comprobante({ id_venta: v.v5, id_tipo: 2, serie: 'B001', total: 12, creado_en: '2026-10-22 16:01:00', anulado: true, motivo_anulacion: `Venta ${v.v5} anulada` });

    // v6: activa, pero su boleta se anuló (error en el RUC): necesita otro comprobante.
    v.v6 = await venta({ fechaUtc: '2026-10-22 17:00:00', total: 13, id_cliente: otro, lineas: [{ id_producto: 1, cantidad: 1, precio: 13 }], pagos: [{ id_metodo: EFECTIVO, monto: 13 }] });
    c.anulada = await comprobante({ id_venta: v.v6, id_tipo: 2, serie: 'B001', total: 13, creado_en: '2026-10-22 17:01:00', anulado: true, motivo_anulacion: 'Error en el RUC' });

    // v7: 25/10 00:30 en Lima (fuera del día 24), factura con el envío en curso (cuenta como vigente) y a crédito.
    v.v7 = await venta({ fechaUtc: '2026-10-25 05:30:00', total: 50, id_cliente: otro, lineas: [{ id_producto: 2, cantidad: 2, precio: 25 }], pagos: [{ id_metodo: 10, monto: 50 }] });
    await comprobante({ id_venta: v.v7, id_tipo: 1, serie: 'F001', total: 50, creado_en: '2026-10-25 05:31:00', estado: 'pendiente', estado_sunat: 'PENDIENTE_REENVIO', aceptada: false });
    await ds.query(
      `INSERT INTO cuentas_por_cobrar (id_venta, id_cliente, monto_total, saldo, fecha_vencimiento, estado) VALUES ($1, $2, 50, 30, '2026-11-10', 'parcial')`,
      [v.v7, otro],
    );

    const esquema = new EsquemaCajaService(ds);
    ventas = new VentaRepository(ds, esquema);
    const motor = new ComprobanteBussnies(
      new ComprobanteRepository(ds.getRepository(Comprobante)),
      {} as never,
      { obtenerTexto: async (_clave: string, defecto: string) => defecto, obtenerVarias: async () => ({}) } as never,
      emision as never,
    );
    const notas = new NotaCreditoBussnies(new NotaCreditoRepository(ds, esquema), ventas, motor, emision as never, { registrar: jest.fn() } as never);
    notas.onModuleInit();
    negocio = new VentaDocumentosBussnies(
      new VentaDocumentosRepository(ds, esquema),
      motor,
      notas,
      new GuiaRemisionRepository(ds, {} as never),
      emision as never,
      { modo: async () => ({ activo: false, codigo: 'GRE_SIN_BETA', motivo: MOTIVO_GRE }) } as never,
    );
  }, 60_000);

  afterAll(async () => {
    await ds?.destroy();
    jest.restoreAllMocks();
  });

  it('venta con factura aceptada, nota de crédito y guías: documentos, banderas de Documentos y acciones', async () => {
    const r = await negocio.documentos(v.v1, ADMIN);
    const numeroFactura = `F001-${String(c.factura.numero).padStart(8, '0')}`;

    expect(r.venta).toEqual({
      id: v.v1,
      fecha: '2026-10-24T23:30:00-05:00',
      total: 118,
      estado: 'activa',
      cliente: { nombre: `EMPRESA ${marca} SAC`, documento: '20999999991' },
      pagos: [{ metodo: 'EFECTIVO', monto: 100 }, { metodo: 'TARJETA', monto: 18 }],
      a_credito: false,
      saldo_cxc: 0,
    });
    expect(r.comprobante).toMatchObject({
      id_comprobante: c.factura.id,
      numero_formateado: numeroFactura,
      estado: 'emitido',
      estado_sunat: 'ACEPTADO',
      ambiente_fiscal: 'produccion',
      accion_sunat: 'NINGUNA',
      mensaje: 'La Factura ha sido aceptada',
      puede_nota_credito: true,
      puede_anular: true,
      puede_reintentar: false,
    });
    expect(r.notas).toEqual([
      expect.objectContaining({
        id_comprobante: c.nota.id,
        motivo: '07',
        motivo_nombre: 'DEVOLUCION POR ITEM',
        efecto: 'devolucion',
        efectos_aplicados: true,
        doc_modificado: numeroFactura,
        total: 10,
      }),
    ]);
    expect(r.guias.map((g) => [g.estado, g.estado_texto, g.motivo_nombre, g.numero_formateado === null])).toEqual([
      ['aceptado', 'Aceptada', 'Venta', false],
      ['borrador', 'Borrador', 'Venta', true],
    ]);
    expect(r.acciones).toEqual({
      emitir_comprobante: { permitido: false, motivo: `La venta ${v.v1} ya tiene el comprobante ${numeroFactura}. No se emite otro para no duplicarlo.` },
      nota_credito: { permitido: true },
      // Queda una unidad del producto 1 sin guía: el borrador se puede crear aunque la GRE no se pueda emitir.
      guia: { permitido: true, motivo: `Podrá guardar la guía como borrador y validarla, pero todavía no emitirla a SUNAT. ${MOTIVO_GRE}` },
      anular: { permitido: true, motivo: `Se emitirá una nota de crédito que anula ${numeroFactura}: la venta se anulará cuando SUNAT la acepte.` },
    });
    expect(r.avisos).toEqual(['Hay una guía en borrador: todavía no se emitió a SUNAT.']);
  });

  it('venta con la boleta rechazada: sin comprobante vigente, el rechazo en el historial y «Emitir comprobante»', async () => {
    const r = await negocio.documentos(v.v2, VENDEDOR);

    expect(r.venta.cliente).toEqual({ nombre: `PERSONA ${marca}`, documento: '01234567' });
    expect(r.comprobante).toBeNull();
    expect(r.comprobantes_anteriores).toEqual([
      expect.objectContaining({ id_comprobante: c.rechazada.id, estado: 'error', estado_sunat: 'RECHAZADO', mensaje: RECHAZO, puede_nota_credito: false }),
    ]);
    expect(r.acciones.emitir_comprobante).toEqual({ permitido: true });
    expect(r.acciones.anular).toEqual({ permitido: false, motivo: 'Solo un administrador puede anular la venta.' });
    expect(r.avisos).toEqual(['La venta no tiene comprobante electrónico vigente: emítalo con «Emitir comprobante».']);
  });

  it('venta a crédito con la factura en envío: cuenta como vigente y trae la deuda', async () => {
    const r = await negocio.documentos(v.v7, ADMIN);
    expect(r.venta).toMatchObject({ a_credito: true, saldo_cxc: 30, fecha: '2026-10-25T00:30:00-05:00' });
    expect(r.comprobante).toMatchObject({ estado: 'pendiente', estado_sunat: 'PENDIENTE_REENVIO' });
    expect(r.acciones.emitir_comprobante.permitido).toBe(false);
  });

  it('404 si la venta no existe', async () => {
    await expect(negocio.documentos(2_000_000_000, ADMIN)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('ventas sin comprobante: activas sin factura ni boleta vigente, con el último motivo, por días de Lima', async () => {
    const r = await negocio.sinComprobante({ desde: '2026-10-22', hasta: '2026-10-24', por_pagina: 100 });

    expect(ids(r.datos)).toEqual([v.v2, v.v4, v.v3, v.v6]);
    const porVenta = new Map(r.datos.map((f) => [f.id_venta, f]));
    expect(porVenta.get(v.v2)).toMatchObject({
      fecha: '2026-10-24T10:00:00-05:00',
      total: 25,
      cliente: `PERSONA ${marca}`,
      documento_cliente: '01234567',
      ultimo_error: `B001-${String(c.rechazada.numero).padStart(8, '0')}: ${RECHAZO}`,
    });
    expect(porVenta.get(v.v6)?.ultimo_error).toBe(`B001-${String(c.anulada.numero).padStart(8, '0')} se anuló: Error en el RUC`);
    // Con la emisión activa, una venta que nunca tuvo comprobante no inventa un motivo.
    expect(porVenta.get(v.v3)?.ultimo_error).toBeNull();

    const delDia = await negocio.sinComprobante({ desde: '2026-10-24', hasta: '2026-10-24', por_pagina: 100 });
    expect(ids(delDia.datos)).toEqual([v.v2]);
  });

  describe('historial (GET /venta)', () => {
    it('cada venta con su comprobante vigente, medios de pago, notas y guías; de la más reciente a la más antigua', async () => {
      const r = await ventas.listar({ texto: marca, por_pagina: 100 });

      expect(r.total).toBe(7);
      expect(ids(r.datos)).toEqual([v.v7, v.v1, v.v2, v.v4, v.v3, v.v6, v.v5]);
      const porVenta = new Map(r.datos.map((f) => [f.id_venta, f]));
      expect(porVenta.get(v.v1)).toEqual<VentaHistorialFila>({
        id_venta: v.v1,
        fecha: '2026-10-24T23:30:00-05:00',
        origen: 'mostrador',
        id_empresa: expect.any(Number) as unknown as number,
        cliente_denominacion: `EMPRESA ${marca} SAC`,
        total: 118,
        cantidad_items: 2,
        estado: 'activa',
        metodos_pago: 'EFECTIVO, TARJETA',
        comprobante: `F001-${String(c.factura.numero).padStart(8, '0')}`,
        comprobante_estado: 'emitido',
        id_comprobante: c.factura.id,
        serie: 'F001',
        numero: c.factura.numero,
        comprobante_tipo: 1,
        comprobante_estado_sunat: 'ACEPTADO',
        cantidad_notas: 1,
        cantidad_guias: 2,
      });
      const rechazada = porVenta.get(v.v2)!;
      expect('comprobante' in rechazada || 'serie' in rechazada).toBe(false);
      expect(rechazada).toMatchObject({ comprobante_tipo: null, comprobante_estado_sunat: null, cantidad_notas: 0, cantidad_guias: 0 });
      expect(porVenta.get(v.v5)?.estado).toBe('anulada');
    });

    it('% y _ del texto son literales; también busca por DNI y por serie-número con o sin ceros (de la nota también)', async () => {
      const conPorcentaje = await ventas.listar({ texto: `${marca} 50%`, por_pagina: 100 });
      expect(ids(conPorcentaje.datos)).toEqual([v.v3]);
      const conGuionBajo = await ventas.listar({ texto: 'DSCTO_VIP', por_pagina: 100 });
      expect(ids(conGuionBajo.datos)).toEqual([v.v3]);

      expect(ids((await ventas.listar({ texto: '01234567', por_pagina: 100 })).datos)).toEqual([v.v2]);
      expect(ids((await ventas.listar({ texto: `F001-${c.factura.numero}`, por_pagina: 100 })).datos)).toEqual([v.v1]);
      expect(ids((await ventas.listar({ texto: `F001-${String(c.factura.numero).padStart(8, '0')}`, por_pagina: 100 })).datos)).toEqual([v.v1]);
      expect(ids((await ventas.listar({ texto: `FC01-${c.nota.numero}`, por_pagina: 100 })).datos)).toEqual([v.v1]);
    });

    it('estado, con o sin comprobante, días de Lima y página', async () => {
      const filtro = { texto: marca, por_pagina: 100 };
      expect(ids((await ventas.listar({ ...filtro, estado: 'anulada' })).datos)).toEqual([v.v5]);
      expect(ids((await ventas.listar({ ...filtro, tiene_comprobante: 'si' })).datos)).toEqual([v.v7, v.v1]);
      expect(ids((await ventas.listar({ ...filtro, tiene_comprobante: 'no' })).datos)).toEqual([v.v2, v.v4, v.v3, v.v6, v.v5]);
      // El 24 de Lima va de 05:00 UTC del 24 a 05:00 UTC del 25: entra v1 (04:30 UTC del 25), no v7 (05:30).
      expect(ids((await ventas.listar({ ...filtro, desde: '2026-10-24', hasta: '2026-10-24' })).datos)).toEqual([v.v1, v.v2]);

      const pagina = await ventas.listar({ texto: marca, pagina: 2, por_pagina: 2 });
      expect(pagina).toMatchObject({ total: 7, pagina: 2, por_pagina: 2 });
      expect(ids(pagina.datos)).toEqual([v.v2, v.v4]);
    });
  });
});

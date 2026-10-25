import { BadRequestException, ConflictException, Logger, ServiceUnavailableException } from '@nestjs/common';
import type { Comprobante } from '../../models/DBModel/c-electronico/comprobante.entity';
import type {
  CabeceraComprobante,
  ItemOrigen,
  LineaNotaVigente,
  NotaDeOrigen,
  NotaReclamada,
  OrigenNota,
  VentaDeNota,
} from '../../repository/Repository/nota-credito.repository';
import type { ModoEmision } from '../../sunat/emision/emision.contrato';
import { CODIGO_RECARGO_TARJETA } from '../../util/precios/recargo-tarjeta';
import { ComprobanteBussnies } from './comprobante.bussnies';
import {
  COLUMNAS_COMPLETAS,
  CONTEXTO_PRODUCCION,
  crearBdFalsa,
  crearEmisionFalsa,
  crearMotor,
  posicion,
  resultadoEmision,
} from './comprobante.prueba-spec';
import type { ResumenNotasOrigen, SolicitudEmisionNotaCredito } from './nota-credito.contrato';
import {
  NotaCreditoBussnies,
  calcularAcreditable,
  clasificarParaAnular,
  motivoEmisionInactiva,
  motivosDisponibles,
  planificarAnulacion,
  planificarNota,
} from './nota-credito.bussnies';

// ── Datos ────────────────────────────────────────────────────

function item(parcial: Partial<ItemOrigen>): ItemOrigen {
  return {
    id_item: 401,
    id_producto: 7,
    codigo: 'MAR-01',
    codigo_producto_sunat: null,
    unidad_de_medida: 'NIU',
    descripcion: 'MARTILLO',
    cantidad: 3,
    precio_unitario: 10,
    descuento: 0,
    total: 30,
    tipo_de_igv: 1,
    ...parcial,
  };
}

/** F001-12 de S/ 103 aceptada en producción: 3 martillos (30), 2 bolsas de cemento (70) y recargo por tarjeta (3). */
function origenFactura(parcial: Partial<OrigenNota> = {}): OrigenNota {
  return {
    id_comprobante: 40,
    id_tipo: 1,
    serie: 'F001',
    numero: 12,
    fecha_de_emision: '21-10-2026',
    cliente_tipo_doc: 6,
    cliente_numero_doc: '20123456789',
    cliente_denominacion: 'FERRETERIA EL MARTILLO S.A.C.',
    id_moneda: 1,
    total: 103,
    porcentaje_igv: 18,
    anulado: false,
    estado: 'emitido',
    estado_sunat: 'ACEPTADO',
    aceptada_sunat: true,
    ambiente_fiscal: 'produccion',
    proveedor_fiscal: 'sunat_directo',
    id_venta: 9,
    id_envio_ultimo: 500,
    envio: { estado: 'ACEPTADO', codigo: '0', accion: 'NINGUNA', libre: true },
    items: [
      item({}),
      item({ id_item: 402, id_producto: 8, codigo: 'CEM-01', descripcion: 'CEMENTO SOL', cantidad: 2, precio_unitario: 35, total: 70 }),
      item({ id_item: 403, id_producto: null, codigo: CODIGO_RECARGO_TARJETA, descripcion: 'RECARGO POR PAGO CON TARJETA (3%)', unidad_de_medida: 'ZZ', cantidad: 1, precio_unitario: 3, total: 3 }),
    ],
    ...parcial,
  };
}

function nota(parcial: Partial<NotaDeOrigen> = {}): NotaDeOrigen {
  return {
    id_comprobante: 60,
    serie: 'FC01',
    numero: 1,
    motivo: '07',
    total: 10.3,
    estado: 'emitido',
    estado_sunat: 'ACEPTADO',
    anulado: false,
    aceptada_sunat: true,
    efecto: 'devolucion',
    efectos_aplicados: true,
    id_envio_ultimo: 600,
    mensaje: null,
    ...parcial,
  };
}

/** Líneas de la NC 07 de un martillo (10) con su recargo proporcional (0.30). */
const LINEAS_07_UN_MARTILLO: LineaNotaVigente[] = [
  { id_nota: 60, motivo: '07', id_item_origen: 401, cantidad: 1, total: 10, tipo_de_igv: 1 },
  { id_nota: 60, motivo: '07', id_item_origen: 403, cantidad: 1, total: 0.3, tipo_de_igv: 1 },
];

function cabecera(parcial: Partial<CabeceraComprobante> = {}): CabeceraComprobante {
  const { items: _items, ...resto } = origenFactura();
  return { ...resto, ...parcial };
}

function venta(parcial: Partial<VentaDeNota> = {}): VentaDeNota {
  return { id_venta: 9, estado: 'activa', a_credito: false, saldo_cxc: 0, contado: 103, ...parcial };
}

// ── Servicio con dobles ──────────────────────────────────────

function crear(opciones: { esquema?: boolean; origen?: OrigenNota | null; notas?: NotaDeOrigen[]; lineas?: LineaNotaVigente[] } = {}) {
  const tx = { query: jest.fn() };
  const repo = {
    esquemaListo: jest.fn(async () => opciones.esquema ?? true),
    transaccion: jest.fn(async (trabajo: (t: typeof tx) => Promise<unknown>) => trabajo(tx)),
    origen: jest.fn(async () => (opciones.origen === undefined ? origenFactura() : opciones.origen)),
    notasDeOrigen: jest.fn(async () => opciones.notas ?? []),
    lineasVigentes: jest.fn(async () => opciones.lineas ?? []),
    ventaDeNota: jest.fn(async () => venta()),
    principalesDeVenta: jest.fn(async () => [cabecera()]),
    idPorSerieNumero: jest.fn(async () => 40),
    reclamarEfectos: jest.fn(async (): Promise<NotaReclamada | null> => null),
    lineasDeNota: jest.fn(async () => []),
    marcarAnulados: jest.fn(async (_tx: unknown, ids: number[]) => ids.map((id) => ({ id_comprobante: id, serie: 'F001', numero: 12 }))),
    descartarEnvio: jest.fn(async () => true),
    notasConEfectosPendientes: jest.fn(async () => []),
    resumenes: jest.fn(async () => new Map()),
  };
  const ventas = {
    anularVentaCompleta: jest.fn(async () => ({ stock_devuelto: true, cxc_cerradas: 0, ya_anulada: false })),
    bloquearVenta: jest.fn(async () => ({ estado: 'activa' })),
    devolverStockParcial: jest.fn(async () => [{ id_producto: 7, id_almacen: 1, cantidad: 1 }]),
    ajustarCxcPorNota: jest.fn(async () => ({ descontado: 0, cerradas: 0 })),
  };
  const solicitudes: SolicitudEmisionNotaCredito[] = [];
  const emisor = {
    registrarGestorNotas: jest.fn(),
    emitirNotaCredito: jest.fn(async (solicitud: SolicitudEmisionNotaCredito) => {
      solicitudes.push(solicitud);
      await solicitud.validarEnTransaccion(tx);
      return { id_comprobante: 70, tipo_de_comprobante: 7, serie: 'FC01', numero: 2, numero_formateado: 'FC01-00000002', estado: 'pendiente', estado_sunat: 'ENVIANDO', aceptada_sunat: false } as Record<string, unknown>;
    }),
  };
  const emision = {
    modo: jest.fn(async () => ({ activo: true, ambiente: 'produccion' })),
    recuperarCdr: jest.fn(),
    confirmarAceptadoManual: jest.fn(async () => ({ aceptado: true })),
  };
  const auditoria = { registrar: jest.fn(async () => undefined) };
  const servicio = new NotaCreditoBussnies(repo as never, ventas as never, emisor as never, emision as never, auditoria as never);
  return { servicio, repo, ventas, emisor, emision, auditoria, solicitudes, tx };
}

beforeAll(() => {
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
});

describe('lo acreditable de un comprobante (D8, funciones puras)', () => {
  it('sin notas: saldo = total y todo disponible', () => {
    const estado = calcularAcreditable(origenFactura(), [], []);
    expect(estado.saldo).toBe(103);
    expect(estado.hayNotasVigentes).toBe(false);
    expect(estado.items.map((i) => [i.cantidadDisponible, i.importeDisponible, i.esRecargo])).toEqual([
      [3, 30, false],
      [2, 70, false],
      [1, 3, true],
    ]);
  });

  it('solo cuentan las notas vigentes: una rechazada, una anulada o una con error no restan', () => {
    const notas = [
      nota(),
      nota({ id_comprobante: 61, total: 50, estado: 'error', estado_sunat: 'RECHAZADO', aceptada_sunat: false }),
      nota({ id_comprobante: 62, total: 20, anulado: true }),
      nota({ id_comprobante: 63, total: 5, estado: 'error', estado_sunat: 'EXCEPCION', aceptada_sunat: false }),
    ];
    const estado = calcularAcreditable(origenFactura(), notas, LINEAS_07_UN_MARTILLO);
    expect(estado.saldo).toBe(92.7);
    expect(estado.items[0]).toMatchObject({ cantidadAcreditada: 1, cantidadDisponible: 2, importeDisponible: 20 });
    expect(estado.items[2]).toMatchObject({ importeDisponible: 2.7, cantidadDisponible: 1 });
  });

  it('una nota por monto (09) se reparte entre las líneas de su tramo: lo disponible nunca supera el saldo', () => {
    const estado = calcularAcreditable(
      origenFactura(),
      [nota({ motivo: '09', total: 10, efecto: 'ninguno' })],
      [{ id_nota: 60, motivo: '09', id_item_origen: null, cantidad: 1, total: 10, tipo_de_igv: 1 }],
    );
    expect(estado.saldo).toBe(93);
    const suma = estado.items.reduce((s, i) => s + Math.round(i.importeDisponible * 100), 0);
    expect(suma).toBe(9300);
    expect(estado.items.map((i) => i.cantidadDisponible)).toEqual([3, 2, 1]);
  });

  it('motivos por tipo de origen: la boleta no admite 05 y con notas vigentes desaparecen los totales', () => {
    const factura = motivosDisponibles('01', calcularAcreditable(origenFactura(), [], []));
    expect(factura.map((m) => m.codigo)).toEqual(['01', '02', '05', '06', '07', '09', '10']);
    expect(factura.find((m) => m.codigo === '07')).toMatchObject({ forma: 'items', efecto: 'devolucion', reingresar_stock: true });
    expect(factura.find((m) => m.codigo === '02')).toMatchObject({ efecto: 'ninguno', reingresar_stock: null, aviso: expect.stringContaining('comprobante correcto') });

    const boleta = motivosDisponibles('03', calcularAcreditable(origenFactura({ id_tipo: 2 }), [], []));
    expect(boleta.map((m) => m.codigo)).toEqual(['01', '02', '06', '07', '09', '10']);

    const conNota = motivosDisponibles('01', calcularAcreditable(origenFactura(), [nota()], LINEAS_07_UN_MARTILLO));
    expect(conNota.map((m) => m.codigo)).toEqual(['05', '07', '09', '10']);

    const agotado = calcularAcreditable(origenFactura(), [nota({ total: 103 })], []);
    expect(motivosDisponibles('01', agotado)).toEqual([]);
  });
});

describe('plan de la nota (D8)', () => {
  const sinNotas = () => calcularAcreditable(origenFactura(), [], []);

  it('07 parcial: la línea acredita su parte y el recargo va en proporción a lo devuelto', () => {
    const plan = planificarNota(origenFactura(), sinNotas(), { motivo: '07', items: [{ id_item: 401, cantidad: 1 }] });
    expect(plan).toMatchObject({ motivo: '07', efecto: 'devolucion', reingresar_stock: true, total: 10.3 });
    expect(plan.lineas).toEqual([
      expect.objectContaining({ id_item_origen: 401, id_producto: 7, cantidad: 1, precio_unitario: 10, descuento: 0 }),
      expect.objectContaining({ id_item_origen: 403, cantidad: 1, precio_unitario: 0.3, descripcion: 'RECARGO POR PAGO CON TARJETA (devolucion proporcional)' }),
    ]);
  });

  it('la devolución que agota los productos acredita todo lo que queda del recargo (cierra al céntimo)', () => {
    const estado = calcularAcreditable(origenFactura(), [nota()], LINEAS_07_UN_MARTILLO);
    const plan = planificarNota(origenFactura(), estado, {
      motivo: '07',
      items: [{ id_item: 401, cantidad: 2 }, { id_item: 402, cantidad: 2 }],
    });
    expect(plan.total).toBe(92.7);
    expect(plan.lineas.at(-1)).toMatchObject({ id_item_origen: 403, precio_unitario: 2.7 });
  });

  it('una línea con descuento acredita al precio neto de la unidad (con el descuento repartido)', () => {
    const origen = origenFactura({ total: 29, items: [item({ cantidad: 3, precio_unitario: 10, descuento: 1, total: 29 })] });
    const primera = planificarNota(origen, calcularAcreditable(origen, [], []), { motivo: '07', items: [{ id_item: 401, cantidad: 1 }] });
    expect(primera.total).toBe(9.67);
    expect(primera.lineas[0]).toMatchObject({ precio_unitario: 10, descuento: 0.33 });
  });

  it('rechaza con 400: más unidades de las disponibles, el recargo elegido, ítems repetidos o ajenos', () => {
    const estado = sinNotas();
    expect(() => planificarNota(origenFactura(), estado, { motivo: '07', items: [{ id_item: 401, cantidad: 4 }] })).toThrow('quedan 3');
    expect(() => planificarNota(origenFactura(), estado, { motivo: '07', items: [{ id_item: 403, cantidad: 1 }] })).toThrow('recargo');
    expect(() => planificarNota(origenFactura(), estado, { motivo: '07', items: [{ id_item: 401, cantidad: 1 }, { id_item: 401, cantidad: 1 }] })).toThrow('repetido');
    expect(() => planificarNota(origenFactura(), estado, { motivo: '07', items: [{ id_item: 999, cantidad: 1 }] })).toThrow(BadRequestException);
    expect(() => planificarNota(origenFactura(), estado, { motivo: '07' })).toThrow('Indique los ítems');
  });

  it('una fracción no se reingresa al stock (unidades enteras), salvo que no se reingrese', () => {
    const origen = origenFactura({ items: [item({ cantidad: 2.5, total: 25 })], total: 25 });
    const estado = calcularAcreditable(origen, [], []);
    expect(() => planificarNota(origen, estado, { motivo: '07', items: [{ id_item: 401, cantidad: 0.5 }] })).toThrow('unidades enteras');
    expect(planificarNota(origen, estado, { motivo: '07', items: [{ id_item: 401, cantidad: 0.5 }], reingresar_stock: false }).reingresar_stock).toBe(false);
  });

  it('05: descuento por línea hasta lo que queda de ella; 09/10: una línea de ajuste por tramo, prorrateada', () => {
    const estado = sinNotas();
    expect(() => planificarNota(origenFactura(), estado, { motivo: '05', items: [{ id_item: 401, descuento: 31 }] })).toThrow('no puede superar 30.00');
    const descuento = planificarNota(origenFactura(), estado, { motivo: '05', items: [{ id_item: 401, descuento: 5 }] });
    expect(descuento).toMatchObject({ efecto: 'ninguno', reingresar_stock: false, total: 5 });
    expect(descuento.lineas[0]).toMatchObject({ descripcion: 'DESCUENTO - MARTILLO', cantidad: 1, precio_unitario: 5, id_item_origen: 401 });

    const mixto = origenFactura({ total: 100, items: [item({ total: 30 }), item({ id_item: 402, total: 70, cantidad: 2, precio_unitario: 35, tipo_de_igv: 8 })] });
    const monto = planificarNota(mixto, calcularAcreditable(mixto, [], []), { motivo: '10', monto: 10 });
    expect(monto.lineas).toEqual([
      expect.objectContaining({ id_item_origen: null, tipo_de_igv: 1, precio_unitario: 3, descripcion: 'OTROS CONCEPTOS' }),
      expect.objectContaining({ id_item_origen: null, tipo_de_igv: 8, precio_unitario: 7 }),
    ]);
    expect(() => planificarNota(mixto, calcularAcreditable(mixto, [], []), { motivo: '09', monto: 101 })).toThrow('supera el saldo');
  });

  it('los motivos totales solo sin notas vigentes previas (409)', () => {
    const estado = calcularAcreditable(origenFactura(), [nota()], LINEAS_07_UN_MARTILLO);
    expect(() => planificarNota(origenFactura(), estado, { motivo: '06' })).toThrow(ConflictException);
    const total = planificarNota(origenFactura(), sinNotas(), { motivo: '06' });
    expect(total.lineas).toHaveLength(3);
    expect(total.total).toBe(103);
  });

  it('anulación: 01 total sin notas previas, 07 con lo que queda si las hay, nada si ya está todo acreditado', () => {
    const total = planificarAnulacion(origenFactura(), sinNotas());
    expect(total).toMatchObject({ motivo: '01', efecto: 'anular_venta', total: 103 });

    const resto = planificarAnulacion(origenFactura(), calcularAcreditable(origenFactura(), [nota()], LINEAS_07_UN_MARTILLO));
    expect(resto).toMatchObject({ motivo: '07', efecto: 'anular_venta', total: 92.7 });
    expect(resto?.lineas.map((l) => [l.id_item_origen, l.cantidad])).toEqual([[401, 2], [402, 2], [403, 1]]);

    expect(planificarAnulacion(origenFactura(), calcularAcreditable(origenFactura(), [nota({ total: 103 })], []))).toBeNull();
  });
});

describe('clasificación para anular (D9)', () => {
  it.each([
    ['histórico', { proveedor_fiscal: 'nubefact' }, 'local'],
    ['de BETA con producción vigente', { ambiente_fiscal: 'beta' }, 'local'],
    ['aceptado', {}, 'aceptado'],
    ['sin envío', { estado_sunat: 'NO_ENVIADO', aceptada_sunat: false, id_envio_ultimo: null, envio: null }, 'nunca_enviado'],
    ['rechazado', { estado_sunat: 'RECHAZADO', aceptada_sunat: false }, 'nunca_enviado'],
    ['EXCEPCION por formato (1xxx)', { estado_sunat: 'EXCEPCION', aceptada_sunat: false, envio: { estado: 'EXCEPCION', codigo: '0160', accion: null, libre: true } }, 'nunca_enviado'],
    ['EXCEPCION sin código', { estado_sunat: 'EXCEPCION', aceptada_sunat: false, envio: { estado: 'EXCEPCION', codigo: null, accion: null, libre: true } }, 'incierto'],
    ['pendiente de reenvío', { estado_sunat: 'PENDIENTE_REENVIO', aceptada_sunat: false }, 'incierto'],
  ])('%s → %s', (_caso, cambios, esperado) => {
    expect(clasificarParaAnular(cabecera(cambios as Partial<CabeceraComprobante>), 'produccion')).toBe(esperado);
  });
});

describe('NotaCreditoBussnies', () => {
  it('se registra en el motor de comprobantes al iniciar (anulación y saldos de Documentos)', () => {
    const { servicio, emisor } = crear();
    servicio.onModuleInit();
    expect(emisor.registrarGestorNotas).toHaveBeenCalledWith(servicio);
  });

  describe('contexto', () => {
    it('sin fase14 responde 503 con el script que falta, sin leer nada más', async () => {
      const { servicio, repo } = crear({ esquema: false });
      const error = await servicio.contexto(40).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ServiceUnavailableException);
      expect((error as ServiceUnavailableException).message).toBe('Aplique sql/fase14_notas_credito_enlace.sql para habilitar las notas de crédito.');
      expect(repo.origen).not.toHaveBeenCalled();
    });

    it('arma saldo, ítems, motivos, notas previas, venta y avisos; con otra nota en curso no permite emitir', async () => {
      const { servicio, repo } = crear({
        notas: [nota(), nota({ id_comprobante: 61, numero: 2, total: 5, estado: 'pendiente', estado_sunat: 'ENVIANDO', aceptada_sunat: false, motivo: '09' })],
        lineas: LINEAS_07_UN_MARTILLO,
      });
      repo.ventaDeNota.mockResolvedValue(venta({ a_credito: true, saldo_cxc: 40, contado: 63 }));

      const contexto = await servicio.contexto(40);

      expect(contexto).toMatchObject({
        permitido: false,
        motivo_no_permitido: expect.stringContaining('FC01-00000002 todavía se está enviando'),
        origen: { id: 40, tipo: '01', numero_formateado: 'F001-00000012', moneda: 'PEN', total: 103 },
        saldo: 87.7,
        venta: { id: 9, a_credito: true, saldo_cxc: 40, pagada_al_contado: true },
      });
      expect(contexto.items[0]).toMatchObject({ id_item: 401, cantidad_disponible: 2, cantidad_acreditada: 1, es_recargo: false });
      expect(contexto.notas_previas.map((n) => [n.numero_formateado, n.vigente, n.en_curso])).toEqual([
        ['FC01-00000001', true, false],
        ['FC01-00000002', true, true],
      ]);
      expect(contexto.avisos.join(' ')).toContain('debe S/ 40.00');
      expect(contexto.avisos.join(' ')).toContain('devolución del dinero');
    });

    it('un comprobante de BETA con producción vigente no admite nota (se anula en el sistema)', async () => {
      const { servicio } = crear({ origen: origenFactura({ ambiente_fiscal: 'beta' }) });
      const contexto = await servicio.contexto(40);
      expect(contexto.permitido).toBe(false);
      expect(contexto.motivo_no_permitido).toContain('SUNAT BETA (pruebas)');
    });
  });

  describe('emitir', () => {
    it('entrega al motor la nota armada: motivo, efecto, reingreso, líneas con ítem de origen y saldo como tope', async () => {
      const { servicio, solicitudes, repo, tx } = crear();

      const respuesta = await servicio.emitir(40, { motivo: '07', sustento: '  Devolución   de un martillo ', items: [{ id_item: 401, cantidad: 1 }] }, 3);

      expect(solicitudes[0]).toMatchObject({
        id_comprobante_origen: 40,
        id_venta: 9,
        motivo: '07',
        sustento: 'Devolución de un martillo',
        efecto: 'devolucion',
        reingresar_stock: true,
        saldo_maximo: 10.3,
        id_usuario: 3,
      });
      expect(solicitudes[0].lineas.map((l) => l.id_item_origen)).toEqual([401, 403]);
      // validarEnTransaccion relee con la conexión de la transacción.
      expect(repo.notasDeOrigen).toHaveBeenLastCalledWith(40, tx);
      expect(respuesta).toMatchObject({ estado: 'pendiente', efecto: 'devolucion', efectos_aplicados: false });
      expect(respuesta.avisos.join(' ')).toContain('quedó en envío a SUNAT');
    });

    it('409 con el id si otra nota del comprobante está en curso, antes y dentro de la transacción', async () => {
      const enCurso = nota({ id_comprobante: 61, numero: 2, estado: 'pendiente', estado_sunat: 'PENDIENTE_REENVIO', aceptada_sunat: false });
      const antes = crear({ notas: [enCurso] });
      const error = await antes.servicio.emitir(40, { motivo: '07', sustento: 'Devolución', items: [{ id_item: 401, cantidad: 1 }] }, 3).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).getResponse()).toMatchObject({ codigo: 'NOTA_CREDITO_EN_CURSO', id_comprobante: 61 });
      expect(antes.emisor.emitirNotaCredito).not.toHaveBeenCalled();

      // Otra nota se registró entre la validación previa y el candado nc:<origen>.
      const durante = crear();
      durante.repo.notasDeOrigen.mockResolvedValueOnce([]).mockResolvedValueOnce([enCurso]);
      const enTransaccion = await durante.servicio.emitir(40, { motivo: '07', sustento: 'Devolución', items: [{ id_item: 401, cantidad: 1 }] }, 3).catch((e: unknown) => e);
      expect((enTransaccion as ConflictException).getResponse()).toMatchObject({ codigo: 'NOTA_CREDITO_EN_CURSO', id_comprobante: 61 });
    });

    it('409 si otra nota ya aceptada cambió lo disponible mientras se preparaba', async () => {
      const { servicio, repo } = crear();
      repo.notasDeOrigen.mockResolvedValueOnce([]).mockResolvedValueOnce([nota({ total: 30 })]);
      repo.lineasVigentes.mockResolvedValueOnce([]).mockResolvedValueOnce([{ id_nota: 60, motivo: '07', id_item_origen: 401, cantidad: 3, total: 30, tipo_de_igv: 1 }]);

      const error = await servicio.emitir(40, { motivo: '07', sustento: 'Devolución', items: [{ id_item: 401, cantidad: 1 }] }, 3).catch((e: unknown) => e);

      expect((error as ConflictException).getResponse()).toMatchObject({ codigo: 'NOTA_CREDITO_SALDO_CAMBIO' });
    });

    it('503 sin fase14 o con la emisión inactiva; 400 con un motivo de factura sobre una boleta', async () => {
      await expect(crear({ esquema: false }).servicio.emitir(40, { motivo: '07', sustento: 'abc' }, 1)).rejects.toBeInstanceOf(ServiceUnavailableException);

      const inactiva = crear();
      inactiva.emision.modo.mockResolvedValue({ activo: false, ambiente: 'produccion', codigo: 'FISCAL_EMISION_BLOQUEADA', motivo: 'SUNAT rechazó la clave SOL' } as never);
      await expect(inactiva.servicio.emitir(40, { motivo: '06', sustento: 'Devolución total' }, 1)).rejects.toMatchObject({ status: 503 });

      const boleta = crear({ origen: origenFactura({ id_tipo: 2, serie: 'B001' }) });
      await expect(boleta.servicio.emitir(40, { motivo: '05', sustento: 'Descuento', items: [{ id_item: 401, descuento: 1 }] }, 1)).rejects.toThrow('solo se puede usar sobre facturas');
    });

    it('si SUNAT la acepta al instante, los efectos quedan aplicados (idempotente con el oyente)', async () => {
      const { servicio, emisor, repo } = crear();
      emisor.emitirNotaCredito.mockResolvedValue({ id_comprobante: 70, serie: 'FC01', numero: 2, numero_formateado: 'FC01-00000002', estado: 'emitido', aceptada_sunat: true });

      const respuesta = await servicio.emitir(40, { motivo: '06', sustento: 'Devolución total' }, 1);

      expect(repo.reclamarEfectos).toHaveBeenCalledWith(expect.anything(), 70);
      expect(respuesta.efectos_aplicados).toBe(true);
    });
  });

  describe('efectos al aceptarse', () => {
    const reclamada = (parcial: Partial<NotaReclamada>): NotaReclamada => ({
      id_comprobante: 70, serie: 'FC01', numero: 2, motivo: '07', total: 10.3, efecto: 'devolucion',
      reingresar_stock: true, id_venta: 9, id_origen: 40, ...parcial,
    });

    it('ya aplicados (o no aceptada): no mueve nada', async () => {
      const { servicio, ventas, repo } = crear();
      expect(await servicio.aplicarEfectos(70)).toBeNull();
      expect(repo.transaccion).toHaveBeenCalledTimes(1);
      expect(ventas.devolverStockParcial).not.toHaveBeenCalled();
      expect(ventas.anularVentaCompleta).not.toHaveBeenCalled();
    });

    it('sin fase14 no hay efectos que aplicar (ni transacción)', async () => {
      const { servicio, repo } = crear({ esquema: false });
      expect(await servicio.aplicarEfectos(70)).toBeNull();
      expect(repo.transaccion).not.toHaveBeenCalled();
    });

    it('devolución: candado de la venta, reingreso solo de productos y baja de la deuda, todo en la transacción', async () => {
      const { servicio, ventas, repo, tx } = crear();
      repo.reclamarEfectos.mockResolvedValue(reclamada({}));
      repo.lineasDeNota.mockResolvedValue([
        { id_producto: 7, codigo: 'MAR-01', cantidad: 1, id_item_origen: 401 },
        { id_producto: null, codigo: CODIGO_RECARGO_TARJETA, cantidad: 1, id_item_origen: 403 },
      ] as never);
      ventas.ajustarCxcPorNota.mockResolvedValue({ descontado: 10.3, cerradas: 0 });

      const efectos = await servicio.aplicarEfectos(70);

      expect(ventas.bloquearVenta).toHaveBeenCalledWith(tx, 9);
      expect(ventas.devolverStockParcial).toHaveBeenCalledWith(tx, 9, [{ id_producto: 7, cantidad: 1 }], {
        reingresar: true,
        descripcion: 'Devolución por nota de crédito FC01-00000002',
      });
      expect(ventas.ajustarCxcPorNota).toHaveBeenCalledWith(tx, 9, 10.3);
      expect(efectos).toMatchObject({ unidades_reingresadas: 1, deuda_descontada: 10.3, venta_anulada: false });
    });

    it('anular_venta: anula la venta en la misma transacción y marca anulado el comprobante origen', async () => {
      const { servicio, ventas, repo, tx } = crear();
      repo.reclamarEfectos.mockResolvedValue(reclamada({ motivo: '01', efecto: 'anular_venta', total: 103 }));

      const efectos = await servicio.aplicarEfectos(70);

      expect(ventas.anularVentaCompleta).toHaveBeenCalledWith(9, { consultor: tx, descripcion: 'Anulación de la venta 9 con la nota de crédito FC01-00000002' });
      expect(repo.marcarAnulados).toHaveBeenCalledWith(tx, [40], 'Anulado con la nota de crédito FC01-00000002');
      expect(efectos).toMatchObject({ venta_anulada: true, origen_anulado: true });
    });

    it('05/09/10 solo bajan la deuda; 02 anula el origen para emitir el comprobante correcto, sin stock ni deuda', async () => {
      const descuento = crear();
      descuento.repo.reclamarEfectos.mockResolvedValue(reclamada({ motivo: '05', efecto: 'ninguno', total: 5 }));
      await descuento.servicio.aplicarEfectos(70);
      expect(descuento.ventas.ajustarCxcPorNota).toHaveBeenCalledWith(descuento.tx, 9, 5);
      expect(descuento.ventas.devolverStockParcial).not.toHaveBeenCalled();

      const ruc = crear();
      ruc.repo.reclamarEfectos.mockResolvedValue(reclamada({ motivo: '02', efecto: 'ninguno', total: 103 }));
      const efectos = await ruc.servicio.aplicarEfectos(70);
      expect(ruc.ventas.ajustarCxcPorNota).not.toHaveBeenCalled();
      expect(ruc.ventas.devolverStockParcial).not.toHaveBeenCalled();
      expect(ruc.repo.marcarAnulados).toHaveBeenCalledWith(ruc.tx, [40], expect.stringContaining('error en el RUC'));
      expect(efectos?.origen_anulado).toBe(true);
    });
  });

  describe('anular venta (D9)', () => {
    it('ya anulada: lo informa sin tocar nada', async () => {
      const { servicio, repo } = crear();
      repo.ventaDeNota.mockResolvedValue(venta({ estado: 'anulada' }));
      expect(await servicio.anularVenta(9)).toMatchObject({ estado: 'anulada', ya_anulada: true });
      expect(repo.transaccion).not.toHaveBeenCalled();
    });

    it('a) sin comprobante: anula en el sistema en una transacción (stock y deuda)', async () => {
      const { servicio, repo, ventas, tx } = crear();
      repo.principalesDeVenta.mockResolvedValue([]);

      const resultado = await servicio.anularVenta(9, {}, 1);

      expect(ventas.anularVentaCompleta).toHaveBeenCalledWith(9, { consultor: tx, descripcion: 'Devolución por venta 9 anulada' });
      expect(resultado).toMatchObject({ estado: 'anulada', anulada: true, stock_devuelto: true });
      expect(resultado.avisos.join(' ')).toContain('no tenía comprobante electrónico');
    });

    it('a/b) comprobante rechazado o histórico: lo marca anulado (nunca DELETE) y avisa que no se anula en SUNAT', async () => {
      const { servicio, repo, tx } = crear();
      repo.principalesDeVenta.mockResolvedValue([
        cabecera({ id_comprobante: 41, estado_sunat: 'RECHAZADO', aceptada_sunat: false, estado: 'error' }),
        cabecera({ id_comprobante: 42, proveedor_fiscal: 'nubefact', ambiente_fiscal: null, id_envio_ultimo: null, envio: null }),
      ]);

      const resultado = await servicio.anularVenta(9, { motivo: 'Error de cobro' }, 1);

      expect(repo.marcarAnulados).toHaveBeenCalledWith(tx, [41, 42], 'Error de cobro');
      expect(resultado.estado).toBe('anulada');
      expect(resultado.avisos.join(' ')).toContain('nunca fue aceptado por SUNAT');
      expect(resultado.avisos.join(' ')).toContain('sistema anterior: no se anula en SUNAT desde aquí');
    });

    it('c) comprobante aceptado: emite la NC 01 total con efecto anular_venta y la venta queda en curso de anulación', async () => {
      const { servicio, solicitudes, ventas } = crear();

      const resultado = await servicio.anularVenta(9, { motivo: 'El cliente desiste' }, 1);

      expect(solicitudes[0]).toMatchObject({ motivo: '01', efecto: 'anular_venta', sustento: 'El cliente desiste', saldo_maximo: 103 });
      expect(resultado).toMatchObject({ estado: 'anulacion_en_curso', anulada: false, nota: { id_comprobante: 70, motivo: '01', numero_formateado: 'FC01-00000002' } });
      expect(ventas.anularVentaCompleta).not.toHaveBeenCalled();
    });

    it('c) si ya hay una nota de anulación en curso, la informa en lugar de emitir otra', async () => {
      const { servicio, emisor } = crear({
        notas: [nota({ id_comprobante: 61, motivo: '01', total: 103, efecto: 'anular_venta', estado: 'pendiente', estado_sunat: 'ENVIANDO', aceptada_sunat: false, efectos_aplicados: false })],
      });
      const resultado = await servicio.anularVenta(9, {}, 1);
      expect(resultado).toMatchObject({ estado: 'anulacion_en_curso', nota: { id_comprobante: 61 } });
      expect(emisor.emitirNotaCredito).not.toHaveBeenCalled();
    });

    it('c) con la emisión inactiva no anula en el sistema: 503 explicando que solo se anula con nota', async () => {
      const { servicio, emision, repo } = crear();
      emision.modo.mockResolvedValue({ activo: false, ambiente: 'produccion', codigo: 'FISCAL_EMISION_INACTIVA', motivo: 'proveedor no activo' } as never);
      const error = await servicio.anularVenta(9, {}, 1).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ServiceUnavailableException);
      expect((error as Error).message).toContain('solo se anula con una nota de crédito');
      expect(repo.transaccion).not.toHaveBeenCalled();
    });

    it('d) boleta con envío incierto: 409 pidiendo verificar en SUNAT; verificado y existente → confirma y emite la nota', async () => {
      const incierta = cabecera({ id_tipo: 2, serie: 'B001', estado_sunat: 'PENDIENTE_REENVIO', aceptada_sunat: false, estado: 'pendiente' });
      const { servicio, repo, emision, solicitudes } = crear({ origen: origenFactura({ id_tipo: 2, serie: 'B001' }) });
      repo.principalesDeVenta.mockResolvedValue([incierta]);

      const error = await servicio.anularVenta(9, {}, 1).catch((e: unknown) => e);
      expect((error as ConflictException).getResponse()).toMatchObject({ codigo: 'ANULACION_REQUIERE_VERIFICACION_SOL', id_comprobante: 40 });
      expect(emision.recuperarCdr).not.toHaveBeenCalled();

      await expect(servicio.anularVenta(9, { confirmar_verificado_sol: true, nota: 'ok' }, 1)).rejects.toThrow('mínimo 5');
      await expect(servicio.anularVenta(9, { confirmar_verificado_sol: true, nota: 'Revisé SOL hoy' }, 1)).rejects.toThrow('existe_en_sunat');

      const resultado = await servicio.anularVenta(9, { confirmar_verificado_sol: true, existe_en_sunat: true, nota: 'Figura aceptada en SOL' }, 1);
      expect(emision.confirmarAceptadoManual).toHaveBeenCalledWith(500, 1, 'Figura aceptada en SOL');
      expect(solicitudes[0]).toMatchObject({ motivo: '01', efecto: 'anular_venta' });
      expect(resultado.estado).toBe('anulacion_en_curso');
    });

    it('d) verificado como inexistente: descarta el envío (auditado) y anula en el sistema en la misma transacción', async () => {
      const incierta = cabecera({ id_tipo: 2, serie: 'B001', estado_sunat: 'ENVIANDO', aceptada_sunat: false, estado: 'pendiente' });
      const { servicio, repo, auditoria, ventas, tx } = crear();
      repo.principalesDeVenta.mockResolvedValue([incierta]);

      const resultado = await servicio.anularVenta(9, { confirmar_verificado_sol: true, existe_en_sunat: false, nota: 'No figura en SOL' }, 1);

      expect(repo.descartarEnvio).toHaveBeenCalledWith(tx, expect.objectContaining({ id_envio: 500, id_comprobante: 40 }));
      expect(auditoria.registrar).toHaveBeenCalledWith(
        expect.objectContaining({ accion: 'ENVIO_DESCARTADO_POR_ANULACION', id_usuario: 1, id_entidad: 500 }),
        tx,
      );
      expect(ventas.anularVentaCompleta).toHaveBeenCalled();
      expect(repo.marcarAnulados).toHaveBeenCalledWith(tx, [40], 'Venta 9 anulada');
      expect(resultado.estado).toBe('anulada');
    });

    it('d) factura de producción: consulta el CDR primero; si SUNAT no la tiene se descarta sin pedir verificación', async () => {
      const incierta = cabecera({ estado_sunat: 'PENDIENTE_REENVIO', aceptada_sunat: false, estado: 'pendiente' });
      const { servicio, repo, emision } = crear();
      repo.principalesDeVenta.mockResolvedValue([incierta]);
      emision.recuperarCdr.mockResolvedValue({ aceptado: false, estado: 'PENDIENTE_REENVIO', accion: 'REINTENTAR', codigo: '0011', mensaje: 'SUNAT no tiene registrado este comprobante' });

      const resultado = await servicio.anularVenta(9, {}, 1);

      expect(emision.recuperarCdr).toHaveBeenCalledWith(500);
      expect(repo.descartarEnvio).toHaveBeenCalled();
      expect(resultado.estado).toBe('anulada');

      // Respuesta no concluyente: 409 para reintentar más tarde, sin anular nada.
      const otra = crear();
      otra.repo.principalesDeVenta.mockResolvedValue([incierta]);
      otra.emision.recuperarCdr.mockResolvedValue({ aceptado: false, estado: 'PENDIENTE_REENVIO', accion: 'REINTENTAR', codigo: '0140', mensaje: 'Servicio no disponible' });
      await expect(otra.servicio.anularVenta(9, {}, 1)).rejects.toMatchObject({ response: { codigo: 'ANULACION_ESTADO_INCIERTO' } });
      expect(otra.repo.transaccion).not.toHaveBeenCalled();
    });
  });

  describe('anular y consultar desde Documentos', () => {
    it('una nota no se anula desde aquí (400); un comprobante con venta activa anula la venta', async () => {
      const deNota = crear({ origen: origenFactura({ id_tipo: 7, serie: 'FC01' }) });
      await expect(deNota.servicio.anularComprobante({ id_comprobante: 40, motivo: 'x' }, 1)).rejects.toBeInstanceOf(BadRequestException);

      const { servicio, solicitudes } = crear();
      const resultado = await servicio.anularComprobante({ serie: 'F001', numero: 12, motivo: 'Cliente desiste' }, 1);
      expect(solicitudes[0]).toMatchObject({ motivo: '01', efecto: 'anular_venta', id_venta: 9 });
      expect(resultado).toMatchObject({ estado: 'anulacion_en_curso', id_comprobante: 40, venta_estado: 'activa', aceptada_sunat: false, numero: 12 });
    });

    it('sin venta (o con la venta ya anulada) se anula solo el comprobante', async () => {
      const { servicio, solicitudes, repo } = crear({ origen: origenFactura({ id_venta: null }) });
      await servicio.anularComprobante({ id_comprobante: 40, motivo: 'Duplicado' }, 1);
      expect(solicitudes[0]).toMatchObject({ id_venta: null, efecto: 'anular_venta' });
      expect(repo.principalesDeVenta).not.toHaveBeenCalled();
    });

    it('consultar anulación: sin anulación, en curso, rechazada y aceptada (aplica efectos pendientes)', async () => {
      const consulta = { tipo_de_comprobante: 1, serie: 'F001', numero: 12 };
      expect(await crear().servicio.consultarAnulacion(consulta)).toMatchObject({ estado: 'sin_anulacion', aceptada_sunat: false });

      const enCurso = crear({ notas: [nota({ motivo: '01', efecto: 'anular_venta', estado: 'pendiente', estado_sunat: 'ENVIANDO', aceptada_sunat: false })] });
      expect(await enCurso.servicio.consultarAnulacion(consulta)).toMatchObject({ estado: 'anulacion_en_curso', nota: { estado: 'pendiente' } });

      const rechazada = crear({ notas: [nota({ motivo: '01', efecto: 'anular_venta', estado: 'error', estado_sunat: 'RECHAZADO', aceptada_sunat: false, mensaje: '2800 - dato inválido' })] });
      expect(await rechazada.servicio.consultarAnulacion(consulta)).toMatchObject({ estado: 'anulacion_rechazada', sunat_description: expect.stringContaining('2800') });

      const aceptada = crear({ notas: [nota({ motivo: '01', efecto: 'anular_venta', efectos_aplicados: false })] });
      expect(await aceptada.servicio.consultarAnulacion(consulta)).toMatchObject({ estado: 'anulada', aceptada_sunat: true });
      expect(aceptada.repo.reclamarEfectos).toHaveBeenCalledWith(expect.anything(), 60);
    });

    it('consultar anulación: aceptada pero con los efectos fallando queda en curso (nunca un 500)', async () => {
      const aceptada = crear({ notas: [nota({ motivo: '01', efecto: 'anular_venta', efectos_aplicados: false })] });
      aceptada.repo.reclamarEfectos.mockRejectedValue(new Error('conexión perdida'));

      const resultado = await aceptada.servicio.consultarAnulacion({ tipo_de_comprobante: 1, serie: 'F001', numero: 12 });

      expect(resultado).toMatchObject({ estado: 'anulacion_en_curso', aceptada_sunat: false, nota: { id_comprobante: 60, aceptada_sunat: true } });
      expect(resultado.sunat_description).toContain('todavía no se actualizaron');
    });

    it('un comprobante ya anulado informa el estado real de su venta', async () => {
      const { servicio, repo } = crear({ origen: origenFactura({ anulado: true }) });
      repo.ventaDeNota.mockResolvedValue(venta({ estado: 'anulada' }));

      expect(await servicio.anularComprobante({ id_comprobante: 40, motivo: 'Duplicado' }, 1)).toMatchObject({
        estado: 'anulada',
        id_venta: 9,
        venta_estado: 'anulada',
      });
      expect(repo.transaccion).not.toHaveBeenCalled();
    });
  });

  describe('anular venta: otros comprobantes, notas en envío y configuración ilegible', () => {
    it('c) los comprobantes que nunca valieron se anulan con la venta cuando SUNAT acepta la nota (el aviso no lo adelanta)', async () => {
      const { servicio, repo, tx } = crear();
      const rechazada = cabecera({ id_comprobante: 41, numero: 11, estado: 'error', estado_sunat: 'RECHAZADO', aceptada_sunat: false });
      repo.principalesDeVenta.mockResolvedValue([cabecera(), rechazada]);

      const resultado = await servicio.anularVenta(9, { motivo: 'El cliente desiste' }, 1);

      expect(resultado.estado).toBe('anulacion_en_curso');
      expect(resultado.avisos[0]).toContain('la venta 9 se anulará cuando SUNAT la acepte');
      expect(resultado.avisos).toContain('F001-00000011 nunca fue aceptado por SUNAT: se anulará en el sistema junto con la venta.');
      expect(resultado.avisos.join(' ')).toContain('Cuando SUNAT acepte la nota, registre en Caja la devolución');
      expect(repo.marcarAnulados).not.toHaveBeenCalled();

      // SUNAT la acepta: el efecto anula la venta y TODOS sus comprobantes vigentes, en la misma transacción.
      repo.reclamarEfectos.mockResolvedValue({
        id_comprobante: 70, serie: 'FC01', numero: 2, motivo: '01', total: 103, efecto: 'anular_venta', reingresar_stock: false, id_venta: 9, id_origen: 40,
      });
      await servicio.aplicarEfectos(70);
      expect(repo.principalesDeVenta).toHaveBeenLastCalledWith(9, tx);
      expect(repo.marcarAnulados).toHaveBeenCalledWith(tx, [40, 41], 'Anulado con la nota de crédito FC01-00000002');
    });

    it('con otra nota en envío no anula en el sistema aunque el saldo ya esté en cero (409, nada cambia)', async () => {
      const enCurso = nota({ total: 103, estado: 'pendiente', estado_sunat: 'ENVIANDO', aceptada_sunat: false, efectos_aplicados: false });
      const { servicio, repo, emisor } = crear({ notas: [enCurso] });

      const error = await servicio.anularVenta(9, {}, 1).catch((e: unknown) => e);

      expect((error as ConflictException).getResponse()).toMatchObject({ codigo: 'NOTA_CREDITO_EN_CURSO', id_comprobante: 60 });
      expect(repo.transaccion).not.toHaveBeenCalled();
      expect(emisor.emitirNotaCredito).not.toHaveBeenCalled();
    });

    it('si no se pudo leer la configuración fiscal no anula nada de emisión directa (503); una venta sin comprobante, sí', async () => {
      const { servicio, repo, emision } = crear();
      emision.modo.mockResolvedValue({
        activo: false,
        ambiente: 'beta',
        codigo: 'FISCAL_LECTURA_ERROR',
        motivo: 'No se pudo leer la configuración de facturación electrónica: la venta se registra sin comprobante. Intente emitirlo en unos segundos.',
      } as never);

      const error = await servicio.anularVenta(9, {}, 1).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ServiceUnavailableException);
      expect((error as Error).message).toBe('No se anuló nada. No se pudo leer la configuración de facturación electrónica. Intente emitirlo en unos segundos.');
      expect(repo.transaccion).not.toHaveBeenCalled();

      repo.principalesDeVenta.mockResolvedValue([]);
      expect((await servicio.anularVenta(9, {}, 1)).estado).toBe('anulada');
    });

    it('aceptada al instante pero sin efectos aplicados: queda en curso con el aviso, nunca un 500', async () => {
      const { servicio, emisor, repo } = crear();
      emisor.emitirNotaCredito.mockResolvedValue({
        id_comprobante: 70, serie: 'FC01', numero: 2, numero_formateado: 'FC01-00000002', estado: 'emitido', estado_sunat: 'ACEPTADO', aceptada_sunat: true,
      });
      repo.reclamarEfectos.mockRejectedValue(new Error('deadlock detected'));

      const resultado = await servicio.anularVenta(9, {}, 1);

      expect(resultado).toMatchObject({ estado: 'anulacion_en_curso', anulada: false, nota: { aceptada_sunat: true } });
      expect(resultado.avisos[0]).toContain('SUNAT aceptó la nota FC01-00000002, pero el stock, la deuda y la anulación todavía no se actualizaron');
    });

    it('a) el primer aviso es el resultado y recuerda devolver en Caja lo cobrado al contado', async () => {
      const { servicio, repo } = crear();
      repo.principalesDeVenta.mockResolvedValue([]);

      const resultado = await servicio.anularVenta(9, {}, 1);

      expect(resultado.avisos[0]).toBe('La venta 9 no tenía comprobante electrónico: se anuló en el sistema.');
      expect(resultado.avisos).toContain('La venta se cobró S/ 103.00 al contado: registre en Caja la devolución que corresponda al cliente (la caja no se mueve sola).');
    });
  });
});

/** La F001-12 tal como la lee el motor de comprobantes (entidad TypeORM). */
function entidadOrigen(parcial: Partial<Record<keyof Comprobante, unknown>> = {}): Comprobante {
  return {
    id_comprobante: 40,
    id_venta: 9,
    tipo: { id_tipo: 1 },
    moneda: { id_moneda: 1 },
    cliente: { id_cliente: 55 },
    serie: 'F001',
    numero: 12,
    cliente_tipo_doc: 6,
    cliente_numero_doc: '20123456789',
    cliente_denominacion: 'FERRETERIA EL MARTILLO S.A.C.',
    cliente_direccion: 'AV. LOS OLIVOS 456',
    cliente_email: '',
    porcentaje_igv: 18,
    total: 103,
    aceptada_sunat: true,
    estado: 'emitido',
    estado_sunat: 'ACEPTADO',
    ambiente_fiscal: 'produccion',
    proveedor_fiscal: 'sunat_directo',
    id_envio_ultimo: 500,
    anulado: false,
    items: [],
    ...parcial,
  } as unknown as Comprobante;
}

describe('directo a SUNAT: la nota se emite y se envía en el acto (motor real + EmisionDirecta simulada)', () => {
  const DEVOLUCION = { motivo: '07', sustento: 'Devolución de un martillo', items: [{ id_item: 401, cantidad: 1 }] };

  /** Negocio de notas sobre el motor de comprobantes REAL; solo la emisión (SUNAT) y la BD son dobles. */
  function crearDirecto() {
    const base = crear();
    const motor = crearMotor({
      bd: crearBdFalsa({ columnas: COLUMNAS_COMPLETAS, maximos: { FC01: [2] } }),
      contexto: CONTEXTO_PRODUCCION,
      findOne: jest.fn().mockResolvedValue(entidadOrigen()),
    });
    const servicio = new NotaCreditoBussnies(base.repo as never, base.ventas as never, motor.servicio, motor.emision as never, base.auditoria as never);
    return { ...base, servicio, motor };
  }

  it('aceptada: 200 «emitido» con lo que dijo SUNAT y los efectos ya aplicados, todo en la misma petición', async () => {
    const { servicio, motor, repo, ventas } = crearDirecto();
    repo.reclamarEfectos.mockResolvedValue({
      id_comprobante: 900, serie: 'FC01', numero: 3, motivo: '07', total: 10.3, efecto: 'devolucion', reingresar_stock: true, id_venta: 9, id_origen: 40,
    });
    repo.lineasDeNota.mockResolvedValue([{ id_producto: 7, codigo: 'MAR-01', cantidad: 1, id_item_origen: 401 }] as never);

    const respuesta = await servicio.emitir(40, DEVOLUCION, 3);

    expect(respuesta).toMatchObject({
      id_comprobante: 900,
      numero_formateado: 'FC01-00000003',
      tipo_de_comprobante: 7,
      id_comprobante_modificado: 40,
      estado: 'emitido',
      aceptada_sunat: true,
      estado_sunat: 'ACEPTADO',
      ambiente_fiscal: 'produccion',
      sunat_description: 'El comprobante ha sido aceptado',
      sunat_responsecode: '0',
      accion_sunat: 'NINGUNA',
      sunat_observaciones: [],
      efecto: 'devolucion',
      efectos_aplicados: true,
    });
    expect(respuesta.avisos[0]).toBe('SUNAT aceptó la nota FC01-00000003.');
    expect(respuesta.avisos).toContain('Las unidades devueltas volvieron al almacén de donde salieron.');
    expect(respuesta.avisos).toContain('Registre en Caja la devolución de S/ 10.30 al cliente (la caja no se mueve sola).');
    // Transacción única (D3) y envío recién después del COMMIT; validarEnTransaccion con la conexión de la transacción.
    const registro = motor.bd.registro;
    expect(posicion(registro, 'tx:lock:nc:40')).toBeLessThan(posicion(registro, 'tx:lock:comprobante:FC01'));
    expect(posicion(registro, 'COMMIT')).toBeLessThan(posicion(registro, 'enviar:501'));
    expect(repo.notasDeOrigen).toHaveBeenLastCalledWith(40, motor.bd.manager);
    expect(ventas.devolverStockParcial).toHaveBeenCalledWith(expect.anything(), 9, [{ id_producto: 7, cantidad: 1 }], expect.objectContaining({ reingresar: true }));
  });

  it('rechazada: 200 con estado «error», el código y el motivo de SUNAT, y sin efectos', async () => {
    const { servicio, motor, repo } = crearDirecto();
    motor.emision.enviarRegistrado.mockResolvedValue(resultadoEmision({
      ambiente: 'produccion',
      estado: 'RECHAZADO',
      aceptado: false,
      codigo: '2800',
      mensaje: '2800 - El dato ingresado en el tipo de documento de identidad del receptor no esta permitido.',
      accion: 'EMITIR_NUEVO',
    }));

    const respuesta = await servicio.emitir(40, DEVOLUCION, 3);

    expect(respuesta).toMatchObject({
      estado: 'error',
      aceptada_sunat: false,
      estado_sunat: 'RECHAZADO',
      sunat_responsecode: '2800',
      accion_sunat: 'EMITIR_NUEVO',
      error: expect.stringContaining('2800'),
      efectos_aplicados: false,
    });
    expect(respuesta.avisos[0]).toBe(
      'SUNAT no aceptó la nota FC01-00000003: 2800 - El dato ingresado en el tipo de documento de identidad del receptor no esta permitido. No se aplicó nada: corrija el problema y emita otra nota.',
    );
    expect(repo.reclamarEfectos).not.toHaveBeenCalled();
  });

  it('incierta: PENDIENTE_REENVIO queda «pendiente» con la acción siguiente y los efectos para cuando SUNAT la acepte', async () => {
    const { servicio, motor, repo } = crearDirecto();
    motor.emision.enviarRegistrado.mockResolvedValue(resultadoEmision({
      ambiente: 'produccion',
      estado: 'PENDIENTE_REENVIO',
      aceptado: false,
      codigo: null,
      mensaje: 'SUNAT no respondió a tiempo: se reintentará el envío.',
      accion: 'REINTENTAR',
    }));

    const respuesta = await servicio.emitir(40, DEVOLUCION, 3);

    expect(respuesta).toMatchObject({ estado: 'pendiente', estado_sunat: 'PENDIENTE_REENVIO', accion_sunat: 'REINTENTAR', efectos_aplicados: false });
    expect(respuesta.avisos[0]).toContain('quedó en envío a SUNAT');
    expect(respuesta.avisos).toContain('Al aceptarse la nota, las unidades devueltas vuelven al almacén de donde salieron.');
    expect(repo.reclamarEfectos).not.toHaveBeenCalled();
  });

  it('si el envío no termina después del COMMIT responde «pendiente» (recuperable), con la forma completa y nunca un 500', async () => {
    const { servicio, motor } = crearDirecto();
    motor.emision.enviarRegistrado.mockRejectedValue(new Error('socket hang up'));

    const respuesta = await servicio.emitir(40, DEVOLUCION, 3);

    expect(respuesta).toMatchObject({
      estado: 'pendiente',
      estado_sunat: 'ENVIANDO',
      aceptada_sunat: false,
      accion_sunat: null,
      sunat_observaciones: [],
      efectos_aplicados: false,
      error: expect.stringContaining('quedó guardado'),
    });
  });

  it('emisión inactiva: 503 con el motivo legible, sin firmar, numerar ni abrir transacción', async () => {
    const { servicio, motor } = crearDirecto();
    motor.emision.modo.mockResolvedValue({
      activo: false,
      ambiente: 'produccion',
      codigo: 'FISCAL_EMISION_BLOQUEADA',
      motivo: 'La emisión está detenida: SUNAT rechazó el usuario SOL (0102). Corrija la causa y reanúdela desde Facturación SUNAT; mientras tanto las ventas se registran sin comprobante.',
    });

    const error = await servicio.emitir(40, DEVOLUCION, 3).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect((error as ServiceUnavailableException).getResponse()).toMatchObject({
      codigo: 'FISCAL_EMISION_BLOQUEADA',
      message: 'No se emitió la nota de crédito. La emisión está detenida: SUNAT rechazó el usuario SOL (0102). Corrija la causa y reanúdela desde Facturación SUNAT.',
    });
    expect(motor.emision.prepararDocumento).not.toHaveBeenCalled();
    expect(motor.bd.registro).not.toContain('BEGIN');
  });

  it('configuración ilegible: 503 aunque el ambiente de respaldo no sea el del comprobante (no un 409 engañoso)', async () => {
    const { servicio, motor } = crearDirecto();
    motor.emision.modo.mockResolvedValue({
      activo: false,
      ambiente: 'beta',
      codigo: 'FISCAL_LECTURA_ERROR',
      motivo: 'No se pudo leer la configuración de facturación electrónica: la venta se registra sin comprobante. Intente emitirlo en unos segundos.',
    });

    await expect(servicio.emitir(40, DEVOLUCION, 3)).rejects.toMatchObject({ status: 503 });
    expect(motor.bd.registro).not.toContain('BEGIN');
  });

  it('el motivo de modo() pierde solo la frase del POS («la venta se registra sin comprobante»)', () => {
    const inactivo = (motivo: string) => motivoEmisionInactiva({ activo: false, ambiente: 'beta', codigo: 'X', motivo });
    expect(inactivo('La emisión de prueba en SUNAT BETA está apagada: la venta se registra sin comprobante. Actívela en Facturación SUNAT para probar.'))
      .toBe('La emisión de prueba en SUNAT BETA está apagada. Actívela en Facturación SUNAT para probar.');
    expect(inactivo('Falta aplicar sql/fase9_sunat_directo.sql en la base de datos: las ventas se registran sin comprobante electrónico.'))
      .toBe('Falta aplicar sql/fase9_sunat_directo.sql en la base de datos.');
    expect(inactivo('Otro motivo sin esa frase.')).toBe('Otro motivo sin esa frase.');
  });
});

describe('banderas de Documentos con el negocio de notas registrado (puede_nota_credito / puede_anular)', () => {
  const ACTIVA: ModoEmision = { activo: true, ambiente: 'produccion' };
  const INACTIVA: ModoEmision = { activo: false, ambiente: 'produccion', codigo: 'FISCAL_EMISION_INACTIVA', motivo: 'La emisión no está activada.' };
  const resumen = (parcial: Partial<ResumenNotasOrigen> = {}): ResumenNotasOrigen => ({ saldo: 50, nota_en_curso: false, anulacion_en_curso: false, ...parcial });

  async function banderas(r: ResumenNotasOrigen | null, modo: ModoEmision = ACTIVA, comprobante: Comprobante = entidadOrigen()) {
    const repo = {
      listar: jest.fn().mockResolvedValue({ datos: [comprobante], total: 1, pagina: 1, por_pagina: 20 }),
      datosListado: jest.fn().mockResolvedValue(new Map()),
    };
    const emision = crearEmisionFalsa(crearBdFalsa(), CONTEXTO_PRODUCCION);
    emision.modo.mockResolvedValue(modo);
    const motor = new ComprobanteBussnies(repo as never, {} as never, {} as never, emision as never);
    motor.registrarGestorNotas({ resumenes: jest.fn(async () => new Map(r ? [[comprobante.id_comprobante, r]] : [])) } as never);
    const { datos } = await motor.listar({});
    return { nota: datos[0].puede_nota_credito, anular: datos[0].puede_anular };
  }

  it('con saldo y la emisión activa: nota de crédito y anular', async () => {
    expect(await banderas(resumen())).toEqual({ nota: true, anular: true });
  });

  it('con otra nota en envío: ni nota ni anular (el saldo todavía puede cambiar)', async () => {
    expect(await banderas(resumen({ nota_en_curso: true }))).toEqual({ nota: false, anular: false });
  });

  it('acreditado por completo: ya no hay nota, pero sí se anula (en el sistema)', async () => {
    expect(await banderas(resumen({ saldo: 0 }))).toEqual({ nota: false, anular: true });
  });

  it('emisión inactiva: no ofrece lo que exige emitir una nota; lo que se anula en el sistema, sí', async () => {
    expect(await banderas(resumen(), INACTIVA)).toEqual({ nota: false, anular: false });
    expect(await banderas(resumen({ saldo: 0 }), INACTIVA)).toEqual({ nota: false, anular: true });
    expect(await banderas(null, INACTIVA, entidadOrigen({ proveedor_fiscal: 'nubefact', ambiente_fiscal: null }))).toEqual({ nota: false, anular: true });
  });
});

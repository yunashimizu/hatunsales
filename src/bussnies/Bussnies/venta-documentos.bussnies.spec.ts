import { Logger, NotFoundException } from '@nestjs/common';
import type { UsuarioToken } from '../../guards/usuario-actual.decorator';
import type { ProductoVendidoGuia } from '../../repository/Repository/guia-remision.repository';
import type {
  ComprobanteDeLaVenta,
  GuiaDeLaVenta,
  VentaDeDocumentos,
  VentaSinComprobanteGuardada,
} from '../../repository/Repository/venta-documentos.repository';
import type { ModoEmision } from '../../sunat/emision/emision.contrato';
import type { ModoEmisionGre } from '../../sunat/gre';
import type { ResumenNotasOrigen } from './nota-credito.contrato';
import { VentaDocumentosBussnies } from './venta-documentos.bussnies';

const ADMIN = { id_usuario: 1, rol: 'admin' } as UsuarioToken;
const VENDEDOR = { id_usuario: 2, rol: 'vendedor' } as UsuarioToken;
const CAJA = { id_usuario: 3, rol: 'cajero' } as UsuarioToken;

const PRODUCCION: ModoEmision = { activo: true, ambiente: 'produccion' };
const BETA: ModoEmision = { activo: true, ambiente: 'beta' };
const BETA_APAGADA: ModoEmision = {
  activo: false,
  ambiente: 'beta',
  codigo: 'FISCAL_BETA_POS_APAGADO',
  motivo: 'La emisión de prueba en SUNAT BETA está apagada: la venta se registra sin comprobante. Actívela en Facturación SUNAT para probar.',
};
const PRODUCCION_INACTIVA: ModoEmision = {
  activo: false,
  ambiente: 'produccion',
  codigo: 'FISCAL_EMISION_INACTIVA',
  motivo: 'La emisión electrónica de producción no está activada: la venta se registra sin comprobante. Actívela en Facturación SUNAT cuando la lista de requisitos esté completa.',
};
const LECTURA_ERROR: ModoEmision = {
  activo: false,
  ambiente: 'beta',
  codigo: 'FISCAL_LECTURA_ERROR',
  motivo: 'No se pudo leer la configuración de facturación electrónica: la venta se registra sin comprobante. Intente emitirlo en unos segundos.',
};
const SIN_BETA_PRODUCCION = 'La emisión electrónica de producción no está activada. Actívela en Facturación SUNAT cuando la lista de requisitos esté completa.';

function venta(parcial: Partial<VentaDeDocumentos> = {}): VentaDeDocumentos {
  return {
    id_venta: 5,
    fecha: '2026-10-24T18:30:00-05:00',
    total: 118,
    estado: 'activa',
    cliente: { nombre: 'ACME SAC', documento: '20100000001' },
    pagos: [{ metodo: 'EFECTIVO', monto: 118 }],
    a_credito: false,
    saldo_cxc: 0,
    cantidad_lineas: 2,
    ...parcial,
  };
}

/** Factura de producción aceptada (o lo que se pise). */
function factura(parcial: Partial<ComprobanteDeLaVenta> = {}): ComprobanteDeLaVenta {
  return {
    id_comprobante: 10,
    id_tipo: 1,
    serie: 'F001',
    numero: 12,
    fecha_de_emision: '24-10-2026',
    cliente_tipo_doc: 6,
    cliente_numero_doc: '20100000001',
    cliente_denominacion: 'ACME SAC',
    id_moneda: 1,
    total: 118,
    porcentaje_igv: 18,
    anulado: false,
    estado: 'emitido',
    estado_sunat: 'ACEPTADO',
    aceptada_sunat: true,
    ambiente_fiscal: 'produccion',
    proveedor_fiscal: 'sunat_directo',
    id_venta: 5,
    id_envio_ultimo: 70,
    envio: { estado: 'ACEPTADO', codigo: '0', accion: 'NINGUNA', libre: true },
    error_mensaje: null,
    sunat_description: 'La Factura numero F001-12, ha sido aceptada',
    motivo_anulacion: null,
    mensaje_envio: null,
    id_comprobante_modificado: null,
    doc_modificado_serie: null,
    doc_modificado_numero: null,
    nota_motivo: null,
    efecto_nota: null,
    efectos_aplicados: null,
    ...parcial,
  };
}

function boleta(parcial: Partial<ComprobanteDeLaVenta> = {}): ComprobanteDeLaVenta {
  return factura({ id_tipo: 2, serie: 'B001', cliente_tipo_doc: 1, cliente_numero_doc: '45678912', ...parcial });
}

function nota(parcial: Partial<ComprobanteDeLaVenta> = {}): ComprobanteDeLaVenta {
  return factura({
    id_comprobante: 30,
    id_tipo: 7,
    serie: 'FC01',
    numero: 3,
    total: 10,
    sunat_description: 'La Nota de Credito numero FC01-3, ha sido aceptada',
    id_comprobante_modificado: 10,
    doc_modificado_serie: 'F001',
    doc_modificado_numero: 12,
    nota_motivo: '07',
    efecto_nota: 'devolucion',
    efectos_aplicados: true,
    ...parcial,
  });
}

function guia(parcial: Partial<GuiaDeLaVenta> = {}): GuiaDeLaVenta {
  return { id_guia: 4, serie: 'T001', numero: 1, estado: 'aceptado', fecha_emision: '2026-10-24', motivo_codigo: '01', motivo_texto: null, ...parcial };
}

const DETALLE = {
  puede_reintentar: false,
  puede_recuperar_cdr: false,
  puede_confirmar_manual: false,
  puede_nota_credito: true,
  puede_anular: true,
  vencido: false,
  fecha_limite_envio: '2026-10-27',
  aviso: null as string | null,
};

const VENDIDO: ProductoVendidoGuia = {
  id_producto: 1,
  id_venta_detalle: 1,
  cantidad_vendida: 2,
  cantidad_en_guias: 1,
  nombre: 'Martillo',
  codigo: 'A-1',
  unidad_medida: 'NIU',
};

interface Escenario {
  venta?: VentaDeDocumentos | null;
  comprobantes?: ComprobanteDeLaVenta[];
  guias?: GuiaDeLaVenta[];
  modo?: ModoEmision;
  notasHabilitadas?: boolean;
  vendidos?: ProductoVendidoGuia[] | Error;
  detalles?: Record<number, Partial<typeof DETALLE> | Error>;
  resumenes?: Record<number, ResumenNotasOrigen>;
  modoGre?: ModoEmisionGre;
}

function crear(e: Escenario = {}) {
  const repo = {
    venta: jest.fn(async () => (e.venta === undefined ? venta() : e.venta)),
    comprobantes: jest.fn(async () => e.comprobantes ?? [factura()]),
    guias: jest.fn(async () => e.guias ?? []),
    notasCreditoHabilitadas: jest.fn(async () => e.notasHabilitadas ?? true),
    sinComprobante: jest.fn(),
  };
  const comprobantes = {
    obtenerDetalle: jest.fn(async (id: number) => {
      const propio = e.detalles?.[id];
      if (propio instanceof Error) throw propio;
      return { ...DETALLE, ...propio };
    }),
  };
  const notas = {
    resumenes: jest.fn(async (ids: number[]) =>
      new Map(ids.filter((id) => e.resumenes?.[id]).map((id): [number, ResumenNotasOrigen] => [id, e.resumenes![id]])),
    ),
  };
  const guiasRepo = {
    productosVendidos: jest.fn(async () => {
      if (e.vendidos instanceof Error) throw e.vendidos;
      return e.vendidos ?? [VENDIDO];
    }),
  };
  const emision = { modo: jest.fn(async () => e.modo ?? PRODUCCION) };
  const emisionGre = { modo: jest.fn(async () => e.modoGre ?? ({ activo: true } as ModoEmisionGre)) };
  const negocio = new VentaDocumentosBussnies(
    repo as never,
    comprobantes as never,
    notas as never,
    guiasRepo as never,
    emision as never,
    emisionGre as never,
  );
  return { negocio, repo, comprobantes, notas, guiasRepo, emision, emisionGre };
}

beforeAll(() => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});

afterAll(() => jest.restoreAllMocks());

describe('VentaDocumentosBussnies.documentos (GET /venta/:id/documentos)', () => {
  it('404 con código claro si la venta no existe, sin leer nada más', async () => {
    const { negocio, repo, comprobantes } = crear({ venta: null });

    const error = await negocio.documentos(99, ADMIN).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(NotFoundException);
    expect((error as NotFoundException).getResponse()).toMatchObject({ message: 'No existe la venta 99.', codigo: 'VENTA_NO_ENCONTRADA' });
    expect(repo.comprobantes).not.toHaveBeenCalled();
    expect(comprobantes.obtenerDetalle).not.toHaveBeenCalled();
  });

  it('venta con factura aceptada, nota de crédito y guía: forma completa del contrato, una lectura por tipo de documento', async () => {
    const { negocio, repo, comprobantes, notas } = crear({
      comprobantes: [nota(), factura()],
      guias: [guia(), guia({ id_guia: 2, serie: null, numero: null, estado: 'legacy', fecha_emision: null, motivo_codigo: null, motivo_texto: 'VENTA' })],
      resumenes: { 10: { saldo: 108, nota_en_curso: false, anulacion_en_curso: false } },
    });

    const r = await negocio.documentos(5, ADMIN);

    expect(r.venta).toEqual({
      id: 5,
      fecha: '2026-10-24T18:30:00-05:00',
      total: 118,
      estado: 'activa',
      cliente: { nombre: 'ACME SAC', documento: '20100000001' },
      pagos: [{ metodo: 'EFECTIVO', monto: 118 }],
      a_credito: false,
      saldo_cxc: 0,
    });
    expect(r.comprobante).toEqual({
      id_comprobante: 10,
      id_tipo: 1,
      tipo_nombre: 'FACTURA ELECTRONICA',
      serie: 'F001',
      numero: 12,
      numero_formateado: 'F001-00000012',
      fecha_de_emision: '24-10-2026',
      total: 118,
      estado: 'emitido',
      anulado: false,
      estado_sunat: 'ACEPTADO',
      ambiente_fiscal: 'produccion',
      accion_sunat: 'NINGUNA',
      mensaje: 'La Factura numero F001-12, ha sido aceptada',
      puede_reintentar: false,
      puede_recuperar_cdr: false,
      puede_confirmar_manual: false,
      puede_nota_credito: true,
      puede_anular: true,
    });
    expect(r.comprobantes_anteriores).toEqual([]);
    expect(r.notas).toEqual([
      {
        id_comprobante: 30,
        serie: 'FC01',
        numero: 3,
        numero_formateado: 'FC01-00000003',
        motivo: '07',
        motivo_nombre: 'DEVOLUCION POR ITEM',
        total: 10,
        estado: 'emitido',
        anulado: false,
        estado_sunat: 'ACEPTADO',
        efecto: 'devolucion',
        efectos_aplicados: true,
        doc_modificado: 'F001-00000012',
      },
    ]);
    expect(r.guias).toEqual([
      {
        id_guia: 4,
        serie: 'T001',
        numero: 1,
        numero_formateado: 'T001-00000001',
        estado: 'aceptado',
        estado_texto: 'Aceptada',
        fecha_emision: '2026-10-24',
        motivo: '01',
        motivo_nombre: 'Venta',
      },
      // Guía anterior a la GRE directa: solo lectura y con su motivo en texto libre.
      {
        id_guia: 2,
        serie: null,
        numero: null,
        numero_formateado: null,
        estado: 'legacy',
        estado_texto: 'Histórica (solo lectura)',
        fecha_emision: null,
        motivo: null,
        motivo_nombre: 'VENTA',
      },
    ]);
    expect(r.acciones).toEqual({
      emitir_comprobante: { permitido: false, motivo: 'La venta 5 ya tiene el comprobante F001-00000012. No se emite otro para no duplicarlo.' },
      nota_credito: { permitido: true },
      guia: { permitido: true },
      anular: { permitido: true, motivo: 'Se emitirá una nota de crédito que anula F001-00000012: la venta se anulará cuando SUNAT la acepte.' },
    });
    expect(r.avisos).toEqual([]);

    expect(repo.comprobantes).toHaveBeenCalledTimes(1);
    expect(repo.guias).toHaveBeenCalledTimes(1);
    // Las banderas son las de Documentos: el detalle de la factura (no el de la nota).
    expect(comprobantes.obtenerDetalle).toHaveBeenCalledTimes(1);
    expect(comprobantes.obtenerDetalle).toHaveBeenCalledWith(10);
    expect(notas.resumenes).toHaveBeenCalledWith([10]);
  });

  it('sin comprobante y con la emisión de prueba apagada: no se puede emitir y el aviso dice por qué (sin la frase del POS)', async () => {
    const { negocio, comprobantes, emisionGre } = crear({ comprobantes: [], modo: BETA_APAGADA, modoGre: { activo: false, codigo: 'GRE_SIN_BETA', motivo: 'La GRE no tiene ambiente de pruebas en SUNAT: solo se puede validar sin enviar.' } });

    const r = await negocio.documentos(5, ADMIN);

    const motivo = 'La emisión de prueba en SUNAT BETA está apagada. Actívela en Facturación SUNAT para probar.';
    expect(r.comprobante).toBeNull();
    expect(r.acciones.emitir_comprobante).toEqual({ permitido: false, motivo });
    expect(r.acciones.nota_credito).toEqual({ permitido: false, motivo: 'La venta no tiene factura ni boleta vigente: la nota de crédito se emite sobre ella.' });
    expect(r.acciones.anular).toEqual({ permitido: true });
    // El borrador de la guía se puede crear aunque la GRE no se pueda emitir: se advierte.
    expect(r.acciones.guia).toEqual({
      permitido: true,
      motivo: 'Podrá guardar la guía como borrador y validarla, pero todavía no emitirla a SUNAT. La GRE no tiene ambiente de pruebas en SUNAT: solo se puede validar sin enviar.',
    });
    expect(r.avisos).toEqual([`La venta no tiene comprobante electrónico vigente. ${motivo}`]);
    expect(comprobantes.obtenerDetalle).not.toHaveBeenCalled();
    expect(emisionGre.modo).toHaveBeenCalledTimes(1);
  });

  it('sin comprobante y con la emisión activa: se ofrece «Emitir comprobante»; sin líneas guardadas, no', async () => {
    const conLineas = await crear({ comprobantes: [] }).negocio.documentos(5, CAJA);
    expect(conLineas.acciones.emitir_comprobante).toEqual({ permitido: true });
    expect(conLineas.avisos).toEqual(['La venta no tiene comprobante electrónico vigente: emítalo con «Emitir comprobante».']);

    const sinLineas = await crear({ comprobantes: [], venta: venta({ cantidad_lineas: 0 }) }).negocio.documentos(5, CAJA);
    expect(sinLineas.acciones.emitir_comprobante).toEqual({
      permitido: false,
      motivo: 'La venta 5 no tiene productos registrados para emitir su comprobante.',
    });
  });

  it('venta anulada: ninguna acción y sin el aviso de «sin comprobante»', async () => {
    const { negocio, emisionGre } = crear({ venta: venta({ estado: 'anulada' }), comprobantes: [factura({ anulado: true, motivo_anulacion: 'Venta 5 anulada' })] });

    const r = await negocio.documentos(5, ADMIN);

    expect(r.comprobante).toBeNull();
    expect(r.comprobantes_anteriores).toEqual([
      expect.objectContaining({ id_comprobante: 10, anulado: true, mensaje: 'Venta 5 anulada', puede_anular: false, puede_nota_credito: false }),
    ]);
    expect(r.acciones).toEqual({
      emitir_comprobante: { permitido: false, motivo: 'La venta 5 está anulada: no se le emite comprobante.' },
      nota_credito: { permitido: false, motivo: 'La venta no tiene factura ni boleta vigente: la nota de crédito se emite sobre ella.' },
      guia: { permitido: false, motivo: 'La venta 5 está anulada: no se le pueden emitir guías.' },
      anular: { permitido: false, motivo: 'La venta 5 ya está anulada.' },
    });
    expect(r.avisos).toEqual([]);
    expect(emisionGre.modo).not.toHaveBeenCalled();
  });

  it('historial: la boleta rechazada va a «anteriores» con sus banderas de Documentos; la anulada sin leer su detalle', async () => {
    const rechazada = boleta({
      id_comprobante: 8,
      numero: 3,
      estado: 'error',
      estado_sunat: 'RECHAZADO',
      aceptada_sunat: false,
      error_mensaje: '2800 - El dato ingresado en el tipo de documento de identidad del receptor no esta permitido.',
      envio: { estado: 'RECHAZADO', codigo: '2800', accion: 'EMITIR_NUEVO', libre: true },
    });
    const anulada = boleta({ id_comprobante: 7, numero: 2, anulado: true, motivo_anulacion: 'Error en el RUC' });
    const vigente = boleta({ id_comprobante: 9, numero: 4 });
    const { negocio, comprobantes } = crear({
      comprobantes: [vigente, rechazada, anulada],
      detalles: { 8: { puede_nota_credito: false, puede_anular: true } },
    });

    const r = await negocio.documentos(5, ADMIN);

    expect(r.comprobante?.id_comprobante).toBe(9);
    expect(r.comprobantes_anteriores.map((c) => [c.id_comprobante, c.estado, c.accion_sunat, c.mensaje, c.puede_anular])).toEqual([
      [8, 'error', 'EMITIR_NUEVO', '2800 - El dato ingresado en el tipo de documento de identidad del receptor no esta permitido.', true],
      [7, 'emitido', 'NINGUNA', 'Error en el RUC', false],
    ]);
    expect(comprobantes.obtenerDetalle.mock.calls.map((c) => c[0]).sort()).toEqual([8, 9]);
  });

  it('si el detalle de Documentos no se puede leer: sin acciones del comprobante y con aviso, pero el panel responde', async () => {
    const { negocio } = crear({ detalles: { 10: new Error('timeout') } });

    const r = await negocio.documentos(5, VENDEDOR);

    expect(r.comprobante).toMatchObject({ puede_nota_credito: false, puede_anular: false, puede_reintentar: false });
    expect(r.acciones.nota_credito).toEqual({ permitido: false, motivo: 'No se pudo comprobar si F001-00000012 admite nota de crédito: ábralo en Documentos.' });
    expect(r.avisos).toEqual(['No se pudieron leer las acciones de F001-00000012: ábralo en Documentos.']);
  });

  describe('nota de crédito: la decide puede_nota_credito y el motivo dice la primera causa', () => {
    it.each<[string, Escenario, UsuarioToken, string]>([
      ['caja no emite notas', {}, CAJA, 'Solo un administrador o un vendedor puede emitir notas de crédito.'],
      ['sin fase14', { notasHabilitadas: false }, VENDEDOR, 'Aplique sql/fase14_notas_credito_enlace.sql para habilitar las notas de crédito.'],
      [
        'histórico',
        { comprobantes: [factura({ proveedor_fiscal: 'nubefact', ambiente_fiscal: null, estado_sunat: null })], detalles: { 10: { puede_nota_credito: false } } },
        VENDEDOR,
        'F001-00000012 se emitió con el sistema anterior: su nota de crédito no se emite desde aquí (la venta se anula en el sistema).',
      ],
      [
        'otro ambiente',
        { comprobantes: [factura({ ambiente_fiscal: 'beta', serie: 'FB01' })], detalles: { 10: { puede_nota_credito: false } } },
        VENDEDOR,
        'FB01-00000012 se emitió en SUNAT BETA (pruebas) y el ambiente vigente es PRODUCCIÓN: se anula en el sistema, sin nota de crédito.',
      ],
      [
        'todavía no aceptado',
        { comprobantes: [factura({ estado: 'pendiente', estado_sunat: 'PENDIENTE_REENVIO', aceptada_sunat: false })], detalles: { 10: { puede_nota_credito: false } } },
        VENDEDOR,
        'F001-00000012 todavía no está aceptado por SUNAT: la nota de crédito solo se emite sobre comprobantes aceptados.',
      ],
      [
        'emisión inactiva',
        { modo: PRODUCCION_INACTIVA, detalles: { 10: { puede_nota_credito: false } } },
        VENDEDOR,
        SIN_BETA_PRODUCCION,
      ],
      [
        'otra nota en envío',
        {
          comprobantes: [factura(), nota({ estado: 'pendiente', estado_sunat: 'ENVIANDO', aceptada_sunat: false })],
          detalles: { 10: { puede_nota_credito: false } },
          resumenes: { 10: { saldo: 108, nota_en_curso: true, anulacion_en_curso: false } },
        },
        ADMIN,
        'La nota FC01-00000003 todavía se está enviando a SUNAT: espere su resultado antes de emitir otra.',
      ],
      [
        'sin saldo',
        { detalles: { 10: { puede_nota_credito: false } }, resumenes: { 10: { saldo: 0, nota_en_curso: false, anulacion_en_curso: false } } },
        ADMIN,
        'F001-00000012 ya se acreditó por completo con notas de crédito.',
      ],
    ])('%s', async (_caso, escenario, usuario, motivo) => {
      const r = await crear(escenario).negocio.documentos(5, usuario);
      expect(r.acciones.nota_credito).toEqual({ permitido: false, motivo });
    });
  });

  describe('guía: venta activa con cantidades sin guía (tope de G2); el borrador no exige la GRE', () => {
    it.each<[string, Escenario, UsuarioToken, string]>([
      ['caja no crea guías', {}, CAJA, 'Solo un administrador o un vendedor puede crear guías de remisión.'],
      ['sin productos', { vendidos: [] }, VENDEDOR, 'La venta no tiene productos para trasladar.'],
      [
        'todo en guías',
        { vendidos: [{ ...VENDIDO, cantidad_vendida: 2.5, cantidad_en_guias: 2.5 }] },
        VENDEDOR,
        'Todo lo vendido ya está en guías vigentes (borradores o emitidas): anule una para volver a usar sus cantidades.',
      ],
      ['no se pudo leer lo pendiente', { vendidos: new Error('conexión') }, VENDEDOR, 'No se pudo comprobar lo que falta entregar de la venta: vuelva a intentarlo en unos segundos.'],
    ])('%s', async (_caso, escenario, usuario, motivo) => {
      const { negocio, emisionGre } = crear(escenario);
      const r = await negocio.documentos(5, usuario);
      expect(r.acciones.guia).toEqual({ permitido: false, motivo });
      expect(emisionGre.modo).not.toHaveBeenCalled();
    });

    it('con algo pendiente y la GRE activa: permitido sin advertencia', async () => {
      const r = await crear({ vendidos: [{ ...VENDIDO, cantidad_vendida: 0.3, cantidad_en_guias: 0.2 }] }).negocio.documentos(5, VENDEDOR);
      expect(r.acciones.guia).toEqual({ permitido: true });
    });
  });

  describe('anular: solo un administrador, con las ramas de D9', () => {
    const aceptadaConSaldo = { 10: { saldo: 118, nota_en_curso: false, anulacion_en_curso: false } };
    it.each<[string, Escenario, UsuarioToken, { permitido: boolean; motivo?: string }]>([
      ['un vendedor no anula', {}, VENDEDOR, { permitido: false, motivo: 'Solo un administrador puede anular la venta.' }],
      ['sin comprobante: en el sistema', { comprobantes: [] }, ADMIN, { permitido: true }],
      [
        'aceptada: con nota de crédito',
        { resumenes: aceptadaConSaldo },
        ADMIN,
        { permitido: true, motivo: 'Se emitirá una nota de crédito que anula F001-00000012: la venta se anulará cuando SUNAT la acepte.' },
      ],
      [
        'aceptada con la emisión inactiva',
        { modo: PRODUCCION_INACTIVA, resumenes: aceptadaConSaldo },
        ADMIN,
        { permitido: false, motivo: `F001-00000012 ya fue aceptado por SUNAT y solo se anula con una nota de crédito, que no se puede emitir ahora. ${SIN_BETA_PRODUCCION}` },
      ],
      [
        'aceptada sin fase14',
        { notasHabilitadas: false },
        ADMIN,
        {
          permitido: false,
          motivo: 'F001-00000012 ya fue aceptado por SUNAT y solo se anula con una nota de crédito. Aplique sql/fase14_notas_credito_enlace.sql para habilitar las notas de crédito.',
        },
      ],
      [
        'anulación ya en curso',
        { resumenes: { 10: { saldo: 0, nota_en_curso: true, anulacion_en_curso: true } } },
        ADMIN,
        { permitido: false, motivo: 'La nota de crédito que anula F001-00000012 sigue en envío a SUNAT: la venta se anulará cuando SUNAT la acepte.' },
      ],
      [
        'otra nota en envío',
        { resumenes: { 10: { saldo: 108, nota_en_curso: true, anulacion_en_curso: false } } },
        ADMIN,
        { permitido: false, motivo: 'Una nota de crédito de F001-00000012 todavía se está enviando a SUNAT: espere su resultado antes de anular la venta.' },
      ],
      [
        'ya acreditada por completo',
        { resumenes: { 10: { saldo: 0, nota_en_curso: false, anulacion_en_curso: false } } },
        ADMIN,
        { permitido: true, motivo: 'F001-00000012 ya está acreditado por completo con notas de crédito: la venta se anulará en el sistema.' },
      ],
      [
        'dos aceptadas',
        { comprobantes: [factura(), boleta({ id_comprobante: 11 })] },
        ADMIN,
        { permitido: false, motivo: 'La venta tiene más de un comprobante aceptado por SUNAT (F001-00000012, B001-00000012): anúlelos uno por uno desde Documentos.' },
      ],
      [
        'boleta BETA sin confirmar: verificar en SUNAT',
        {
          modo: BETA,
          comprobantes: [boleta({ serie: 'BB01', ambiente_fiscal: 'beta', estado: 'pendiente', estado_sunat: 'PENDIENTE_REENVIO', aceptada_sunat: false, envio: { estado: 'PENDIENTE_REENVIO', codigo: '1033', accion: 'RECUPERAR_CDR', libre: true } })],
        },
        ADMIN,
        { permitido: true, motivo: 'El envío de BB01-00000012 a SUNAT quedó sin confirmar: al anular se le pedirá que verifique en SUNAT Operaciones en Línea si existe.' },
      ],
      [
        'factura de producción sin confirmar: se consulta primero',
        { comprobantes: [factura({ estado: 'pendiente', estado_sunat: 'ENVIANDO', aceptada_sunat: false, envio: { estado: 'ENVIANDO', codigo: null, accion: null, libre: true } })] },
        ADMIN,
        { permitido: true, motivo: 'El envío de F001-00000012 a SUNAT quedó sin confirmar: al anular, primero se consultará su estado en SUNAT.' },
      ],
      [
        'histórica: en el sistema',
        { comprobantes: [factura({ serie: 'FFF1', proveedor_fiscal: 'nubefact', ambiente_fiscal: null, estado_sunat: null, id_envio_ultimo: null, envio: null })] },
        ADMIN,
        { permitido: true, motivo: 'FFF1-00000012 se emitió con el sistema anterior: no se anula en SUNAT desde aquí, se anulará en el sistema junto con la venta.' },
      ],
      [
        'rechazada: en el sistema',
        { comprobantes: [boleta({ estado: 'error', estado_sunat: 'RECHAZADO', aceptada_sunat: false })] },
        ADMIN,
        { permitido: true, motivo: 'B001-00000012 nunca fue aceptado por SUNAT: se anulará en el sistema junto con la venta.' },
      ],
      [
        'configuración ilegible con comprobantes directos',
        { modo: LECTURA_ERROR },
        ADMIN,
        { permitido: false, motivo: 'No se puede anular ahora. No se pudo leer la configuración de facturación electrónica. Intente emitirlo en unos segundos.' },
      ],
    ])('%s', async (_caso, escenario, usuario, esperado) => {
      const r = await crear(escenario).negocio.documentos(5, usuario);
      expect(r.acciones.anular).toEqual(esperado);
    });
  });

  describe('avisos', () => {
    it('BETA, envío sin respuesta con la acción siguiente de Documentos', async () => {
      const r = await crear({
        modo: BETA,
        comprobantes: [boleta({ serie: 'BB01', ambiente_fiscal: 'beta', estado: 'pendiente', estado_sunat: 'PENDIENTE_REENVIO', aceptada_sunat: false })],
        detalles: { 10: { aviso: 'Prueba SUNAT BETA: sin validez tributaria.', puede_reintentar: true, puede_nota_credito: false } },
      }).negocio.documentos(5, ADMIN);

      expect(r.avisos).toEqual([
        'Prueba SUNAT BETA: sin validez tributaria.',
        'BB01-00000012 todavía no tiene la respuesta de SUNAT: reintente el envío desde Documentos.',
      ]);
    });

    it.each<[string, Partial<typeof DETALLE>, string]>([
      ['confirmar', { puede_confirmar_manual: true, puede_recuperar_cdr: true }, 'verifique en SUNAT Operaciones en Línea si existe y confírmelo en Documentos'],
      ['recuperar', { puede_recuperar_cdr: true }, 'recupere la constancia (CDR) desde Documentos'],
      ['en curso', {}, 'espere unos minutos y vuelva a revisar'],
    ])('envío sin respuesta (%s)', async (_caso, banderas, siguiente) => {
      const r = await crear({
        comprobantes: [factura({ estado: 'pendiente', estado_sunat: 'ENVIANDO', aceptada_sunat: false })],
        detalles: { 10: { ...banderas, puede_nota_credito: false } },
      }).negocio.documentos(5, ADMIN);
      expect(r.avisos).toEqual([`F001-00000012 todavía no tiene la respuesta de SUNAT: ${siguiente}.`]);
    });

    it('fuera de plazo: la factura pide un comprobante nuevo y la boleta el resumen diario', async () => {
      const facturaVencida = await crear({
        comprobantes: [factura({ estado: 'pendiente', estado_sunat: 'PENDIENTE_REENVIO', aceptada_sunat: false })],
        detalles: { 10: { vencido: true, fecha_limite_envio: '2026-10-20', puede_nota_credito: false } },
      }).negocio.documentos(5, ADMIN);
      expect(facturaVencida.avisos).toEqual(['Venció el plazo para enviar F001-00000012 a SUNAT (vencía el 20/10/2026): emita un comprobante nuevo.']);

      const boletaVencida = await crear({
        comprobantes: [boleta({ estado: 'pendiente', estado_sunat: 'PENDIENTE_REENVIO', aceptada_sunat: false })],
        detalles: { 10: { vencido: true, fecha_limite_envio: '2026-10-20', puede_nota_credito: false } },
      }).negocio.documentos(5, ADMIN);
      expect(boletaVencida.avisos).toEqual([
        'Venció el plazo de envío individual de B001-00000012 (vencía el 20/10/2026): informe la boleta en SUNAT con el resumen diario.',
      ]);
    });

    it('notas: la que anula la venta en envío, aceptada con efectos pendientes y rechazada', async () => {
      const r = await crear({
        comprobantes: [
          factura(),
          nota({ id_comprobante: 31, numero: 4, nota_motivo: '01', efecto_nota: 'anular_venta', efectos_aplicados: false, estado: 'pendiente', estado_sunat: 'ENVIANDO', aceptada_sunat: false }),
          nota({ id_comprobante: 30, numero: 3, efectos_aplicados: false }),
          nota({ id_comprobante: 29, numero: 2, estado: 'error', estado_sunat: 'RECHAZADO', aceptada_sunat: false, error_mensaje: '2116 - El tipo de nota no corresponde' }),
        ],
        resumenes: { 10: { saldo: 108, nota_en_curso: true, anulacion_en_curso: true } },
      }).negocio.documentos(5, ADMIN);

      expect(r.notas.map((n) => n.id_comprobante)).toEqual([29, 30, 31]);
      expect(r.avisos).toEqual([
        'SUNAT rechazó la nota FC01-00000002 (2116 - El tipo de nota no corresponde): no se aplicó nada y puede emitir otra.',
        'SUNAT aceptó la nota FC01-00000003, pero el stock, la deuda y la anulación todavía no se actualizaron: se reintentará en unos minutos.',
        'La nota de crédito FC01-00000004 que anula la venta sigue en envío a SUNAT: la venta se anulará cuando SUNAT la acepte.',
      ]);
    });

    it('guías: en proceso, pendiente, rechazada y borradores', async () => {
      const r = await crear({
        guias: [
          guia({ id_guia: 1, estado: 'enviado' }),
          guia({ id_guia: 2, numero: 2, estado: 'pendiente' }),
          guia({ id_guia: 3, numero: 3, estado: 'rechazado' }),
          guia({ id_guia: 4, serie: null, numero: null, estado: 'borrador', fecha_emision: null }),
          guia({ id_guia: 5, serie: null, numero: null, estado: 'borrador', fecha_emision: null }),
        ],
      }).negocio.documentos(5, ADMIN);

      expect(r.guias.map((g) => g.estado_texto)).toEqual(['Enviada a SUNAT', 'Pendiente de envío', 'Rechazada', 'Borrador', 'Borrador']);
      expect(r.avisos).toEqual([
        'SUNAT todavía está procesando la guía T001-00000001: revise su resultado en Guías («Consultar»).',
        'La guía T001-00000002 quedó pendiente de envío a SUNAT: vuelva a emitirla desde Guías.',
        'SUNAT rechazó la guía T001-00000003: corríjala y vuelva a emitirla desde Guías.',
        'Hay 2 guías en borrador: todavía no se emitieron a SUNAT.',
      ]);
    });

    it('comprobante con error en revisión (pudo llegar a SUNAT) y dos vigentes: cuenta el primero y se avisa', async () => {
      const enRevision = factura({
        id_comprobante: 6,
        numero: 9,
        estado: 'error',
        estado_sunat: 'EXCEPCION',
        aceptada_sunat: false,
        error_mensaje: 'La constancia (CDR) no corresponde al comprobante enviado',
        envio: { estado: 'EXCEPCION', codigo: null, accion: 'NINGUNA', libre: true },
      });
      const r = await crear({
        comprobantes: [boleta({ id_comprobante: 12, numero: 13 }), factura(), enRevision],
        detalles: { 6: { puede_nota_credito: false } },
      }).negocio.documentos(5, ADMIN);

      expect(r.comprobante?.id_comprobante).toBe(10);
      expect(r.comprobantes_anteriores.map((c) => c.id_comprobante)).toEqual([12, 6]);
      expect(r.avisos).toEqual([
        'La venta tiene más de un comprobante vigente (F001-00000012, B001-00000013): anule desde Documentos el que sobra.',
        'F001-00000009 quedó en revisión (La constancia (CDR) no corresponde al comprobante enviado): verifique en SUNAT Operaciones en Línea que no exista antes de emitir otro comprobante.',
      ]);
    });
  });
});

describe('VentaDocumentosBussnies.sinComprobante (GET /venta/sin-comprobante)', () => {
  function fila(parcial: Partial<VentaSinComprobanteGuardada> = {}): VentaSinComprobanteGuardada {
    return {
      id_venta: 33,
      fecha: '2026-10-24T18:30:00-05:00',
      total: 59,
      cliente: { nombre: 'ACME SAC', documento: '20100000001' },
      ultimo: null,
      ...parcial,
    };
  }

  it('el último motivo: error o anulación del último comprobante; sin ninguno, por qué la emisión no está activa', async () => {
    const { negocio, repo } = crear({ modo: BETA_APAGADA });
    repo.sinComprobante.mockResolvedValue({
      filas: [
        fila({ ultimo: { serie: 'B001', numero: 3, anulado: false, mensaje: '2800 - Documento del receptor no permitido' } }),
        fila({ id_venta: 32, ultimo: { serie: 'F001', numero: 7, anulado: true, mensaje: 'Error en el RUC' } }),
        fila({ id_venta: 31, ultimo: { serie: 'B001', numero: 2, anulado: false, mensaje: null } }),
        fila({ id_venta: 30, cliente: { nombre: 'CLIENTES VARIOS', documento: null } }),
      ],
      total: 41,
      pagina: 2,
      por_pagina: 4,
    });
    const filtro = { desde: '2026-10-01', hasta: '2026-10-24', pagina: 2, por_pagina: 4 };

    const r = await negocio.sinComprobante(filtro);

    expect(repo.sinComprobante).toHaveBeenCalledWith(filtro);
    expect(r).toEqual({
      datos: [
        { id_venta: 33, fecha: '2026-10-24T18:30:00-05:00', total: 59, cliente: 'ACME SAC', documento_cliente: '20100000001', ultimo_error: 'B001-00000003: 2800 - Documento del receptor no permitido' },
        { id_venta: 32, fecha: '2026-10-24T18:30:00-05:00', total: 59, cliente: 'ACME SAC', documento_cliente: '20100000001', ultimo_error: 'F001-00000007 se anuló: Error en el RUC' },
        { id_venta: 31, fecha: '2026-10-24T18:30:00-05:00', total: 59, cliente: 'ACME SAC', documento_cliente: '20100000001', ultimo_error: 'B001-00000002 no fue aceptado por SUNAT.' },
        {
          id_venta: 30,
          fecha: '2026-10-24T18:30:00-05:00',
          total: 59,
          cliente: 'CLIENTES VARIOS',
          documento_cliente: null,
          ultimo_error: 'La emisión de prueba en SUNAT BETA está apagada. Actívela en Facturación SUNAT para probar.',
        },
      ],
      total: 41,
      pagina: 2,
      por_pagina: 4,
    });
  });

  it('con la emisión activa, una venta que nunca tuvo comprobante no inventa un motivo', async () => {
    const { negocio, repo } = crear({ modo: PRODUCCION });
    repo.sinComprobante.mockResolvedValue({ filas: [fila()], total: 1, pagina: 1, por_pagina: 20 });

    const r = await negocio.sinComprobante({});

    expect(r.datos[0].ultimo_error).toBeNull();
  });
});

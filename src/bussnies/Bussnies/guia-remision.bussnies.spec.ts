import { ServiceUnavailableException } from '@nestjs/common';
import { createHash } from 'crypto';
import { UbigeoService } from '../../catalogos/ubigeo/ubigeo.service';
import type { GuardarGuiaRemisionRequest } from '../../models/model/guia-remision.request';
import {
  CierreConsultaGuia,
  CierreEnvioGuia,
  EnvioGuia,
  FilaGuia,
  FilaItemGuia,
  NumeroGuiaOcupadoError,
  ProductoVendidoGuia,
  RegistroEmisionGuia,
  VentaGuia,
} from '../../repository/Repository/guia-remision.repository';
import { RelojFiscal } from '../../sunat/config/reloj-fiscal';
import type { DocumentoGre, GrePreparada, ResultadoConsultaGre, ResultadoEnvioGre } from '../../sunat/gre';
import { validarDocumentoGre } from '../../sunat/gre/validaciones-gre';
import { REMITENTE_GRE_PRUEBA } from '../../sunat/gre/pruebas/documentos-gre-prueba-spec';
import { ENLACE_QR_PRUEBA } from '../../sunat/gre/pruebas/respuestas-gre-prueba-spec';
import {
  campoFormularioGuia,
  ESPERA_CONSULTA_INMEDIATA_MS,
  ESPERAS_CONSULTA_SEG,
  GuiaRemisionBussnies,
  MAXIMO_CONSULTAS_AUTOMATICAS,
  MENSAJE_GUIA_EN_PROCESO,
  MENSAJE_GUIA_EN_PROCESO_MANUAL,
  PLAZO_CONSULTA_INMEDIATA_MS,
} from './guia-remision.bussnies';

/** 10:00:00 en Lima. */
const AHORA = new Date('2026-10-22T15:00:00Z');

class RelojPrueba extends RelojFiscal {
  ahora(): Date {
    return AHORA;
  }
}

function fila(cambios: Partial<FilaGuia> = {}): FilaGuia {
  return {
    id_guia: 7,
    id_venta: 10,
    id_comprobante: 3,
    id_almacen_origen: 1,
    serie: null,
    numero: null,
    estado: 'borrador',
    fecha_emision: null,
    fecha_inicio_traslado: '2026-10-22',
    motivo_traslado_codigo: '01',
    modalidad_traslado: '02',
    direccion_origen: 'LT. 8 MZ. N1 URB. NUEVO LURIN',
    origen_ubigeo: '150119',
    direccion_destino: 'AV. JOSE LARCO 1150, MIRAFLORES',
    destino_ubigeo: '150122',
    peso_bruto_total: 50,
    unidad_peso: 'KGM',
    numero_bultos: 2,
    destinatario_tipo_doc: '6',
    destinatario_numero_doc: '20553856451',
    destinatario_denominacion: 'CONSTRUCTORA LOS ANDES S.A.C.',
    destinatario_direccion: 'AV. JOSE LARCO 1150, MIRAFLORES',
    placa_principal: 'ABC123',
    marca_vehiculo: null,
    conductor_nombre: 'JUAN PEREZ',
    conductor_tipo_doc: '1',
    conductor_numero_doc: '45678912',
    conductor_licencia: 'Q45678912',
    transportista_ruc: null,
    transportista_denominacion: null,
    observaciones: null,
    error_mensaje: null,
    sunat_ticket: null,
    sunat_responsecode: null,
    sunat_description: null,
    cadena_qr: null,
    codigo_hash: null,
    payload: { formulario: { conductor_nombres: 'JUAN', conductor_apellidos: 'PEREZ' } },
    creado_en: '2026-10-22T14:00:00Z',
    comprobante: { id_comprobante: 3, id_tipo: 1, serie: 'F001', numero: 125, ambiente_fiscal: 'produccion' },
    envio: null,
    ...cambios,
  };
}

function envio(estado: string, revisionManual = false): EnvioGuia {
  return {
    id_envio: 99,
    estado,
    codigo: null,
    mensaje: null,
    ticket: 'T-1',
    intento: 1,
    consultas: 0,
    revision_manual: revisionManual,
    en_curso: false,
    proximo_intento_en: null,
    actualizado_en: null,
    archivos: [],
  };
}

const ITEMS: FilaItemGuia[] = [
  { id_item: 1, id_producto: 5, id_venta_detalle: 20, codigo: 'CEM-001', descripcion: 'CEMENTO SOL TIPO I', unidad_medida: 'BG', cantidad: 25, orden: 1, codigo_sunat: '30111601' },
];

function vendido(cambios: Partial<ProductoVendidoGuia> = {}): ProductoVendidoGuia {
  return { id_producto: 5, id_venta_detalle: 20, cantidad_vendida: 30, cantidad_en_guias: 0, nombre: 'CEMENTO SOL TIPO I', codigo: 'CEM-001', unidad_medida: 'bolsa', ...cambios };
}

const VENTA: VentaGuia = {
  id_venta: 10,
  fecha: '2026-10-22',
  total: 900,
  estado: 'activa',
  id_cliente: null,
  id_empresa: 4,
  empresa: {
    ruc: '20553856451',
    razon_social: 'CONSTRUCTORA LOS ANDES S.A.C.',
    direccion: 'AV. JOSE LARCO 1150, MIRAFLORES',
    ubigeo: '150122',
    departamento: 'LIMA',
    provincia: 'LIMA',
    distrito: 'MIRAFLORES',
  },
  cliente: null,
};

function preparada(documento: DocumentoGre): GrePreparada {
  const zip = Buffer.from(`zip-${documento.serie}-${documento.numero}`);
  return {
    documento,
    nombreBase: `20610206337-09-${documento.serie}-${String(documento.numero).padStart(8, '0')}`,
    xml: '<DespatchAdvice/>',
    xmlFirmado: '<DespatchAdvice firmado="si"/>',
    zip,
    zipBase64: zip.toString('base64'),
    sha256: 'hash',
    digestValue: 'DIGEST==',
    advertencias: [],
  };
}

const TICKET: ResultadoEnvioGre = {
  estado: 'TICKET_PENDIENTE',
  ticket: 'T-1',
  fechaRecepcion: '2026-10-22T10:00:01-05:00',
  codigo: null,
  mensaje: 'SUNAT recibió la guía (ticket T-1). Consulte el ticket para obtener la constancia (CDR).',
  errores: [],
  accion: 'CONSULTAR_TICKET',
  httpStatus: 200,
  crudo: '{"numTicket":"T-1"}',
};

/** El envío que reclama la consulta del ticket (datos con que se firmó la guía 7). */
const RECLAMADO = {
  id_envio: 99,
  id_guia: 7,
  ticket: 'T-1',
  nombre_base: '20610206337-09-T001-00000100',
  documento: { remitente: { ruc: '20610206337' }, serie: 'T001', numero: 100 },
  digest: 'DIGEST==',
  consultas: 0,
};

const ACEPTADA: ResultadoConsultaGre = {
  estado: 'ACEPTADA',
  codigo: '0',
  mensaje: 'SUNAT aceptó la guía.',
  errores: [],
  observaciones: [],
  accion: 'NINGUNA',
  cdr: { nombre: 'R-20610206337-09-T001-00000100.xml', xml: Buffer.from('<cdr/>'), zip: Buffer.from('cdr-zip'), enlaceQr: ENLACE_QR_PRUEBA },
  httpStatus: 200,
  crudo: '{}',
};

const EN_PROCESO: ResultadoConsultaGre = { ...ACEPTADA, estado: 'TICKET_PENDIENTE', codigo: '98', cdr: null, accion: 'CONSULTAR_TICKET', mensaje: 'SUNAT aún está procesando la guía (código 98).' };

function montar() {
  const tx = { query: jest.fn() };
  const repo = {
    transaccion: jest.fn(async (trabajo: (t: unknown) => unknown) => trabajo(tx)),
    bloquear: jest.fn(async (_tx: unknown, _clave: string) => undefined),
    obtener: jest.fn(async (_idGuia: number, _tx?: unknown, _bloquear?: boolean): Promise<FilaGuia | null> => fila()),
    items: jest.fn(async () => ITEMS),
    venta: jest.fn(async () => VENTA),
    productosVendidos: jest.fn(async () => [vendido()]),
    comprobantePrincipal: jest.fn(async () => fila().comprobante),
    almacenesDeSalida: jest.fn(async () => [{ id_almacen: 1, nombre: 'PRINCIPAL', direccion: 'LT. 8 MZ. N1 URB. NUEVO LURIN' }]),
    guiasDeVenta: jest.fn(async () => []),
    productos: jest.fn(async () => [{ id_producto: 9, nombre: 'TALADRO BOSCH', codigo: 'HER-010', unidad_medida: 'UND' }]),
    siguienteNumero: jest.fn(async () => 1),
    envioAbierto: jest.fn(async () => null),
    buscarPorClave: jest.fn(async (_clave: string): Promise<number | null> => null),
    insertar: jest.fn(async () => 7),
    actualizar: jest.fn(async () => true),
    anular: jest.fn(async () => true),
    registrarEmision: jest.fn(async (_tx: unknown, _registro: RegistroEmisionGuia) => 99),
    reclamarReenvio: jest.fn(),
    cerrarEnvio: jest.fn(async (_idEnvio: number, _cierre: CierreEnvioGuia) => true),
    reclamarConsulta: jest.fn(),
    cerrarConsulta: jest.fn(async (_idEnvio: number, _nombreBase: string, _cierre: CierreConsultaGuia) => true),
    candidatosConsulta: jest.fn(async () => []),
    archivo: jest.fn(async () => null),
    listar: jest.fn(async () => ({ filas: [], total: 0 })),
  };
  const emisionGre = {
    modo: jest.fn(async () => ({ activo: true })),
    contexto: jest.fn(async () => ({
      emisor: { ...REMITENTE_GRE_PRUEBA },
      serie: 'T001',
      partidaPorDefecto: { ubigeo: '150119', direccion: 'LT. 8 MZ. N1 URB. NUEVO LURIN', codigoEstablecimiento: '0000' },
    })),
    validar: jest.fn((documento: DocumentoGre) => validarDocumentoGre(documento, { hoy: '2026-10-22' })),
    prepararDocumento: jest.fn(async (documento: DocumentoGre) => preparada(documento)),
    enviar: jest.fn(async (_preparada: GrePreparada): Promise<ResultadoEnvioGre> => TICKET),
    consultarTicket: jest.fn(),
  };
  const fiscal = {
    emisor: jest.fn(async () => ({ ...REMITENTE_GRE_PRUEBA })),
    gre: jest.fn(async () => ({
      activa: true,
      serie: 'T001',
      correlativoInicial: 1,
      partida: { ubigeo: '150119', direccion: 'LT. 8 MZ. N1 URB. NUEVO LURIN', codigoEstablecimiento: '0000' },
      partidaHeredada: { ubigeo: true, direccion: true, codigoEstablecimiento: true },
    })),
    tareasActivas: jest.fn(async () => true),
  };
  const config = { obtener: jest.fn(async () => null) };
  const servicio = new GuiaRemisionBussnies(repo as any, config as any, emisionGre as any, fiscal as any, new RelojPrueba(), new UbigeoService());
  return { servicio, repo, emisionGre, fiscal, tx };
}

/**
 * La guía cambia de estado como en la BD: lo que guardan la emisión y los cierres del envío y de la
 * consulta es lo que `obtener` (y por lo tanto la respuesta) lee después.
 */
function conEstados(m: ReturnType<typeof montar>): void {
  let actual = fila();
  m.repo.obtener.mockImplementation(async () => actual);
  m.repo.siguienteNumero.mockResolvedValue(100);
  m.repo.registrarEmision.mockImplementation(async (_tx, r) => {
    actual = { ...actual, estado: 'pendiente', serie: r.preparada.documento.serie, numero: r.preparada.documento.numero, envio: envio('ENVIANDO') };
    return 99;
  });
  m.repo.cerrarEnvio.mockImplementation(async (_id, c) => {
    actual = { ...actual, estado: c.estadoGuia, sunat_ticket: c.ticket, error_mensaje: c.errorGuia, envio: envio(c.estadoEnvio) };
    return true;
  });
  m.repo.reclamarConsulta.mockImplementation(async () => ({ ...RECLAMADO }));
  m.repo.cerrarConsulta.mockImplementation(async (_id, _nombre, c) => {
    actual = { ...actual, estado: c.estadoGuia, error_mensaje: c.errorGuia, cadena_qr: c.cadenaQr, envio: envio(c.estadoEnvio, c.respuestaEnvio.revision_manual === true) };
    return true;
  });
}

/** Corre `operacion` con temporizadores falsos: la espera y el plazo de la consulta inmediata no se esperan de verdad. */
async function conTemporizadores<T>(operacion: () => Promise<T>): Promise<T> {
  jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask'] });
  try {
    const resultado = operacion().then(
      (valor) => ({ valor }),
      (error: unknown) => ({ error }),
    );
    await jest.advanceTimersByTimeAsync(ESPERA_CONSULTA_INMEDIATA_MS + PLAZO_CONSULTA_INMEDIATA_MS);
    const r = await resultado;
    if ('error' in r) throw r.error;
    return r.valor;
  } finally {
    jest.useRealTimers();
  }
}

function cuerpo(cambios: Partial<GuardarGuiaRemisionRequest> = {}): GuardarGuiaRemisionRequest {
  return {
    id_venta: 10,
    motivo_traslado: '01',
    modalidad_traslado: '02',
    fecha_inicio_traslado: '2026-10-22',
    peso_bruto_total: 50,
    unidad_peso: 'KGM',
    vehiculo: { placa: 'abc-123' },
    conductor: { tipo_documento: '1', numero_documento: '45678912', nombres: 'JUAN', apellidos: 'PEREZ', licencia: 'Q45678912' },
    items: [{ id_producto: 5, cantidad: 25 }],
    ...cambios,
  } as GuardarGuiaRemisionRequest;
}

async function rechazo(promesa: Promise<unknown>): Promise<{ estado: number; cuerpo: Record<string, any> }> {
  try {
    await promesa;
  } catch (error: any) {
    return { estado: error.getStatus?.(), cuerpo: error.getResponse?.() };
  }
  throw new Error('Se esperaba un error');
}

describe('GuiaRemisionBussnies', () => {
  describe('borrador y edición (D10)', () => {
    it('una guía de venta usa el motivo 01 y una sin venta solo 04 o 13 (400)', async () => {
      const { servicio, repo } = montar();
      const conVenta = await rechazo(servicio.crear(cuerpo({ motivo_traslado: '13' }), 1));
      expect(conVenta).toMatchObject({ estado: 400, cuerpo: { codigo: 'GRE_MOTIVO_NO_VALIDO' } });
      const sinVenta = await rechazo(servicio.crear(cuerpo({ id_venta: undefined }), 1));
      expect(sinVenta.cuerpo.message).toContain('indique la venta');
      expect(repo.insertar).not.toHaveBeenCalled();
    });

    it('guarda lo vendido bajo el candado de la venta, con la unidad del catálogo 03, el cliente y el comprobante principal', async () => {
      const { servicio, repo, tx } = montar();
      const guia = await servicio.crear(cuerpo({ items: [{ id_producto: 5, cantidad: 25 }] }), 3);

      expect(repo.bloquear).toHaveBeenCalledWith(tx, 'gre-venta:10');
      expect(repo.productosVendidos).toHaveBeenCalledWith(10, null, tx);
      const [, datos, extra] = repo.insertar.mock.calls[0] as any[];
      expect(extra).toEqual({ idVenta: 10, idUsuario: 3, clave: null });
      expect(datos).toMatchObject({
        id_comprobante: 3,
        id_empresa: 4,
        id_almacen_origen: 1,
        destinatario_tipo_doc: '6',
        destinatario_numero_doc: '20553856451',
        // Sin partida en el cuerpo: la configurada; sin llegada: la dirección del cliente con su ubigeo INEI.
        origen_ubigeo: '150119',
        destino_ubigeo: '150122',
        placa_principal: 'ABC123',
        conductor_nombre: 'JUAN PEREZ',
        formulario: { conductor_nombres: 'JUAN', conductor_apellidos: 'PEREZ', partida_codigo_establecimiento: '0000' },
      });
      expect(datos.items).toEqual([
        { id_producto: 5, id_venta_detalle: 20, codigo: 'CEM-001', descripcion: 'CEMENTO SOL TIPO I', unidad_medida: 'BG', cantidad: 25 },
      ]);
      expect(guia.estado).toBe('borrador');
      expect(guia.acciones).toEqual({ puede_editar: true, puede_validar: true, puede_emitir: true, puede_consultar: false, puede_anular: true });
    });

    it('rechaza productos ajenos a la venta (400) y lo que supera lo pendiente, con el detalle (409)', async () => {
      const { servicio, repo } = montar();
      const ajeno = await rechazo(servicio.crear(cuerpo({ items: [{ id_producto: 99, cantidad: 1 }] }), 1));
      expect(ajeno).toMatchObject({ estado: 400, cuerpo: { codigo: 'GRE_PRODUCTO_FUERA_DE_VENTA', productos: [99] } });

      repo.productosVendidos.mockResolvedValue([vendido({ cantidad_vendida: 30, cantidad_en_guias: 20 })]);
      const excede = await rechazo(servicio.crear(cuerpo({ items: [{ id_producto: 5, cantidad: 7.5 }, { id_producto: 5, cantidad: 3 }] }), 1));
      expect(excede.estado).toBe(409);
      expect(excede.cuerpo.codigo).toBe('GRE_CANTIDAD_EXCEDE_VENTA');
      expect(excede.cuerpo.message).toContain('CEMENTO SOL TIPO I (vendido 30, en otras guías 20, en esta 10.5; pendiente 10)');
      expect(excede.cuerpo.detalle).toEqual([
        { id_producto: 5, descripcion: 'CEMENTO SOL TIPO I', cantidad_vendida: 30, cantidad_en_guias: 20, cantidad_solicitada: 10.5, cantidad_pendiente: 10 },
      ]);
      expect(repo.insertar).not.toHaveBeenCalled();
    });

    it('una venta anulada no admite guías (409) y la misma clave de idempotencia devuelve la guía ya creada', async () => {
      const { servicio, repo } = montar();
      repo.venta.mockResolvedValue({ ...VENTA, estado: 'anulada' });
      expect(await rechazo(servicio.crear(cuerpo(), 1))).toMatchObject({ estado: 409, cuerpo: { codigo: 'GRE_VENTA_ANULADA' } });

      repo.buscarPorClave.mockResolvedValue(7);
      const repetida = await servicio.crear(cuerpo({ clave_idempotencia: 'gre-1' }), 1);
      expect(repetida.id_guia).toBe(7);
      expect(repo.insertar).not.toHaveBeenCalled();
    });

    it('con el motivo 04 (sin venta) el destinatario es el propio emisor y los productos salen del catálogo', async () => {
      const { servicio, repo } = montar();
      await servicio.crear(
        cuerpo({ id_venta: undefined, motivo_traslado: '04', items: [{ id_producto: 9, cantidad: 2 }], llegada: { ubigeo: '150101', direccion: 'JR. AYACUCHO 450', codigo_establecimiento: '0001' } }),
        1,
      );
      const [, datos] = repo.insertar.mock.calls[0] as any[];
      expect(datos).toMatchObject({
        destinatario_tipo_doc: '6',
        destinatario_numero_doc: '20610206337',
        destinatario_denominacion: 'HATUNSALES S.A.C.',
        id_comprobante: null,
        formulario: { llegada_codigo_establecimiento: '0001' },
      });
      expect(datos.items[0]).toMatchObject({ id_producto: 9, unidad_medida: 'NIU', descripcion: 'TALADRO BOSCH' });
      expect(repo.productosVendidos).not.toHaveBeenCalled();
    });

    it('una guía aceptada no se edita ni se anula: la baja se hace en SUNAT Operaciones en Línea (409)', async () => {
      const { servicio, repo } = montar();
      repo.obtener.mockResolvedValue(fila({ estado: 'aceptado', serie: 'T001', numero: 4 }));
      expect(await rechazo(servicio.actualizar(7, cuerpo()))).toMatchObject({ estado: 409, cuerpo: { codigo: 'GRE_ESTADO_NO_PERMITE' } });
      const anular = await rechazo(servicio.anular(7, {}, 1));
      expect(anular.cuerpo.message).toContain('la baja de una guía aceptada se hace en SUNAT Operaciones en Línea');
      expect(repo.anular).not.toHaveBeenCalled();
    });
  });

  describe('emisión (D11)', () => {
    it('sin la GRE activa responde 503 con el motivo legible y no reserva número', async () => {
      const { servicio, repo, emisionGre } = montar();
      emisionGre.modo.mockResolvedValue({ activo: false, codigo: 'GRE_SIN_BETA', motivo: 'La GRE no tiene ambiente de pruebas en SUNAT: solo se puede validar sin enviar.' } as any);
      const error = await servicio.emitir(7, 1).catch((e) => e);
      expect(error).toBeInstanceOf(ServiceUnavailableException);
      expect(error.getResponse()).toEqual({ message: 'La GRE no tiene ambiente de pruebas en SUNAT: solo se puede validar sin enviar.', codigo: 'GRE_SIN_BETA' });
      expect(repo.siguienteNumero).not.toHaveBeenCalled();
      expect(repo.registrarEmision).not.toHaveBeenCalled();
    });

    it('si la validación falla responde 400 por campo y no reserva número ni envía', async () => {
      const { servicio, repo, emisionGre } = montar();
      repo.obtener.mockResolvedValue(fila({ destino_ubigeo: '150199', conductor_licencia: null }));
      const error = await rechazo(servicio.emitir(7, 1));
      expect(error.estado).toBe(400);
      expect(error.cuerpo.codigo).toBe('GRE_INVALIDA');
      expect(error.cuerpo.por_campo).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ campo: 'envio.llegada.ubigeo', campo_formulario: 'llegada.ubigeo', nivel: 'error' }),
          expect.objectContaining({ campo: 'conductores[0].licencia', campo_formulario: 'conductor.licencia', nivel: 'error' }),
        ]),
      );
      expect(emisionGre.prepararDocumento).not.toHaveBeenCalled();
      expect(repo.registrarEmision).not.toHaveBeenCalled();
      expect(emisionGre.enviar).not.toHaveBeenCalled();
    });

    it('numera, fecha y hora de Lima, registra TODO antes de enviar y deja la guía enviada con su ticket', async () => {
      const { servicio, repo, emisionGre, tx } = montar();
      repo.siguienteNumero.mockResolvedValue(100);
      const operacion = await conTemporizadores(() => servicio.emitir(7, 3));

      const documento = emisionGre.prepararDocumento.mock.calls[0][0] as DocumentoGre;
      expect(documento).toMatchObject({ serie: 'T001', numero: 100, fechaEmision: '2026-10-22', horaEmision: '10:00:00' });
      expect(documento.documentosRelacionados).toEqual([{ tipo: '01', serie: 'F001', numero: '125' }]);
      expect(repo.siguienteNumero).toHaveBeenCalledWith('T001', 1);
      // Candados en orden fijo y número vuelto a leer bajo el candado de la serie.
      expect(repo.bloquear.mock.calls.map((c) => c[1])).toEqual(['gre-venta:10', 'gre:T001']);
      expect(repo.siguienteNumero).toHaveBeenLastCalledWith('T001', 1, tx);
      expect(repo.registrarEmision).toHaveBeenCalledWith(tx, expect.objectContaining({ idGuia: 7, numeroAnterior: null, idComprobante: 3, idUsuario: 3 }));
      expect(repo.registrarEmision.mock.invocationCallOrder[0]).toBeLessThan(emisionGre.enviar.mock.invocationCallOrder[0]);
      expect(repo.cerrarEnvio).toHaveBeenCalledWith(99, expect.objectContaining({
        estadoEnvio: 'TICKET_PENDIENTE',
        estadoGuia: 'enviado',
        ticket: 'T-1',
        errorGuia: null,
        proximoIntentoSeg: ESPERAS_CONSULTA_SEG[0],
      }));
      expect(operacion.resultado).toMatchObject({ estado: 'TICKET_PENDIENTE', ticket: 'T-1' });
    });

    it('una guía rechazada se reenvía con el MISMO número (no pide otro)', async () => {
      const { servicio, repo, emisionGre } = montar();
      repo.obtener.mockResolvedValue(fila({ estado: 'rechazado', serie: 'T001', numero: 5 }));
      await conTemporizadores(() => servicio.emitir(7, 1));
      expect(repo.siguienteNumero).not.toHaveBeenCalled();
      expect((emisionGre.prepararDocumento.mock.calls[0][0] as DocumentoGre).numero).toBe(5);
      expect(repo.registrarEmision).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ numeroAnterior: 5 }));
    });

    it('si otra guía tomó el número, vuelve a preparar con el siguiente', async () => {
      const { servicio, repo, emisionGre } = montar();
      repo.siguienteNumero.mockResolvedValueOnce(2).mockResolvedValueOnce(2).mockResolvedValue(3);
      repo.registrarEmision.mockRejectedValueOnce(new NumeroGuiaOcupadoError('T001', 2, 3)).mockResolvedValue(99);
      await conTemporizadores(() => servicio.emitir(7, 1));
      expect(emisionGre.prepararDocumento.mock.calls.map((c) => c[0].numero)).toEqual([2, 3]);
      expect(emisionGre.enviar).toHaveBeenCalledTimes(1);
    });

    it('anti doble envío: con un envío abierto responde 409 y no envía', async () => {
      const { servicio, repo, emisionGre } = montar();
      repo.envioAbierto.mockResolvedValue({ id_envio: 1, estado: 'ENVIANDO' } as any);
      expect(await rechazo(servicio.emitir(7, 1))).toMatchObject({ estado: 409, cuerpo: { codigo: 'GRE_ENVIO_EN_CURSO' } });
      repo.obtener.mockResolvedValue(fila({ estado: 'enviado', serie: 'T001', numero: 3, sunat_ticket: 'T-9' }));
      const enviada = await rechazo(servicio.emitir(7, 1));
      expect(enviada).toMatchObject({ estado: 409, cuerpo: { codigo: 'GRE_YA_ENVIADA' } });
      expect(enviada.cuerpo.message).toContain('ticket T-9');
      expect(emisionGre.enviar).not.toHaveBeenCalled();
    });

    it('vuelve a verificar el tope de la venta dentro de la transacción (409)', async () => {
      const { servicio, repo, emisionGre } = montar();
      repo.productosVendidos.mockResolvedValueOnce([vendido()]).mockResolvedValue([vendido({ cantidad_en_guias: 10 })]);
      expect(await rechazo(servicio.emitir(7, 1))).toMatchObject({ estado: 409, cuerpo: { codigo: 'GRE_CANTIDAD_EXCEDE_VENTA' } });
      expect(repo.registrarEmision).not.toHaveBeenCalled();
      expect(emisionGre.enviar).not.toHaveBeenCalled();
    });

    it('rechazo antes del ticket: rechazada con su número; error de configuración e incierto: pendiente', async () => {
      const { servicio, repo, emisionGre } = montar();
      emisionGre.enviar.mockResolvedValueOnce({ ...TICKET, estado: 'RECHAZADA', ticket: null, codigo: '2774', mensaje: 'SUNAT rechazó la guía antes de recibirla: 2774 - ubigeo. El número no se consume.', accion: 'CORREGIR_Y_REENVIAR' });
      await servicio.emitir(7, 1);
      expect(repo.cerrarEnvio).toHaveBeenLastCalledWith(99, expect.objectContaining({ estadoEnvio: 'RECHAZADO', estadoGuia: 'rechazado', codigo: '2774' }));

      emisionGre.enviar.mockResolvedValueOnce({ ...TICKET, estado: 'ERROR_CONFIG', ticket: null, mensaje: 'SUNAT no aceptó las credenciales de la GRE.', accion: 'REVISAR_CONFIG' });
      await servicio.emitir(7, 1);
      expect(repo.cerrarEnvio).toHaveBeenLastCalledWith(99, expect.objectContaining({ estadoEnvio: 'ERROR_CONFIG', estadoGuia: 'pendiente', errorGuia: 'SUNAT no aceptó las credenciales de la GRE.' }));

      emisionGre.enviar.mockRejectedValueOnce(new Error('socket hang up'));
      await servicio.emitir(7, 1);
      expect(repo.cerrarEnvio).toHaveBeenLastCalledWith(99, expect.objectContaining({ estadoEnvio: 'PENDIENTE_REENVIO', estadoGuia: 'pendiente' }));
      // Sin ticket no hay nada que consultar.
      expect(emisionGre.consultarTicket).not.toHaveBeenCalled();
    });

    it('reintento del envío incierto: manda los MISMOS bytes del ZIP sin volver a preparar', async () => {
      const { servicio, repo, emisionGre } = montar();
      const zip = Buffer.from('ZIP-GUARDADO');
      repo.obtener.mockResolvedValue(fila({ estado: 'pendiente', serie: 'T001', numero: 8, envio: { ...envio('PENDIENTE_REENVIO'), id_envio: 55 } }));
      repo.reclamarReenvio.mockResolvedValue({
        id_envio: 55,
        nombre_base: '20610206337-09-T001-00000008',
        documento: { remitente: { ruc: '20610206337' }, serie: 'T001', numero: 8 },
        digest: 'DIGEST==',
        advertencias: [],
        xml: '<x/>',
        xml_firmado: '<x firmado/>',
        zip,
      });
      await conTemporizadores(() => servicio.emitir(7, 1));
      expect(emisionGre.prepararDocumento).not.toHaveBeenCalled();
      expect(repo.registrarEmision).not.toHaveBeenCalled();
      const enviada = emisionGre.enviar.mock.calls[0][0];
      expect(enviada.zip).toBe(zip);
      expect(enviada.nombreBase).toBe('20610206337-09-T001-00000008');
      expect(enviada.sha256).toBe(createHash('sha256').update(zip).digest('hex'));
      expect(repo.cerrarEnvio).toHaveBeenCalledWith(55, expect.objectContaining({ estadoGuia: 'enviado' }));
    });

    it('no guarda secretos: la respuesta y el mensaje se redactan antes de persistirse', async () => {
      const { servicio, repo, emisionGre } = montar();
      emisionGre.enviar.mockResolvedValueOnce({
        ...TICKET,
        estado: 'ERROR_CONFIG',
        ticket: null,
        mensaje: 'Falló el token: client_secret=abc123',
        crudo: '{"access_token":"eyJabc.def","detalle":"Bearer eyJabc.def"}',
      });
      await servicio.emitir(7, 1);
      const cierre = repo.cerrarEnvio.mock.calls[0][1];
      const guardado = JSON.stringify(cierre);
      expect(guardado).not.toContain('abc123');
      expect(guardado).not.toContain('eyJabc.def');
      expect(guardado).toContain('[REDACTADO]');
    });
  });

  describe('directo a SUNAT: con el ticket se consulta enseguida', () => {
    it('consulta UNA vez a los 2,5 s y responde la guía aceptada con su QR', async () => {
      const m = montar();
      conEstados(m);
      m.emisionGre.consultarTicket.mockResolvedValue(ACEPTADA);
      jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask'] });
      try {
        const promesa = m.servicio.emitir(7, 1);
        await jest.advanceTimersByTimeAsync(ESPERA_CONSULTA_INMEDIATA_MS - 1);
        expect(m.emisionGre.consultarTicket).not.toHaveBeenCalled();
        await jest.advanceTimersByTimeAsync(1);
        const operacion = await promesa;

        expect(m.emisionGre.consultarTicket).toHaveBeenCalledTimes(1);
        expect(m.emisionGre.consultarTicket).toHaveBeenCalledWith('T-1', { rucEmisor: '20610206337', serie: 'T001', numero: 100 });
        expect(operacion.resultado).toEqual({ estado: 'ACEPTADA', codigo: '0', mensaje: 'SUNAT aceptó la guía.', ticket: 'T-1', errores: [] });
        expect(operacion.guia).toMatchObject({ estado: 'aceptado', numero_formateado: 'T001-00000100', sunat: { cadena_qr: ENLACE_QR_PRUEBA } });
      } finally {
        jest.useRealTimers();
      }
    });

    it('rechazada al instante: responde el motivo de SUNAT y la guía conserva su número para corregirla', async () => {
      const m = montar();
      conEstados(m);
      const errores = [{ codigo: '2774', descripcion: 'El ubigeo del punto de llegada no existe' }];
      m.emisionGre.consultarTicket.mockResolvedValue({ ...EN_PROCESO, estado: 'RECHAZADA', codigo: '99', errores, mensaje: 'SUNAT rechazó la guía: 2774 - El ubigeo del punto de llegada no existe.' });
      const operacion = await conTemporizadores(() => m.servicio.emitir(7, 1));
      expect(operacion.resultado).toMatchObject({ estado: 'RECHAZADA', mensaje: 'SUNAT rechazó la guía: 2774 - El ubigeo del punto de llegada no existe.', errores });
      expect(operacion.guia).toMatchObject({ estado: 'rechazado', numero: 100, acciones: { puede_editar: true, puede_emitir: true } });
    });

    it('si SUNAT aún la procesa, queda enviada con el aviso de consulta automática (o manual sin tareas programadas)', async () => {
      const m = montar();
      conEstados(m);
      m.emisionGre.consultarTicket.mockResolvedValue(EN_PROCESO);
      const operacion = await conTemporizadores(() => m.servicio.emitir(7, 1));
      expect(operacion.resultado).toMatchObject({ estado: 'TICKET_PENDIENTE', ticket: 'T-1', mensaje: MENSAJE_GUIA_EN_PROCESO });
      expect(operacion.guia).toMatchObject({ estado: 'enviado', acciones: { puede_consultar: true } });
      expect(m.repo.cerrarConsulta).toHaveBeenCalledWith(99, expect.any(String), expect.objectContaining({ estadoGuia: 'enviado', proximoIntentoSeg: ESPERAS_CONSULTA_SEG[1] }));

      const sinTareas = montar();
      conEstados(sinTareas);
      sinTareas.fiscal.tareasActivas.mockResolvedValue(false);
      sinTareas.emisionGre.consultarTicket.mockResolvedValue(EN_PROCESO);
      const manual = await conTemporizadores(() => sinTareas.servicio.emitir(7, 1));
      expect(manual.resultado.mensaje).toBe(MENSAJE_GUIA_EN_PROCESO_MANUAL);
    });

    it('si SUNAT no contesta a tiempo no bloquea más de ~8 s: responde enviada y la consulta sigue por su cuenta', async () => {
      const m = montar();
      conEstados(m);
      m.emisionGre.consultarTicket.mockReturnValue(new Promise(() => undefined));
      jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask'] });
      try {
        let terminada = false;
        const promesa = m.servicio.emitir(7, 1).finally(() => {
          terminada = true;
        });
        await jest.advanceTimersByTimeAsync(ESPERA_CONSULTA_INMEDIATA_MS + PLAZO_CONSULTA_INMEDIATA_MS - 1);
        expect(terminada).toBe(false);
        await jest.advanceTimersByTimeAsync(1);
        expect(terminada).toBe(true);
        const operacion = await promesa;
        expect(ESPERA_CONSULTA_INMEDIATA_MS + PLAZO_CONSULTA_INMEDIATA_MS).toBeLessThanOrEqual(8_000);
        expect(operacion.resultado).toMatchObject({ estado: 'TICKET_PENDIENTE', ticket: 'T-1', mensaje: MENSAJE_GUIA_EN_PROCESO });
        expect(operacion.guia.estado).toBe('enviado');
        expect(m.repo.cerrarConsulta).not.toHaveBeenCalled();
      } finally {
        jest.useRealTimers();
      }
    });

    it('si la consulta inmediata falla, la emisión no se vuelve un error: la guía sigue enviada con su ticket', async () => {
      const m = montar();
      conEstados(m);
      m.emisionGre.consultarTicket.mockResolvedValue(EN_PROCESO);
      m.repo.cerrarConsulta.mockRejectedValue(new Error('conexión cerrada'));
      const operacion = await conTemporizadores(() => m.servicio.emitir(7, 1));
      expect(operacion.resultado).toMatchObject({ estado: 'TICKET_PENDIENTE', mensaje: MENSAJE_GUIA_EN_PROCESO });
      expect(operacion.guia.estado).toBe('enviado');
    });
  });

  describe('crear y emitir en una sola llamada (POST /guia-remision/emitir)', () => {
    it('guarda la guía y la emite en el acto', async () => {
      const m = montar();
      conEstados(m);
      m.emisionGre.consultarTicket.mockResolvedValue(ACEPTADA);
      const operacion = await conTemporizadores(() => m.servicio.crearYEmitir(cuerpo(), 3));
      expect(m.repo.insertar).toHaveBeenCalledTimes(1);
      expect(m.repo.registrarEmision).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ idGuia: 7, idUsuario: 3 }));
      expect(operacion.resultado.estado).toBe('ACEPTADA');
      expect(operacion.guia).toMatchObject({ id_guia: 7, estado: 'aceptado' });
    });

    it('si no pasa la validación queda como borrador y el 400 trae su id_guia y los errores por campo', async () => {
      const { servicio, repo, emisionGre } = montar();
      repo.obtener.mockResolvedValue(fila({ destino_ubigeo: '150199' }));
      const error = await rechazo(servicio.crearYEmitir(cuerpo(), 1));
      expect(error.estado).toBe(400);
      expect(error.cuerpo).toMatchObject({ codigo: 'GRE_INVALIDA', id_guia: 7 });
      expect(error.cuerpo.por_campo).toEqual(expect.arrayContaining([expect.objectContaining({ campo_formulario: 'llegada.ubigeo' })]));
      expect(repo.insertar).toHaveBeenCalledTimes(1);
      expect(repo.registrarEmision).not.toHaveBeenCalled();
      expect(emisionGre.enviar).not.toHaveBeenCalled();
    });

    it('con la GRE inactiva queda como borrador: 503 con el motivo y el id_guia, sin reservar número', async () => {
      const { servicio, repo, emisionGre } = montar();
      emisionGre.modo.mockResolvedValue({ activo: false, codigo: 'GRE_DESACTIVADA', motivo: 'La guía de remisión electrónica está desactivada en el panel de facturación.' } as any);
      const error = await rechazo(servicio.crearYEmitir(cuerpo(), 1));
      expect(error).toEqual({
        estado: 503,
        cuerpo: { message: 'La guía de remisión electrónica está desactivada en el panel de facturación.', codigo: 'GRE_DESACTIVADA', id_guia: 7 },
      });
      expect(repo.insertar).toHaveBeenCalledTimes(1);
      expect(repo.siguienteNumero).not.toHaveBeenCalled();
    });

    it('si el borrador no se puede crear (tope de la venta), no hay guía ni id_guia', async () => {
      const { servicio, repo } = montar();
      repo.productosVendidos.mockResolvedValue([vendido({ cantidad_en_guias: 30 })]);
      const error = await rechazo(servicio.crearYEmitir(cuerpo(), 1));
      expect(error.estado).toBe(409);
      expect(error.cuerpo.id_guia).toBeUndefined();
      expect(repo.insertar).not.toHaveBeenCalled();
    });
  });

  describe('consulta del ticket', () => {
    function enviada() {
      const m = montar();
      m.repo.obtener.mockResolvedValue(fila({ estado: 'enviado', serie: 'T001', numero: 100, sunat_ticket: 'T-1', envio: envio('TICKET_PENDIENTE') }));
      m.repo.reclamarConsulta.mockResolvedValue({ ...RECLAMADO });
      return m;
    }

    it('aceptada: verifica contra la guía enviada y guarda el CDR, el enlace del QR y el hash (DigestValue)', async () => {
      const { servicio, repo, emisionGre } = enviada();
      emisionGre.consultarTicket.mockResolvedValue(ACEPTADA);
      const operacion = await servicio.consultar(7);
      expect(emisionGre.consultarTicket).toHaveBeenCalledWith('T-1', { rucEmisor: '20610206337', serie: 'T001', numero: 100 });
      expect(repo.cerrarConsulta).toHaveBeenCalledWith(99, '20610206337-09-T001-00000100', expect.objectContaining({
        estadoEnvio: 'ACEPTADO',
        estadoGuia: 'aceptado',
        cadenaQr: ENLACE_QR_PRUEBA,
        codigoHash: 'DIGEST==',
        cdr: { xml: ACEPTADA.cdr!.xml, zip: ACEPTADA.cdr!.zip },
        proximoIntentoSeg: null,
      }));
      expect(operacion.resultado).toMatchObject({ estado: 'ACEPTADA', ticket: 'T-1' });
    });

    it('rechazada: queda rechazada conservando el número; «ya registrada» se marca para revisar en SOL', async () => {
      const { servicio, repo, emisionGre } = enviada();
      emisionGre.consultarTicket.mockResolvedValue({ ...ACEPTADA, estado: 'RECHAZADA', codigo: '1033', cdr: null, errores: [{ codigo: '1033', descripcion: 'registrado previamente' }], mensaje: 'SUNAT indica que esta guía ya estaba registrada.' });
      await servicio.consultar(7);
      expect(repo.cerrarConsulta).toHaveBeenCalledWith(99, expect.any(String), expect.objectContaining({
        estadoEnvio: 'RECHAZADO',
        estadoGuia: 'rechazado',
        respuestaGuia: expect.objectContaining({ ya_registrada: true }),
      }));
    });

    it('pendiente: espera creciente; tras el tope o si la constancia no corresponde, revisión manual', async () => {
      const { servicio, repo, emisionGre } = enviada();
      emisionGre.consultarTicket.mockResolvedValue(EN_PROCESO);
      await servicio.consultar(7);
      expect(repo.cerrarConsulta).toHaveBeenLastCalledWith(99, expect.any(String), expect.objectContaining({
        estadoGuia: 'enviado',
        errorGuia: null,
        proximoIntentoSeg: ESPERAS_CONSULTA_SEG[1],
        respuestaEnvio: expect.objectContaining({ consultas: 1, revision_manual: false }),
      }));

      repo.reclamarConsulta.mockResolvedValue({ ...RECLAMADO, consultas: MAXIMO_CONSULTAS_AUTOMATICAS - 1 });
      await servicio.consultar(7);
      const agotada = repo.cerrarConsulta.mock.calls.at(-1)![2];
      expect(agotada).toMatchObject({ proximoIntentoSeg: null, respuestaEnvio: { revision_manual: true } });
      expect(agotada.errorGuia).toContain('la consulta automática se detuvo');

      repo.reclamarConsulta.mockResolvedValue({ ...RECLAMADO });
      emisionGre.consultarTicket.mockResolvedValue({ ...EN_PROCESO, cdrNoCorresponde: 'La constancia es de otra guía.', mensaje: 'La constancia es de otra guía. No se da por aceptada ni rechazada.' });
      await servicio.consultar(7);
      expect(repo.cerrarConsulta.mock.calls.at(-1)![2]).toMatchObject({
        estadoGuia: 'enviado',
        errorGuia: 'La constancia es de otra guía. No se da por aceptada ni rechazada.',
        proximoIntentoSeg: null,
        respuestaEnvio: { revision_manual: true },
      });
    });

    it('credenciales rechazadas: detiene la consulta automática (no bloquear el usuario SOL) y «Consultar» la reanuda', async () => {
      const { servicio, repo, emisionGre } = enviada();
      const mensaje = 'SUNAT no aceptó las credenciales de la GRE: clave incorrecta. Revíselas en el panel de facturación y vuelva a consultar.';
      emisionGre.consultarTicket.mockResolvedValueOnce({ ...EN_PROCESO, estado: 'ERROR_CONFIG', codigo: null, accion: 'REVISAR_CONFIG', mensaje });
      await servicio.consultar(7);
      expect(repo.cerrarConsulta.mock.calls.at(-1)![2]).toMatchObject({
        estadoEnvio: 'TICKET_PENDIENTE',
        estadoGuia: 'enviado',
        errorGuia: mensaje,
        proximoIntentoSeg: null,
        respuestaEnvio: { revision_manual: true },
      });

      emisionGre.consultarTicket.mockResolvedValueOnce(EN_PROCESO);
      await servicio.consultar(7);
      expect(repo.cerrarConsulta.mock.calls.at(-1)![2]).toMatchObject({ errorGuia: null, proximoIntentoSeg: ESPERAS_CONSULTA_SEG[1], respuestaEnvio: { revision_manual: false } });
    });

    it('consultar exige una guía enviada con ticket (409) y avisa si otro proceso ya la consulta', async () => {
      const { servicio, repo } = montar();
      expect(await rechazo(servicio.consultar(7))).toMatchObject({ estado: 409, cuerpo: { codigo: 'GRE_SIN_TICKET' } });
      repo.obtener.mockResolvedValue(fila({ estado: 'enviado', envio: envio('TICKET_PENDIENTE') }));
      repo.reclamarConsulta.mockResolvedValue(null);
      expect(await rechazo(servicio.consultar(7))).toMatchObject({ estado: 409, cuerpo: { codigo: 'GRE_CONSULTA_EN_CURSO' } });
    });
  });

  describe('validar sin enviar', () => {
    it('reúne las reglas del motor, el ubigeo INEI y el tope de la venta con el campo del formulario', async () => {
      const { servicio, repo } = montar();
      repo.obtener.mockResolvedValue(fila({ origen_ubigeo: '150199' }));
      repo.productosVendidos.mockResolvedValue([vendido({ cantidad_vendida: 30, cantidad_en_guias: 10 })]);
      const resultado = await servicio.validar(7);
      expect(resultado.valido).toBe(false);
      expect(resultado.por_campo).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ campo_formulario: 'partida.ubigeo', mensaje: expect.stringContaining('no existe en el catálogo de distritos del INEI') }),
          expect.objectContaining({ campo_formulario: 'items[0].cantidad', mensaje: expect.stringContaining('pendiente 20') }),
        ]),
      );
      expect(repo.registrarEmision).not.toHaveBeenCalled();
    });

    it('una guía completa y dentro del tope es válida', async () => {
      const { servicio } = montar();
      expect(await servicio.validar(7)).toMatchObject({ valido: true, errores: [] });
    });
  });

  it('campoFormularioGuia traduce las rutas del motor a los campos del formulario', () => {
    expect(campoFormularioGuia('envio.partida.codigoEstablecimiento')).toBe('partida.codigo_establecimiento');
    expect(campoFormularioGuia('envio.llegada')).toBe('llegada');
    expect(campoFormularioGuia('destinatario.numDoc')).toBe('destinatario.numero_documento');
    expect(campoFormularioGuia('transportista.numDoc')).toBe('transportista.ruc');
    expect(campoFormularioGuia('conductores')).toBe('conductor');
    expect(campoFormularioGuia('items[2].unidad')).toBe('items[2].unidad');
    expect(campoFormularioGuia('items[2].codigoSunat')).toBe('items[2]');
    expect(campoFormularioGuia('fechaEmision')).toBe('emision');
    expect(campoFormularioGuia('vehiculo.placa')).toBe('vehiculo.placa');
  });
});

jest.mock('../../util/documentos/comprobante-pdf', () => ({
  generarPdfComprobante: jest.fn(async () => Buffer.from('%PDF-1.4 falso')),
}));
jest.mock('../../util/documentos/logo-emisor', () => ({
  obtenerLogoEmisor: jest.fn(async () => null),
}));

import { BadRequestException, ConflictException, InternalServerErrorException, NotFoundException } from '@nestjs/common';
import type { Comprobante } from '../../models/DBModel/c-electronico/comprobante.entity';
import type { DatosFiscalesComprobante, DatosListadoComprobante } from '../../repository/Repository/comprobante.repository';
import type { EnvioVista } from '../../sunat/emision/emision.contrato';
import { generarPdfComprobante } from '../../util/documentos/comprobante-pdf';
import { ComprobanteBussnies } from './comprobante.bussnies';
import {
  CONTEXTO_PRODUCCION,
  EMISOR_BETA,
  crearBdFalsa,
  crearConfigFalsa,
  crearEmisionFalsa,
  crearReceptorFalso,
  resultadoEmision,
  silenciarLogs,
} from './comprobante.prueba-spec';

const generarPdf = generarPdfComprobante as jest.MockedFunction<typeof generarPdfComprobante>;

/** Factura F001-12 de S/ 59 aceptada en producción, de la venta 9. */
function cpe(parcial: Partial<Record<keyof Comprobante, unknown>> = {}): Comprobante {
  return {
    id_comprobante: 50,
    id_venta: 9,
    tipo: { id_tipo: 1 },
    moneda: { id_moneda: 1 },
    serie: 'F001',
    numero: 12,
    cliente_tipo_doc: 6,
    cliente_numero_doc: '20123456789',
    cliente_denominacion: 'FERRETERIA EL MARTILLO S.A.C.',
    cliente_direccion: 'AV. LOS OLIVOS 456',
    cliente_email: '',
    fecha_de_emision: '21-10-2026',
    fecha_de_vencimiento: '21-10-2026',
    porcentaje_igv: 18,
    total_gravada: 50,
    total_exonerada: 0,
    total_inafecta: 0,
    total_descuento: 0,
    total_igv: 9,
    total: 59,
    importe_en_letras: 'CINCUENTA Y NUEVE CON 00/100 SOLES',
    observaciones: '',
    estado: 'emitido',
    aceptada_sunat: true,
    anulado: false,
    estado_sunat: 'ACEPTADO',
    ambiente_fiscal: 'produccion',
    proveedor_fiscal: 'sunat_directo',
    id_envio_ultimo: 501,
    cadena_qr: '20610206337|01|F001|12|9.00|59.00|2026-10-21|6|20123456789|HASH|',
    codigo_hash: 'HASH',
    sunat_observaciones: [],
    sunat_description: 'La Factura numero F001-12, ha sido aceptada',
    creado_en: new Date('2026-10-21T15:00:00Z'),
    items: [
      {
        id_item: 401,
        codigo: 'CEM-01',
        codigo_producto_sunat: '30111601',
        unidad_de_medida: 'NIU',
        descripcion: 'CEMENTO SOL 42.5 KG',
        cantidad: 1,
        valor_unitario: 50,
        precio_unitario: 59,
        descuento: 0,
        subtotal: 50,
        igv: 9,
        total: 59,
        tipo_de_igv: 1,
      },
    ],
    ...parcial,
  } as unknown as Comprobante;
}

function fiscal(parcial: Partial<DatosFiscalesComprobante> = {}): DatosFiscalesComprobante {
  return {
    forma_pago: 'Contado',
    cuotas: null,
    fecha_limite_envio: '2026-10-24',
    hora_emision: null,
    doc_modificado_tipo: null,
    doc_modificado_serie: null,
    doc_modificado_numero: null,
    id_comprobante_modificado: null,
    nota_motivo: null,
    nota_sustento: null,
    emisor_envio: null,
    hora_envio: '10:15:30',
    ...parcial,
  };
}

function envio(parcial: Partial<EnvioVista> = {}): EnvioVista {
  return {
    id_envio: 501,
    ambiente: 'produccion',
    tipo_documento: '01',
    nombre_archivo: '20610206337-01-F001-00000012.zip',
    estado: 'ACEPTADO',
    codigo_sunat: '0',
    mensaje_sunat: 'La Factura numero F001-12, ha sido aceptada',
    accion_sunat: 'NINGUNA',
    id_comprobante: 50,
    creado_en: '2026-10-21T15:00:00Z',
    archivos: ['xml_original', 'xml_firmado', 'zip', 'cdr_xml', 'cdr_zip'],
    intento: 1,
    bloqueado_hasta: null,
    ...parcial,
  };
}

function crear(opciones: { comprobante?: Comprobante | null; fiscal?: DatosFiscalesComprobante | null } = {}) {
  const repo = {
    buscarPorId: jest.fn().mockResolvedValue(opciones.comprobante === undefined ? cpe() : opciones.comprobante),
    buscarPorSerieNumero: jest.fn().mockResolvedValue(opciones.comprobante === undefined ? cpe() : opciones.comprobante),
    datosFiscales: jest.fn().mockResolvedValue(opciones.fiscal === undefined ? fiscal() : opciones.fiscal),
    notasDe: jest.fn().mockResolvedValue([]),
    guiasDe: jest.fn().mockResolvedValue([]),
    listar: jest.fn(),
    datosListado: jest.fn().mockResolvedValue(new Map()),
  };
  const emision = crearEmisionFalsa(crearBdFalsa(), CONTEXTO_PRODUCCION);
  emision.obtenerEnvio.mockResolvedValue(envio());
  const config = crearConfigFalsa({
    emisor_ruc: '20610206337',
    emisor_razon_social: 'HATUNSALES S.A.C.',
    emisor_direccion: 'LT. 8 MZ. N1 URB. NUEVO LURIN',
    emisor_ubicacion: 'LURIN - LIMA - LIMA',
    emisor_logo_url: 'https://ejemplo.invalid/logo.png',
  });
  const servicio = new ComprobanteBussnies(repo as never, crearReceptorFalso() as never, config as never, emision as never);
  return { servicio, repo, emision };
}

describe('ComprobanteBussnies: detalle, listado, acciones y descargas', () => {
  beforeAll(silenciarLogs);
  afterEach(() => jest.useRealTimers());

  describe('detalle', () => {
    it('trae el emisor con el que se firmó (envío guardado), QR, hash, hora, envío, archivos y acciones', async () => {
      const { servicio } = crear({
        comprobante: cpe({ ambiente_fiscal: 'beta' }),
        fiscal: fiscal({ emisor_envio: { ...EMISOR_BETA } as unknown as Record<string, unknown> }),
      });

      const detalle = await servicio.obtenerDetalle(50);

      expect(detalle.emisor).toMatchObject({
        ruc: EMISOR_BETA.ruc,
        razon_social: EMISOR_BETA.razonSocial,
        ubicacion: 'LIMA - LIMA - LIMA',
        logo_url: 'https://ejemplo.invalid/logo.png',
      });
      expect(detalle).toMatchObject({
        cadena_qr: expect.stringContaining('|F001|12|'),
        codigo_hash: 'HASH',
        hora_emision: '10:15:30',
        forma_pago: 'Contado',
        cuotas: [],
        fecha_limite_envio: '2026-10-24',
        envio: { id_envio: 501, estado: 'ACEPTADO', codigo: '0', accion: 'NINGUNA', intento: 1 },
        archivos: ['xml_original', 'xml_firmado', 'zip', 'cdr_xml', 'cdr_zip'],
        aviso: 'Prueba SUNAT BETA: sin validez tributaria.',
        referencia: null,
        id_venta: 9,
      });
    });

    it('sin envío guardado usa el emisor del ambiente vigente; un histórico, el emisor configurado', async () => {
      const directo = crear();
      expect((await directo.servicio.obtenerDetalle(50)).emisor).toMatchObject({ ruc: '20610206337', ubicacion: 'LURIN - LIMA - LIMA' });

      const historico = crear({ comprobante: cpe({ proveedor_fiscal: 'nubefact', id_envio_ultimo: null, ambiente_fiscal: null }) });
      const detalle = await historico.servicio.obtenerDetalle(50);
      expect(detalle.emisor).toMatchObject({ ruc: '20610206337', razon_social: 'HATUNSALES S.A.C.' });
      expect(detalle.envio).toBeNull();
      expect(historico.emision.obtenerEnvio).not.toHaveBeenCalled();
    });

    it('al crédito muestra la forma de pago y las cuotas guardadas', async () => {
      const { servicio } = crear({
        fiscal: fiscal({ forma_pago: 'Credito', cuotas: [{ numero: 1, monto: 59, fechaPago: '2026-11-05' }] }),
      });

      const detalle = await servicio.obtenerDetalle(50);

      expect(detalle.forma_pago).toBe('Credito');
      expect(detalle.cuotas).toEqual([{ numero: 1, monto: 59, fecha_pago: '2026-11-05' }]);
    });

    it('una nota trae la referencia a su origen; el origen trae sus notas y guías', async () => {
      const nota = crear({
        comprobante: cpe({ id_comprobante: 60, tipo: { id_tipo: 7 }, serie: 'FC01', numero: 1 }),
        fiscal: fiscal({
          doc_modificado_tipo: '01',
          doc_modificado_serie: 'F001',
          doc_modificado_numero: 12,
          id_comprobante_modificado: 50,
          nota_motivo: '07',
          nota_sustento: 'Devolución parcial',
        }),
      });
      expect((await nota.servicio.obtenerDetalle(60)).referencia).toEqual({
        id_comprobante: 50,
        tipo: '01',
        serie: 'F001',
        numero: 12,
        numero_formateado: 'F001-00000012',
        motivo: '07',
        motivo_descripcion: 'DEVOLUCION POR ITEM',
        sustento: 'Devolución parcial',
      });

      const origen = crear();
      origen.repo.notasDe.mockResolvedValue([
        { id_comprobante: 60, id_tipo: 7, serie: 'FC01', numero: 1, total: 59, estado: 'emitido', estado_sunat: 'ACEPTADO', anulado: false, aceptada_sunat: true, motivo: '07' },
      ]);
      origen.repo.guiasDe.mockResolvedValue([{ id_guia: 3, serie: 'T001', numero: 4, estado: 'aceptado', fecha_emision: '2026-10-21' }]);
      const detalle = await origen.servicio.obtenerDetalle(50);
      expect(detalle.notas).toEqual([
        expect.objectContaining({ id_comprobante: 60, numero_formateado: 'FC01-00000001', estado: 'aceptado', motivo: '07' }),
      ]);
      expect(detalle.guias).toEqual([expect.objectContaining({ id_guia: 3, numero_formateado: 'T001-00000004', estado: 'aceptado' })]);
    });

    it('si el envío, las notas o las guías no se pueden leer, el detalle igual se muestra', async () => {
      const { servicio, repo, emision } = crear();
      emision.obtenerEnvio.mockRejectedValue(new Error('esquema pendiente'));
      repo.notasDe.mockRejectedValue(new Error('timeout'));
      repo.guiasDe.mockRejectedValue(new Error('timeout'));

      const detalle = await servicio.obtenerDetalle(50);

      expect(detalle.envio).toBeNull();
      expect(detalle.notas).toEqual([]);
      expect(detalle.guias).toEqual([]);
      expect(detalle.numero_formateado).toBe('F001-00000012');
    });

    it('404 si no existe', async () => {
      const { servicio } = crear({ comprobante: null });
      await expect(servicio.obtenerDetalle(999)).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('listado: banderas de acciones', () => {
    async function fila(comprobante: Comprobante, extra: Partial<DatosListadoComprobante> = {}) {
      jest.useFakeTimers({ now: new Date('2026-10-21T15:00:00Z') });
      const { servicio, repo } = crear();
      repo.listar.mockResolvedValue({ datos: [comprobante], total: 1, pagina: 1, por_pagina: 20 });
      repo.datosListado.mockResolvedValue(
        new Map([[comprobante.id_comprobante, {
          fecha_limite_envio: '2026-10-24',
          doc_modificado_tipo: null,
          doc_modificado_serie: null,
          doc_modificado_numero: null,
          id_comprobante_modificado: null,
          envio_accion: 'NINGUNA',
          envio_libre: true,
          ...extra,
        }]]),
      );
      const resultado = await servicio.listar({});
      return resultado.datos[0];
    }

    it('factura aceptada del ambiente vigente: admite nota de crédito y anular la venta, nada que reintentar', async () => {
      expect(await fila(cpe())).toMatchObject({
        puede_nota_credito: true,
        puede_anular: true,
        puede_reintentar: false,
        puede_recuperar_cdr: false,
        puede_confirmar_manual: false,
        vencido: false,
        id_venta: 9,
        accion_sunat: 'NINGUNA',
        fecha_limite_envio: '2026-10-24',
      });
    });

    it('no ofrece nota de crédito para BETA (otro ambiente), históricos ni anulados', async () => {
      expect((await fila(cpe({ ambiente_fiscal: 'beta' }))).puede_nota_credito).toBe(false);
      expect((await fila(cpe({ proveedor_fiscal: 'nubefact' }))).puede_nota_credito).toBe(false);
      const anulado = await fila(cpe({ anulado: true }));
      expect(anulado).toMatchObject({ puede_nota_credito: false, puede_anular: false, estado: 'anulado' });
    });

    it('pendiente de reenvío: se reintenta; si SUNAT pidió recuperar el CDR de una boleta, solo se confirma a mano', async () => {
      const pendiente = cpe({ estado: 'pendiente', aceptada_sunat: false, estado_sunat: 'PENDIENTE_REENVIO' });
      expect(await fila(pendiente, { envio_accion: 'REINTENTAR' })).toMatchObject({
        puede_reintentar: true,
        puede_confirmar_manual: false,
        puede_nota_credito: false,
      });

      const boleta = cpe({ tipo: { id_tipo: 2 }, serie: 'B001', estado: 'pendiente', aceptada_sunat: false, estado_sunat: 'PENDIENTE_REENVIO' });
      expect(await fila(boleta, { envio_accion: 'RECUPERAR_CDR' })).toMatchObject({
        puede_reintentar: false,
        puede_recuperar_cdr: false,
        puede_confirmar_manual: true,
      });
    });

    it('factura de producción con envío incierto: reintento y recuperación del CDR; bloqueada por otro proceso, no', async () => {
      const incierta = cpe({ estado: 'pendiente', aceptada_sunat: false, estado_sunat: 'ENVIANDO' });
      expect(await fila(incierta, { envio_libre: true, envio_accion: null })).toMatchObject({
        puede_reintentar: true,
        puede_recuperar_cdr: true,
      });
      expect(await fila(incierta, { envio_libre: false, envio_accion: null })).toMatchObject({ puede_reintentar: false });
    });

    it('vencido: pasó el plazo sin aceptación y ya no se ofrece reenviar', async () => {
      const pendiente = cpe({ estado: 'pendiente', aceptada_sunat: false, estado_sunat: 'PENDIENTE_REENVIO' });
      expect(await fila(pendiente, { fecha_limite_envio: '2026-10-20', envio_accion: 'REINTENTAR' })).toMatchObject({
        vencido: true,
        puede_reintentar: false,
        puede_recuperar_cdr: true,
      });
    });

    it('una nota muestra el documento que modifica', async () => {
      const nota = cpe({ id_comprobante: 60, tipo: { id_tipo: 7 }, serie: 'FC01', numero: 1 });
      expect(await fila(nota, { doc_modificado_serie: 'F001', doc_modificado_numero: 12, id_comprobante_modificado: 50 })).toMatchObject({
        doc_modificado: 'F001-12',
        id_comprobante_modificado: 50,
        puede_nota_credito: false,
        puede_anular: false,
      });
    });

    it('valida los filtros nuevos antes de consultar', async () => {
      const { servicio, repo } = crear();
      await expect(servicio.listar({ ambiente: 'pruebas' })).rejects.toBeInstanceOf(BadRequestException);
      await expect(servicio.listar({ estado_sunat: 'aceptado; DROP' })).rejects.toBeInstanceOf(BadRequestException);
      await expect(servicio.listar({ desde: '2026-02-30' })).rejects.toBeInstanceOf(BadRequestException);
      expect(repo.listar).not.toHaveBeenCalled();
    });
  });

  describe('reintento, recuperación y confirmación', () => {
    it('reintentar usa el último envío y responde con el estado de SUNAT', async () => {
      const { servicio, emision } = crear({ comprobante: cpe({ estado: 'pendiente', aceptada_sunat: false, estado_sunat: 'PENDIENTE_REENVIO' }) });
      emision.reintentar.mockResolvedValue(resultadoEmision({ ambiente: 'produccion', id_envio: 501 }));

      const respuesta = await servicio.reintentar(50);

      expect(emision.reintentar).toHaveBeenCalledWith(501);
      expect(respuesta).toMatchObject({ id_comprobante: 50, serie: 'F001', numero: 12, estado: 'emitido', ambiente_fiscal: 'produccion', aviso: null });
    });

    it('un comprobante histórico o sin envío no se reintenta ni consulta por otro proveedor', async () => {
      const { servicio, emision } = crear({ comprobante: cpe({ proveedor_fiscal: 'nubefact', id_envio_ultimo: null }) });

      await expect(servicio.reintentar(50)).rejects.toThrow('no tiene un envío electrónico');
      await expect(servicio.recuperarCdr(50)).rejects.toThrow('no tiene un envío electrónico');
      expect(emision.reintentar).not.toHaveBeenCalled();
      expect(emision.recuperarCdr).not.toHaveBeenCalled();
    });

    it('recuperarCdr y confirmarAceptado delegan en la emisión con el envío, el usuario y la nota', async () => {
      const { servicio, emision } = crear();
      emision.recuperarCdr.mockResolvedValue(resultadoEmision({ ambiente: 'produccion' }));
      emision.confirmarAceptadoManual.mockResolvedValue(resultadoEmision({ ambiente: 'beta' }));

      await servicio.recuperarCdr(50);
      const confirmado = await servicio.confirmarAceptado(50, 1, 'Verificado en SOL: aceptado el 21/10');

      expect(emision.recuperarCdr).toHaveBeenCalledWith(501);
      expect(emision.confirmarAceptadoManual).toHaveBeenCalledWith(501, 1, 'Verificado en SOL: aceptado el 21/10');
      expect(confirmado.aviso).toBe('Prueba SUNAT BETA: sin validez tributaria.');
      await expect(servicio.confirmarAceptado(50, 1, 'ok')).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('consultar', () => {
    it('con un envío incierto de una factura de producción recupera la constancia (nunca 503)', async () => {
      const { servicio, emision } = crear({ comprobante: cpe({ estado: 'pendiente', aceptada_sunat: false, estado_sunat: 'ENVIANDO' }) });
      emision.recuperarCdr.mockResolvedValue(resultadoEmision({ ambiente: 'produccion' }));

      const respuesta = await servicio.consultar({ tipo_de_comprobante: 1, serie: 'f001', numero: 12 });

      expect(emision.recuperarCdr).toHaveBeenCalledWith(501);
      expect(respuesta.estado).toBe('emitido');
    });

    it('una boleta, o algo ya resuelto, devuelve el estado guardado sin llamar a SUNAT', async () => {
      const boleta = crear({ comprobante: cpe({ tipo: { id_tipo: 2 }, serie: 'B001', estado: 'pendiente', aceptada_sunat: false, estado_sunat: 'ENVIANDO' }) });
      expect(await boleta.servicio.consultar({ tipo_de_comprobante: 2, serie: 'B001', numero: 12 })).toMatchObject({ estado: 'pendiente' });
      expect(boleta.emision.recuperarCdr).not.toHaveBeenCalled();

      const aceptada = crear();
      expect(await aceptada.servicio.consultar({ tipo_de_comprobante: 1, serie: 'F001', numero: 12 })).toMatchObject({ estado: 'aceptado' });
      expect(aceptada.emision.recuperarCdr).not.toHaveBeenCalled();
    });

    it('si SUNAT no responde informa el estado guardado con el motivo', async () => {
      const { servicio, emision } = crear({ comprobante: cpe({ estado: 'pendiente', aceptada_sunat: false, estado_sunat: 'PENDIENTE_REENVIO' }) });
      emision.recuperarCdr.mockRejectedValue(new Error('ETIMEDOUT'));

      const respuesta = await servicio.consultar({ tipo_de_comprobante: 1, serie: 'F001', numero: 12 });

      expect(respuesta.estado).toBe('pendiente');
      expect(respuesta.error).toContain('ETIMEDOUT');
    });

    it('404 si no existe o el tipo no coincide', async () => {
      const { servicio } = crear();
      await expect(servicio.consultar({ tipo_de_comprobante: 2, serie: 'F001', numero: 12 })).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  it('anular y consultar anulación indican usar «Anular venta» (409, sin tocar SUNAT)', async () => {
    const { servicio, emision } = crear();
    await expect(servicio.anular({ id_comprobante: 50, motivo: 'error' })).rejects.toBeInstanceOf(ConflictException);
    await expect(servicio.anular({ id_comprobante: 50, motivo: 'error' })).rejects.toThrow('«Anular venta»');
    await expect(servicio.consultarAnulacion({ tipo_de_comprobante: 1, serie: 'F001', numero: 12 })).rejects.toThrow('«Anular venta»');
    expect(emision.reintentar).not.toHaveBeenCalled();
  });

  describe('catálogo de motivos (SUNAT, no el legado)', () => {
    it('ofrece solo los motivos de nota de crédito soportados, con su forma y tipos de origen', () => {
      const { servicio } = crear();
      const { nota_credito } = servicio.catalogoMotivos('2026-10-21');

      expect(nota_credito.map((m) => m.codigo)).toEqual(['01', '02', '05', '06', '07', '09', '10']);
      expect(nota_credito.find((m) => m.codigo === '01')).toEqual({ codigo: '01', nombre: 'ANULACION DE LA OPERACION', forma: 'total', tipos: ['01', '03'] });
      expect(nota_credito.find((m) => m.codigo === '05')).toMatchObject({ forma: 'descuento_items', tipos: ['01'] });
      expect(nota_credito.find((m) => m.codigo === '07')).toMatchObject({ forma: 'items' });
      expect(nota_credito.find((m) => m.codigo === '09')).toMatchObject({ forma: 'monto' });
    });

    it('la nota de débito 13 (penalidades) aparece recién con las reglas 2027', () => {
      const { servicio } = crear();
      expect(servicio.catalogoMotivos('2026-10-21').nota_debito.map((m) => m.codigo)).toEqual(['01', '02', '03']);
      expect(servicio.catalogoMotivos('2027-01-02').nota_debito.map((m) => m.codigo)).toEqual(['01', '02', '03', '13']);
    });
  });

  describe('representación impresa y archivos', () => {
    beforeEach(() => generarPdf.mockClear());

    it('arma los datos del PDF con lo guardado (QR, hash, fechas impresas, valores unitarios del XML)', async () => {
      const { servicio } = crear();

      const pdf = await servicio.obtenerPdf(50, 'ticket');

      expect(pdf.nombre).toBe('F001-00000012-ticket.pdf');
      expect(pdf.contenido.toString()).toContain('%PDF');
      const [datos, opciones] = generarPdf.mock.calls[0];
      expect(opciones).toEqual({ formato: 'ticket' });
      expect(datos).toMatchObject({
        tipo: '01',
        serie: 'F001',
        numero: 12,
        fechaEmision: '21/10/2026',
        horaEmision: '10:15:30',
        fechaVencimiento: null,
        moneda: 'PEN',
        emisor: { ruc: '20610206337', razonSocial: 'HATUNSALES S.A.C.' },
        cliente: { tipoDoc: '6', numDoc: '20123456789' },
        cadenaQr: expect.stringContaining('|F001|12|'),
        codigoHash: 'HASH',
        ambiente: 'produccion',
        avisoEstado: null,
        importeEnLetras: 'SON: CINCUENTA Y NUEVE CON 00/100 SOLES',
        formaPago: { tipo: 'Contado', cuotas: [] },
        totales: { gravada: 50, igv: 9, total: 59, porcentajeIgv: 18 },
      });
      expect(datos.items[0]).toMatchObject({ valorUnitario: 50, precioUnitario: 59, importe: 59, unidad: 'NIU' });
    });

    it('marca BETA y el estado si SUNAT todavía no lo aceptó', async () => {
      const { servicio } = crear({ comprobante: cpe({ ambiente_fiscal: 'beta', estado: 'pendiente', aceptada_sunat: false, estado_sunat: 'PENDIENTE_REENVIO' }) });

      await servicio.obtenerPdf(50);

      expect(generarPdf.mock.calls[0][0]).toMatchObject({ ambiente: 'beta', avisoEstado: 'PENDIENTE DE CONFIRMACIÓN DE SUNAT' });
      expect(generarPdf.mock.calls[0][1]).toEqual({ formato: 'a4' });
    });

    it('si el generador falla responde 500 con un mensaje accionable', async () => {
      const { servicio } = crear();
      generarPdf.mockRejectedValueOnce(new Error('pdfkit roto'));

      const error = await servicio.obtenerPdf(50).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(InternalServerErrorException);
      expect((error as InternalServerErrorException).getResponse()).toMatchObject({ codigo: 'COMPROBANTE_PDF_ERROR' });
    });

    it('archivos: del último envío; 404 si es histórico o si el archivo aún no existe', async () => {
      const { servicio, emision } = crear();
      emision.obtenerArchivo.mockResolvedValueOnce({ nombre: 'R-20610206337-01-F001-00000012.xml', mime: 'application/xml', contenido: Buffer.from('<cdr/>') });
      await expect(servicio.obtenerArchivo(50, 'cdr_xml')).resolves.toMatchObject({ mime: 'application/xml' });
      expect(emision.obtenerArchivo).toHaveBeenCalledWith(501, 'cdr_xml');

      emision.obtenerArchivo.mockResolvedValueOnce(null);
      await expect(servicio.obtenerArchivo(50, 'cdr_zip')).rejects.toThrow('todavía no tiene constancia (CDR)');

      const historico = crear({ comprobante: cpe({ proveedor_fiscal: 'nubefact', id_envio_ultimo: null }) });
      await expect(historico.servicio.obtenerArchivo(50, 'zip')).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});

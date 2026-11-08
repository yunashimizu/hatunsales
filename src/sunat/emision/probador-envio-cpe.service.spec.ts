import type { FiscalEsquemaService } from '../config/fiscal-esquema.service';
import type { ContextoPruebaEnvio } from '../config/fiscal-tokens';
import { RelojFiscal } from '../config/reloj-fiscal';
import type { DocumentoCpe } from '../nucleo/documento-fiscal.types';
import type { ResultadoEmision } from './emision.contrato';
import type { EnvioFiscalRepository } from './envio-fiscal.repository';
import { ProbadorEnvioCpeService } from './probador-envio-cpe.service';
import type { SunatEmisionService } from './sunat-emision.service';

class RelojPrueba extends RelojFiscal {
  ahora(): Date {
    return new Date('2026-11-08T15:00:00Z');
  }
}

const EMISOR = {
  ruc: '20614736420',
  razonSocial: 'EMISOR DE PRUEBAS',
  direccion: 'DOMICILIO DE PRUEBA',
  ubigeo: '150101',
  distrito: 'LIMA',
  provincia: 'LIMA',
  departamento: 'LIMA',
  codigoEstablecimiento: '0000',
};

function contexto(tipoCpe: ContextoPruebaEnvio['tipoCpe'], ambiente: 'beta' | 'produccion' = 'beta'): ContextoPruebaEnvio {
  return { ambiente, documento: 'cpe', tipoCpe, emisor: EMISOR as never, material: {} as never, idUsuario: 4 };
}

/** emitirPrueba simulado: numera envíos desde 100 y deja que cada caso decida si SUNAT acepta cada serie. */
function crear(opciones: { rechazar?: string[]; lanzar?: string[] } = {}) {
  const siguientes: Record<string, number> = { FB01: 7, BB01: 3, FBC1: 2, FBD1: 1 };
  let idEnvio = 100;
  const emision = {
    emitirPrueba: jest.fn(async (documento: DocumentoCpe): Promise<ResultadoEmision> => {
      if (opciones.lanzar?.includes(documento.serie)) throw Object.assign(new Error('No se pudo guardar la respuesta'), { codigo: 'FISCAL_SUNAT_NO_DISPONIBLE' });
      const aceptado = !opciones.rechazar?.includes(documento.serie);
      idEnvio += 1;
      return {
        ambiente: 'beta',
        id_envio: idEnvio,
        nombre_base: `${EMISOR.ruc}-${documento.tipo}-${documento.serie}-${String(documento.numero).padStart(8, '0')}`,
        estado: aceptado ? 'ACEPTADO' : 'RECHAZADO',
        aceptado,
        codigo: aceptado ? '0' : '2017',
        mensaje: aceptado ? 'Aceptada' : 'Rechazada',
        observaciones: [],
        digest: 'D',
        cadena_qr: 'Q',
        archivos: ['xml_original', 'xml_firmado', 'zip', 'cdr_xml', 'cdr_zip'],
        tiempo_sunat_ms: 1000 + idEnvio,
      };
    }),
  };
  const envios = { siguienteNumeroPruebaBeta: jest.fn(async (serie: string) => siguientes[serie] ?? 1) };
  const esquema = { exigir: jest.fn(async () => undefined) };
  const probador = new ProbadorEnvioCpeService(
    emision as unknown as SunatEmisionService,
    envios as unknown as EnvioFiscalRepository,
    esquema as unknown as FiscalEsquemaService,
    new RelojPrueba(),
  );
  const enviados = () => emision.emitirPrueba.mock.calls.map((c) => c[0] as DocumentoCpe);
  return { probador, emision, envios, enviados };
}

describe('ProbadorEnvioCpeService: «Los 4 documentos» en BETA', () => {
  it('manda en serie factura → boleta → NC → ND (4 sendBill) y las notas modifican la factura recién enviada', async () => {
    const { probador, enviados } = crear();

    const pasos = await probador.probar(contexto('todos'));

    expect(enviados().map((d) => [d.tipo, d.serie, d.numero])).toEqual([
      ['01', 'FB01', 7],
      ['03', 'BB01', 3],
      ['07', 'FBC1', 2],
      ['08', 'FBD1', 1],
    ]);
    const [, , nc, nd] = enviados();
    expect(nc.referencia).toMatchObject({ tipoDoc: '01', serie: 'FB01', numero: 7, motivo: '01' });
    expect(nd.referencia).toMatchObject({ tipoDoc: '01', serie: 'FB01', numero: 7, motivo: '01' });

    expect(pasos.map((p) => [p.paso, p.documento, p.ok, p.envio_id, p.codigo, p.tiempo_ms])).toEqual([
      ['respuesta_sunat', '01', true, 101, '0', 1101],
      ['respuesta_sunat', '03', true, 102, '0', 1102],
      ['respuesta_sunat', '07', true, 103, '0', 1103],
      ['respuesta_sunat', '08', true, 104, '0', 1104],
    ]);
    expect(pasos[2].detalle).toContain('modifica FB01-7');
  });

  it('el siguiente número se pide justo antes de cada envío (en serie, nunca en paralelo)', async () => {
    const { probador, envios, emision } = crear();
    await probador.probar(contexto('todos'));
    const orden = [
      ...envios.siguienteNumeroPruebaBeta.mock.invocationCallOrder.map((n, i) => ({ n, que: `numero:${envios.siguienteNumeroPruebaBeta.mock.calls[i][0]}` })),
      ...emision.emitirPrueba.mock.invocationCallOrder.map((n, i) => ({ n, que: `envio:${(emision.emitirPrueba.mock.calls[i][0] as DocumentoCpe).serie}` })),
    ]
      .sort((a, b) => a.n - b.n)
      .map((x) => x.que);
    expect(orden).toEqual(['numero:FB01', 'envio:FB01', 'numero:BB01', 'envio:BB01', 'numero:FBC1', 'envio:FBC1', 'numero:FBD1', 'envio:FBD1']);
  });

  it('si SUNAT no acepta la factura, las notas no se envían y quedan «no intentadas» (2 sendBill)', async () => {
    const { probador, enviados } = crear({ rechazar: ['FB01'] });

    const pasos = await probador.probar(contexto('todos'));

    expect(enviados().map((d) => d.serie)).toEqual(['FB01', 'BB01']);
    expect(pasos.map((p) => [p.documento, p.ok])).toEqual([
      ['01', false],
      ['03', true],
      ['07', null],
      ['08', null],
    ]);
    expect(pasos[2].detalle).toMatch(/No se intentó: SUNAT no aceptó la factura FB01-7/);
  });

  it('un error al enviar un documento queda en su paso y no borra lo que ya respondió SUNAT', async () => {
    const { probador, enviados } = crear({ lanzar: ['BB01'] });

    const pasos = await probador.probar(contexto('todos'));

    // La boleta se intentó (y falló); la factura aceptada sigue habilitando las notas.
    expect(enviados().map((d) => d.serie)).toEqual(['FB01', 'BB01', 'FBC1', 'FBD1']);
    expect(pasos.map((p) => [p.documento, p.ok, p.codigo])).toEqual([
      ['01', true, '0'],
      ['03', false, 'FISCAL_SUNAT_NO_DISPONIBLE'],
      ['07', true, '0'],
      ['08', true, '0'],
    ]);
  });

  it('en PRODUCCIÓN no envía nada', async () => {
    const { probador, emision } = crear();
    const pasos = await probador.probar(contexto('todos', 'produccion'));
    expect(emision.emitirPrueba).not.toHaveBeenCalled();
    expect(pasos).toEqual([expect.objectContaining({ paso: 'envio', ok: null })]);
  });
});

describe('ProbadorEnvioCpeService: un solo documento', () => {
  it('nota de crédito: factura base y luego la nota, ambas con documento, tiempo de SUNAT y envío', async () => {
    const { probador, enviados } = crear();

    const pasos = await probador.probar(contexto('07'));

    expect(enviados().map((d) => [d.tipo, d.serie])).toEqual([
      ['01', 'FB01'],
      ['07', 'FBC1'],
    ]);
    expect(pasos.map((p) => p.paso)).toEqual(['comprobante_base', 'xml', 'firma_xml', 'zip', 'respuesta_sunat']);
    expect(pasos[0]).toMatchObject({ documento: '01', ok: true, envio_id: 101, tiempo_ms: 1101 });
    expect(pasos.at(-1)).toMatchObject({ documento: '07', ok: true, envio_id: 102, tiempo_ms: 1102, codigo: '0' });
  });

  it('nota de débito sobre una factura no aceptada: se detiene tras la factura base', async () => {
    const { probador, enviados } = crear({ rechazar: ['FB01'] });
    const pasos = await probador.probar(contexto('08'));
    expect(enviados()).toHaveLength(1);
    expect(pasos).toEqual([expect.objectContaining({ paso: 'comprobante_base', ok: false, documento: '01' })]);
  });

  it('boleta (o sin tipo: factura) envía un solo documento como siempre', async () => {
    const boleta = crear();
    const pasos = await boleta.probador.probar(contexto('03'));
    expect(boleta.enviados().map((d) => d.serie)).toEqual(['BB01']);
    expect(pasos.at(-1)).toMatchObject({ paso: 'respuesta_sunat', documento: '03', tiempo_ms: 1101 });

    const factura = crear();
    await factura.probador.probar(contexto(undefined));
    expect(factura.enviados().map((d) => d.serie)).toEqual(['FB01']);
  });
});

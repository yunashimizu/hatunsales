import type { DataSource } from 'typeorm';
import { FiscalConfigError } from '../config/fiscal-errores';
import type { TransaccionesFiscales } from '../config/transacciones-fiscales';
import type { CierreEnvio } from '../emision/emision.tipos';
import { EnvioFiscalRepository } from '../emision/envio-fiscal.repository';
import type { LotePreparado } from '../nucleo/preparador-envio-cpe';
import { efectoDelCierre, LoteFiscalRepository, RegistroLoteNuevo } from './lote-fiscal.repository';

type Llamada = { sql: string; parametros: unknown[] };

/** Consultor falso: anota SQL y parámetros y responde según el texto de la consulta. */
function consultorFalso(respuestas: Array<[RegExp, unknown]> = []) {
  const llamadas: Llamada[] = [];
  const query = jest.fn(async (sql: string, parametros: unknown[] = []) => {
    llamadas.push({ sql, parametros });
    for (const [patron, respuesta] of respuestas) {
      if (patron.test(sql)) return typeof respuesta === 'function' ? (respuesta as (p: unknown[]) => unknown)(parametros) : respuesta;
    }
    return [];
  });
  return { query, llamadas };
}

function crear(respuestas: Array<[RegExp, unknown]> = []) {
  const bd = consultorFalso(respuestas);
  const tx = consultorFalso(respuestas);
  const transacciones = { ejecutar: jest.fn(async (trabajo: (e: typeof tx) => Promise<unknown>) => trabajo(tx)) };
  const envios = new EnvioFiscalRepository(bd as unknown as DataSource, transacciones as unknown as TransaccionesFiscales);
  const repositorio = new LoteFiscalRepository(bd as unknown as DataSource, transacciones as unknown as TransaccionesFiscales, envios);
  return { repositorio, bd, tx, transacciones };
}

const LOTE: LotePreparado = {
  identificador: 'RA-20261105-00001',
  nombreBase: '20610206337-RA-20261105-00001',
  xmlFirmado: '<VoidedDocuments><ds:Signature/></VoidedDocuments>',
  digestValue: 'DIGEST==',
  signatureValue: 'FIRMA==',
  zip: { nombreZip: '20610206337-RA-20261105-00001.zip', nombreXml: '20610206337-RA-20261105-00001.xml', zip: Buffer.from('PK-zip'), base64: 'UEstemlw', sha256: 'abc' },
};

function registro(cambios: Partial<RegistroLoteNuevo> = {}): RegistroLoteNuevo {
  return {
    ambiente: 'produccion',
    operacion: 'baja',
    lote: LOTE,
    fechaReferencia: '2026-11-03',
    idUsuario: 4,
    motivo: 'Error en el monto',
    lineas: [{ id_comprobante: 40, serie: 'F001', numero: 12, tipo_documento: '01', condicion: 3 }],
    ...cambios,
  };
}

const RESPUESTAS_REGISTRO: Array<[RegExp, unknown]> = [
  [/INSERT INTO fiscal_envios/, [{ id_envio: 900 }]],
  [/UPDATE comprobantes/, [[{ id_comprobante: 40, previo: 'ACEPTADO_OBS' }], 1]],
];

describe('efectoDelCierre: qué pasa con los comprobantes del lote', () => {
  it.each([
    ['ACEPTADO', 'NINGUNA', 'anular'],
    ['ACEPTADO_OBS', 'NINGUNA', 'anular'],
    ['TICKET_PENDIENTE', 'CONSULTAR_TICKET', 'ninguno'],
    ['PENDIENTE_REENVIO', 'REINTENTAR', 'ninguno'],
    ['ENVIANDO', 'NINGUNA', 'ninguno'],
    ['EXCEPCION', 'CONSULTAR_TICKET', 'ninguno'],
    ['EXCEPCION', 'NINGUNA', 'restaurar'],
    ['RECHAZADO', 'CORREGIR_Y_REENVIAR', 'restaurar'],
    ['ERROR_CONFIG', 'REVISAR_CONFIG', 'restaurar'],
  ] as const)('%s con la acción %s → %s', (estado, accion, efecto) => {
    expect(efectoDelCierre({ estado, accion })).toBe(efecto);
  });
});

describe('LoteFiscalRepository.siguienteCorrelativo', () => {
  it('el mayor del día y el ambiente en CUALQUIER estado, más uno; el patrón lleva el prefijo y la fecha compactada', async () => {
    const { repositorio } = crear();
    const consultor = consultorFalso([[/MAX\(split_part/, [{ siguiente: '3' }]]]);

    expect(await repositorio.siguienteCorrelativo(consultor, 'produccion', 'RA', '2026-11-05')).toBe(3);

    const { sql, parametros } = consultor.llamadas[0];
    expect(sql).toContain(`t.operacion IN ('resumen', 'baja')`);
    expect(sql).not.toMatch(/t\.estado/);
    expect(parametros).toEqual(['produccion', '^RA-20261105-[0-9]{1,5}$']);
  });

  it('sin lotes ese día empieza en 1', async () => {
    const { repositorio } = crear();
    expect(await repositorio.siguienteCorrelativo(consultorFalso([[/MAX/, [{ siguiente: 1 }]]]), 'beta', 'RC', '2026-11-05')).toBe(1);
    expect(await repositorio.siguienteCorrelativo(consultorFalso(), 'beta', 'RC', '2026-11-05')).toBe(1);
  });
});

describe('LoteFiscalRepository.registrar (dentro de la transacción)', () => {
  it('lote ENVIANDO sin comprobante propio, sus 2 artefactos, el comprobante a BAJA_PENDIENTE y la línea con el estado previo', async () => {
    const { repositorio } = crear();
    const consultor = consultorFalso(RESPUESTAS_REGISTRO);

    const id = await repositorio.registrar(consultor, registro());

    expect(id).toBe(900);
    const [envio, artefactos, comprobantes, lineas] = consultor.llamadas;
    expect(envio.sql).toContain(`'sunat_directo', $3, 1, 'ENVIANDO'`);
    expect(envio.sql).toContain('id_comprobante, fecha_envio, bloqueado_hasta');
    expect(envio.parametros).toEqual([
      'RA',
      'produccion',
      'baja',
      '20610206337-RA-20261105-00001.zip',
      'RA-20261105-00001',
      '2026-11-03',
      4,
      60,
      expect.stringMatching(/^[0-9a-f]{64}$/),
      expect.stringContaining('"motivo":"Error en el monto"'),
    ]);

    expect(artefactos.sql).toContain('INSERT INTO fiscal_artifacts');
    expect(artefactos.parametros.slice(0, 2)).toEqual([900, null]);
    expect(artefactos.parametros).toEqual(expect.arrayContaining(['xml_firmado', 'zip', '20610206337-RA-20261105-00001.xml', '20610206337-RA-20261105-00001.zip']));
    expect(artefactos.parametros).not.toContain('xml_original');

    expect(comprobantes.sql).toMatch(/FOR UPDATE[\s\S]*SET estado_sunat = 'BAJA_PENDIENTE'[\s\S]*RETURNING c\.id_comprobante, p\.estado_sunat AS previo/);
    expect(comprobantes.parametros).toEqual([[40], ['ACEPTADO', 'ACEPTADO_OBS']]);

    expect(lineas.sql).toContain('INSERT INTO fiscal_resumen_lineas (id_envio, id_comprobante, linea, condicion, estado)');
    expect(lineas.parametros).toEqual([900, 40, 1, 3, 'ACEPTADO_OBS']);
  });

  it('un lote de varias líneas numera las líneas y guarda el estado previo de cada comprobante', async () => {
    const { repositorio } = crear();
    const consultor = consultorFalso([
      [/INSERT INTO fiscal_envios/, [{ id_envio: 901 }]],
      [/UPDATE comprobantes/, [[{ id_comprobante: 40, previo: 'ACEPTADO' }, { id_comprobante: 41, previo: 'ACEPTADO_OBS' }], 2]],
    ]);

    await repositorio.registrar(
      consultor,
      registro({
        operacion: 'resumen',
        lineas: [
          { id_comprobante: 40, serie: 'B001', numero: 1, tipo_documento: '03', condicion: 3 },
          { id_comprobante: 41, serie: 'B001', numero: 2, tipo_documento: '03', condicion: 3 },
        ],
      }),
    );

    const lineas = consultor.llamadas[3];
    expect(lineas.parametros).toEqual([901, 40, 1, 3, 'ACEPTADO', 41, 2, 3, 'ACEPTADO_OBS']);
    expect(consultor.llamadas[0].parametros.slice(0, 3)).toEqual(['RC', 'produccion', 'resumen']);
  });

  it('si algún comprobante ya no está aceptado y libre (otra baja, ya anulado) aborta con FISCAL_ENVIO_EN_CURSO antes de las líneas', async () => {
    const { repositorio } = crear();
    const consultor = consultorFalso([
      [/INSERT INTO fiscal_envios/, [{ id_envio: 900 }]],
      [/UPDATE comprobantes/, [[], 0]],
    ]);

    await expect(repositorio.registrar(consultor, registro())).rejects.toMatchObject({ codigo: 'FISCAL_ENVIO_EN_CURSO' });
    expect(consultor.llamadas.some((l) => l.sql.includes('fiscal_resumen_lineas'))).toBe(false);
  });

  it('un identificador que otro lote ya ocupó (uq_fiscal_envio_identificador) es FISCAL_NUMERO_OCUPADO; otro error se propaga', async () => {
    const { repositorio } = crear();
    const duplicado = Object.assign(new Error('duplicate key'), { code: '23505', constraint: 'uq_fiscal_envio_identificador' });
    const ocupado = { query: jest.fn().mockRejectedValue(duplicado) };
    await expect(repositorio.registrar(ocupado, registro())).rejects.toMatchObject({ codigo: 'FISCAL_NUMERO_OCUPADO' });
    await expect(repositorio.registrar(ocupado, registro())).rejects.toBeInstanceOf(FiscalConfigError);

    const roto = { query: jest.fn().mockRejectedValue(new Error('conexión perdida')) };
    await expect(repositorio.registrar(roto, registro())).rejects.toThrow('conexión perdida');
  });
});

describe('LoteFiscalRepository: reclamos', () => {
  it('primer envío: solo ENVIANDO intento 1 sin respuesta ni ticket; el reintento cuenta un intento y respeta el reclamo vigente', async () => {
    const { repositorio, bd } = crear();

    expect(await repositorio.reclamarPrimerEnvio(900)).toBeNull();
    expect(await repositorio.reclamarEnvio(900)).toBeNull();
    expect(await repositorio.reclamarConsulta(900)).toBeNull();

    const [primero, reintento, consulta] = bd.llamadas.map((l) => l.sql);
    expect(primero).toMatch(/e\.estado = 'ENVIANDO'\s+AND e\.intento = 1 AND e\.fecha_respuesta IS NULL AND e\.sunat_ticket IS NULL/);
    expect(primero).not.toMatch(/AND \(e\.bloqueado_hasta IS NULL OR e\.bloqueado_hasta < NOW\(\)\)/);
    expect(reintento).toMatch(/intento = e\.intento \+ 1/);
    expect(reintento).toContain(`e.estado IN ('PENDIENTE_REENVIO', 'ENVIANDO')`);
    expect(reintento).toContain('e.bloqueado_hasta < NOW()');
    expect(consulta).toContain('e.sunat_ticket IS NOT NULL');
    expect(consulta).toContain(`e.estado = 'EXCEPCION' AND e.respuesta_json #>> '{clasificacion,accion}' = 'CONSULTAR_TICKET'`);
    expect(consulta).not.toMatch(/intento = /);
    for (const llamada of bd.llamadas) expect(llamada.parametros).toEqual([900, 60]);
  });

  it('devuelve el lote con sus líneas, el ZIP y el nombre base sin extensión', async () => {
    const { repositorio } = crear([
      [/WITH tomado/, [{
        id_envio: 900, ambiente: 'produccion', operacion: 'baja', tipo_documento: 'RA', estado: 'ENVIANDO', intento: 2,
        nombre_archivo: '20610206337-RA-20261105-00001.zip', identificador: 'RA-20261105-00001', sunat_ticket: null,
        codigo_sunat: null, fecha_referencia: '2026-11-03', accion: null, libre: false, zip: Buffer.from('PK'),
      }]],
      [/FROM fiscal_resumen_lineas l LEFT JOIN comprobantes/, [{ id_envio: 900, id_comprobante: 40, linea: 1, condicion: 3, estado: 'ACEPTADO', serie: 'F001', numero: 12, id_tipo: 1 }]],
    ]);

    const lote = await repositorio.reclamarEnvio(900);

    expect(lote).toMatchObject({
      id_envio: 900,
      operacion: 'baja',
      nombre_base: '20610206337-RA-20261105-00001',
      intento: 2,
      libre: false,
      lineas: [{ id_comprobante: 40, serie: 'F001', numero: 12, tipo_documento: '01', condicion: 3, estado: 'ACEPTADO' }],
    });
    expect(lote?.zip).toEqual(Buffer.from('PK'));
  });
});

describe('LoteFiscalRepository.guardarTicket', () => {
  it('TICKET_PENDIENTE con el ticket, un intento más y la próxima consulta en N minutos; false si el lote ya no está abierto', async () => {
    const { repositorio, bd } = crear([[/UPDATE fiscal_envios/, [[{ id_envio: 900 }], 1]]]);

    expect(await repositorio.guardarTicket(900, '202611050001', 'SUNAT recibió el lote', 1)).toBe(true);

    const { sql, parametros } = bd.llamadas[0];
    expect(sql).toMatch(/estado = 'TICKET_PENDIENTE', sunat_ticket = \$2, intento = e\.intento \+ 1/);
    expect(sql).toContain(`proximo_intento_en = NOW() + $4::int * INTERVAL '1 minute', bloqueado_hasta = NULL, ultimo_error = NULL`);
    expect(parametros).toEqual([900, '202611050001', 'SUNAT recibió el lote', 1, expect.stringContaining('CONSULTAR_TICKET')]);

    const otro = crear([[/UPDATE fiscal_envios/, [[], 0]]]);
    expect(await otro.repositorio.guardarTicket(900, 't', 'm', 2)).toBe(false);
  });
});

describe('LoteFiscalRepository.completar', () => {
  const RESPUESTAS_COMPLETAR: Array<[RegExp, unknown]> = [
    [/UPDATE fiscal_envios/, [[{ tipo_documento: 'RA', operacion: 'baja', identificador: 'RA-20261105-00001' }], 1]],
    [/SELECT l\.id_comprobante FROM fiscal_resumen_lineas/, [{ id_comprobante: 40 }, { id_comprobante: 41 }]],
  ];

  function cierre(parcial: Partial<CierreEnvio>): CierreEnvio {
    return {
      estado: 'ACEPTADO',
      accion: 'NINGUNA',
      mensaje: 'La comunicación de baja fue aceptada',
      sunat: { codigo: '0', descripcion: 'aceptada', observaciones: [], tiempoMs: 120 },
      json: { clasificacion: { estado: 'ACEPTADO' } },
      proximoIntentoMin: null,
      ...parcial,
    };
  }

  it('aceptado: guarda el CDR, la línea ACEPTADO y deja los comprobantes ANULADO (solo los que seguían en BAJA_PENDIENTE)', async () => {
    const { repositorio, tx } = crear(RESPUESTAS_COMPLETAR);

    const cerrado = await repositorio.completar(900, 'produccion', '20610206337-RA-20261105-00001', cierre({ cdr: { xml: '<R/>', zip: Buffer.from('PK-cdr') } }));

    expect(cerrado).toEqual({
      id_comprobante: 40,
      ids_comprobantes: [40, 41],
      tipo_documento: 'RA',
      operacion: 'baja',
      identificador: 'RA-20261105-00001',
    });
    const sqls = tx.llamadas.map((l) => l.sql);
    expect(tx.llamadas[0].parametros[11]).toEqual(['ENVIANDO', 'PENDIENTE_REENVIO', 'TICKET_PENDIENTE', 'EXCEPCION']);
    expect(sqls[0]).toContain(`e.operacion IN ('resumen', 'baja')`);
    expect(tx.llamadas[1].parametros).toEqual(expect.arrayContaining(['cdr_xml', 'cdr_zip', 'R-20610206337-RA-20261105-00001.xml', 'R-20610206337-RA-20261105-00001.zip']));
    expect(sqls[2]).toContain(`SET estado = 'ACEPTADO' WHERE id_envio = $1`);
    expect(sqls[3]).toMatch(/SET estado_sunat = 'ANULADO'[\s\S]*c\.estado_sunat = 'BAJA_PENDIENTE'/);
    expect(tx.llamadas[3].parametros).toEqual([900, 'RA-20261105-00001']);
  });

  it('rechazado: devuelve a cada comprobante el estado que guardó su línea y recién después marca la línea RECHAZADO', async () => {
    const { repositorio, tx } = crear(RESPUESTAS_COMPLETAR);

    await repositorio.completar(900, 'produccion', 'x', cierre({ estado: 'RECHAZADO', accion: 'CORREGIR_Y_REENVIAR', sunat: { codigo: '2800', descripcion: 'inválido', observaciones: [], tiempoMs: 80 } }));

    const sqls = tx.llamadas.map((l) => l.sql);
    const restaurar = sqls.findIndex((s) => /SET estado_sunat = l\.estado/.test(s));
    const marcar = sqls.findIndex((s) => /SET estado = 'RECHAZADO'/.test(s));
    expect(restaurar).toBeGreaterThan(0);
    expect(marcar).toBeGreaterThan(restaurar);
    expect(sqls[restaurar]).toMatch(/c\.estado_sunat = 'BAJA_PENDIENTE' AND l\.estado = ANY/);
    expect(tx.llamadas[restaurar].parametros).toEqual([900, ['ACEPTADO', 'ACEPTADO_OBS']]);
    expect(sqls.some((s) => /'ANULADO'/.test(s))).toBe(false);
  });

  it.each([
    ['PENDIENTE_REENVIO', 'REINTENTAR'],
    ['EXCEPCION', 'CONSULTAR_TICKET'],
  ] as const)('%s (%s): no toca los comprobantes ni las líneas', async (estado, accion) => {
    const { repositorio, tx } = crear(RESPUESTAS_COMPLETAR);

    await repositorio.completar(900, 'produccion', 'x', cierre({ estado, accion, sunat: null, proximoIntentoMin: 2 }));

    expect(tx.llamadas.some((l) => /UPDATE comprobantes|UPDATE fiscal_resumen_lineas/.test(l.sql))).toBe(false);
  });

  it('si otro proceso ya cerró el lote devuelve null sin tocar artefactos ni comprobantes', async () => {
    const { repositorio, tx } = crear([[/UPDATE fiscal_envios/, [[], 0]]]);

    expect(await repositorio.completar(900, 'produccion', 'x', cierre({ cdr: { xml: '<R/>' } }))).toBeNull();
    expect(tx.llamadas).toHaveLength(1);
  });
});

describe('LoteFiscalRepository: lecturas', () => {
  it('listar: tope de 100 por página, solo lotes (resumen y baja) y las líneas agrupadas por lote', async () => {
    const { repositorio, bd } = crear([
      [/SELECT\s+t\.id_envio, t\.ambiente, t\.operacion/, [
        { id_envio: 12, ambiente: 'produccion', operacion: 'baja', identificador: 'RA-20261105-00001', estado: 'TICKET_PENDIENTE', sunat_ticket: 'T1', creado_en: new Date('2026-11-05T15:00:00Z'), archivos: ['zip', 'xml_firmado'] },
        { id_envio: 11, ambiente: 'produccion', operacion: 'resumen', identificador: 'RC-20261104-00001', estado: 'ACEPTADO', sunat_ticket: 'T0', creado_en: '2026-11-04T15:00:00Z', archivos: [] },
      ]],
      [/COUNT\(\*\)/, [{ total: 2 }]],
      [/FROM fiscal_resumen_lineas l LEFT JOIN comprobantes/, [
        { id_envio: 12, id_comprobante: 40, linea: 1, condicion: 3, estado: 'ACEPTADO', serie: 'F001', numero: 12, id_tipo: 1 },
        { id_envio: 11, id_comprobante: 41, linea: 1, condicion: 3, estado: 'ACEPTADO', serie: 'B001', numero: 3, id_tipo: 2 },
      ]],
    ]);

    const resultado = await repositorio.listar({ ambiente: 'produccion', por_pagina: 500, pagina: 2 });

    expect(resultado).toMatchObject({ total: 2, pagina: 2, por_pagina: 100 });
    expect(resultado.datos[0]).toMatchObject({
      id_envio: 12,
      operacion: 'baja',
      creado_en: '2026-11-05T15:00:00.000Z',
      archivos: ['xml_firmado', 'zip'],
      lineas: [{ id_comprobante: 40, tipo_documento: '01' }],
    });
    expect(resultado.datos[1].lineas).toEqual([expect.objectContaining({ serie: 'B001', tipo_documento: '03' })]);
    expect(bd.llamadas[0].sql).toContain(`t.operacion IN ('resumen', 'baja')`);
    expect(bd.llamadas[0].parametros).toEqual(['produccion', null, null, 100, 100]);
  });

  it('loteDeComprobante ignora las líneas rechazadas; lineasAceptadasSinAnular exige el lote ACEPTADO y el comprobante sin anular', async () => {
    const { repositorio, bd } = crear([
      [/FROM fiscal_resumen_lineas l\s+JOIN fiscal_envios e ON e\.id_envio = l\.id_envio AND e\.operacion IN \('resumen', 'baja'\)\s+WHERE/, [{ id_envio: 12, operacion: 'baja', identificador: 'RA-1', estado: 'TICKET_PENDIENTE', sunat_ticket: 'T1', mensaje: null }]],
      [/AND e\.estado IN \('ACEPTADO', 'ACEPTADO_OBS'\)/, [{ id_envio: 12, id_comprobante: 40 }]],
    ]);

    expect(await repositorio.loteDeComprobante(40)).toEqual({ id_envio: 12, operacion: 'baja', identificador: 'RA-1', estado: 'TICKET_PENDIENTE', sunat_ticket: 'T1', mensaje: null });
    expect(bd.llamadas[0].sql).toContain(`COALESCE(l.estado, '') <> 'RECHAZADO'`);

    expect(await repositorio.lineasAceptadasSinAnular(20)).toEqual([{ id_envio: 12, id_comprobante: 40 }]);
    expect(bd.llamadas[1].sql).toMatch(/l\.estado = 'ACEPTADO' AND l\.condicion = 3 AND COALESCE\(c\.anulado, FALSE\) = FALSE/);
    expect(bd.llamadas[1].parametros).toEqual([20]);
  });

  it('candidatosTarea: del ambiente vigente, con el turno cumplido y sin reclamo vigente', async () => {
    const { repositorio, bd } = crear([[/SELECT t\.id_envio/, [{ id_envio: 3 }, { id_envio: 8 }]]]);

    expect(await repositorio.candidatosTarea('beta', 10)).toEqual([3, 8]);

    const { sql, parametros } = bd.llamadas[0];
    expect(sql).toContain(`t.estado IN ('PENDIENTE_REENVIO', 'TICKET_PENDIENTE')`);
    expect(sql).toContain('t.proximo_intento_en <= NOW()');
    expect(sql).toContain('t.bloqueado_hasta < NOW()');
    expect(parametros).toEqual(['beta', 10]);
  });
});

import type { DataSource } from 'typeorm';
import type { TransaccionesFiscales } from '../config/transacciones-fiscales';
import type { DocumentoCpe } from '../nucleo/documento-fiscal.types';
import type { EnvioCpePreparado } from '../nucleo/preparador-envio-cpe';
import { facturaPrueba } from '../nucleo/pruebas/documentos-prueba-spec';
import { FiscalConfigError } from '../config/fiscal-errores';
import { MAXIMO_ENVIOS_POR_PAGINA } from './emision.contrato';
import { cuotasDe, EnvioFiscalRepository, formaPagoDe, RegistroEnvioNuevo } from './envio-fiscal.repository';

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
  const repositorio = new EnvioFiscalRepository(bd as unknown as DataSource, transacciones as unknown as TransaccionesFiscales);
  return { repositorio, bd, tx, transacciones };
}

function preparadoFalso(documento: DocumentoCpe): EnvioCpePreparado {
  const nombreBase = `20610206337-${documento.tipo}-${documento.serie}-${String(documento.numero).padStart(8, '0')}`;
  return {
    nombreBase,
    xmlSinFirmar: '<Invoice/>',
    xmlFirmado: '<Invoice><ds:Signature/></Invoice>',
    digestValue: 'DIGEST==',
    signatureValue: 'FIRMA==',
    zip: { nombreZip: `${nombreBase}.zip`, nombreXml: `${nombreBase}.xml`, zip: Buffer.from('PK-zip'), base64: 'UEstemlw', sha256: 'abc' },
    cadenaQr: '20610206337|01|F001|120|1.53|10.00|2026-10-13|6|20131312955|DIGEST==|',
    advertencias: [],
  };
}

function registro(cambios: Partial<RegistroEnvioNuevo> = {}): RegistroEnvioNuevo {
  const documento = cambios.documento ?? facturaPrueba(undefined, { serie: 'F001', numero: 120 });
  return {
    ambiente: 'produccion',
    documento,
    preparado: preparadoFalso(documento),
    idComprobante: 77,
    idUsuario: 4,
    fechaLimiteEnvio: '2026-10-16',
    ...cambios,
  };
}

const RESPUESTAS_REGISTRO: Array<[RegExp, unknown]> = [
  [/INSERT INTO fiscal_envios/, [{ id_envio: 900 }]],
  [/information_schema\.columns/, [{ existe: false }]],
  [/UPDATE comprobantes/, [[{ id_comprobante: 77 }], 1]],
];

describe('EnvioFiscalRepository.registrar (dentro de la transacción del negocio)', () => {
  it('ENVIANDO con plazo de reclamo, identificador y ambiente como parámetros; los 3 artefactos en UNA sentencia', async () => {
    const { repositorio } = crear();
    const consultor = consultorFalso(RESPUESTAS_REGISTRO);
    const id = await repositorio.registrar(consultor, registro());
    expect(id).toBe(900);

    const [insertEnvio, insertArchivos, verificarHora, actualizar] = consultor.llamadas;
    expect(insertEnvio.sql).toMatch(/INSERT INTO fiscal_envios/);
    expect(insertEnvio.sql).toMatch(/'ENVIANDO'/);
    expect(insertEnvio.sql).toMatch(/'emitir', 1,/);
    expect(insertEnvio.sql).toMatch(/NOW\(\) \+ \$7::int \* INTERVAL '1 second'/);
    expect(insertEnvio.sql).not.toMatch(/'beta'/);
    expect(insertEnvio.parametros.slice(0, 7)).toEqual([
      '01',
      'produccion',
      '20610206337-01-F001-00000120.zip',
      '20610206337-01-F001-00000120',
      4,
      77,
      60,
    ]);
    expect(insertEnvio.parametros[7]).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.parse(insertEnvio.parametros[8] as string)).toMatchObject({ digest: 'DIGEST==', documento: { serie: 'F001', numero: 120 } });

    expect(consultor.llamadas.filter((l) => /INSERT INTO fiscal_artifacts/.test(l.sql))).toHaveLength(1);
    expect(insertArchivos.sql.match(/\(\$1, \$2,/g)).toHaveLength(3);
    expect(insertArchivos.parametros.slice(0, 2)).toEqual([900, 77]);
    expect(insertArchivos.parametros).toEqual(
      expect.arrayContaining(['xml_original', 'xml_firmado', 'zip', 'bd:produccion:900:xml_original', 'bd:produccion:900:zip']),
    );
    expect(insertArchivos.parametros.filter((p) => Buffer.isBuffer(p))).toHaveLength(3);

    expect(verificarHora.sql).toMatch(/information_schema\.columns/);
    expect(actualizar.sql).toMatch(/UPDATE comprobantes/);
    expect(actualizar.sql).toMatch(/WHERE id_comprobante = \$1 AND serie = \$9 AND numero = \$10/);
    expect(actualizar.sql).not.toMatch(/hora_emision/);
    expect(actualizar.parametros).toEqual([77, 'produccion', 900, expect.stringContaining('DIGEST=='), 'DIGEST==', 'Contado', null, '2026-10-16', 'F001', 120]);
  });

  it('forma de pago EXACTA (CHECK Contado|Credito), cuotas en JSON y hora_emision solo si fase12 creó la columna', async () => {
    const { repositorio } = crear();
    const documento = facturaPrueba(undefined, {
      serie: 'F001',
      numero: 121,
      formaPago: { tipo: 'Crédito' as 'Credito', montoPendiente: 10, cuotas: [{ numero: 1, monto: 10, fechaPago: '2026-11-12' }] },
    });
    const consultor = consultorFalso([
      [/INSERT INTO fiscal_envios/, [{ id_envio: 901 }]],
      [/information_schema\.columns/, [{ existe: true }]],
      [/UPDATE comprobantes/, [[{ id_comprobante: 77 }], 1]],
    ]);
    await repositorio.registrar(consultor, registro({ documento, preparado: preparadoFalso(documento) }));

    const actualizar = consultor.llamadas.find((l) => /UPDATE comprobantes/.test(l.sql))!;
    expect(actualizar.sql).toMatch(/hora_emision = \$11::time/);
    expect(actualizar.parametros[5]).toBe('Credito');
    expect(JSON.parse(actualizar.parametros[6] as string)).toEqual([{ numero: 1, monto: 10, fechaPago: '2026-11-12' }]);
    expect(actualizar.parametros[10]).toBe('10:30:00');

    // La verificación del esquema se recuerda: la segunda emisión no vuelve a preguntar.
    const otro = consultorFalso([
      [/INSERT INTO fiscal_envios/, [{ id_envio: 902 }]],
      [/UPDATE comprobantes/, [[{ id_comprobante: 77 }], 1]],
    ]);
    await repositorio.registrar(otro, registro({ documento, preparado: preparadoFalso(documento) }));
    expect(otro.llamadas.some((l) => /information_schema/.test(l.sql))).toBe(false);
    expect(otro.llamadas.find((l) => /UPDATE comprobantes/.test(l.sql))!.sql).toMatch(/hora_emision/);
  });

  it('la prueba del panel (sin comprobante) no toca comprobantes', async () => {
    const { repositorio } = crear();
    const consultor = consultorFalso(RESPUESTAS_REGISTRO);
    await repositorio.registrar(consultor, registro({ idComprobante: null, ambiente: 'beta' }));
    expect(consultor.llamadas.some((l) => /UPDATE comprobantes/.test(l.sql))).toBe(false);
    expect(consultor.llamadas.find((l) => /INSERT INTO fiscal_artifacts/.test(l.sql))!.parametros).toContain('bd:beta:900:zip');
  });

  it('si el comprobante no existe o no es esa serie-número, falla (la transacción del negocio se revierte)', async () => {
    const { repositorio } = crear();
    const consultor = consultorFalso([
      [/INSERT INTO fiscal_envios/, [{ id_envio: 903 }]],
      [/information_schema\.columns/, [{ existe: false }]],
      [/UPDATE comprobantes/, [[], 0]],
    ]);
    await expect(repositorio.registrar(consultor, registro())).rejects.toThrow(/no es F001-120/);
  });

  it('un número ya enviado en el ambiente se traduce a FISCAL_NUMERO_OCUPADO; un envío en curso a FISCAL_ENVIO_EN_CURSO', async () => {
    const { repositorio } = crear();
    const duplicado = Object.assign(new Error('duplicate key'), { code: '23505', constraint: 'uq_fiscal_envio_identificador' });
    const consultor = consultorFalso([[/INSERT INTO fiscal_envios/, () => Promise.reject(duplicado)]]);
    const error = await repositorio.registrar(consultor, registro()).catch((e) => e);
    expect(error).toBeInstanceOf(FiscalConfigError);
    expect(error).toMatchObject({ codigo: 'FISCAL_NUMERO_OCUPADO', detalle: { serie: 'F001', numero: 120 } });
    expect(error.estadoHttp).toBe(409);

    const enCurso = { driverError: { code: '23505', constraint: 'uq_fiscal_envio_en_curso' } };
    const otro = consultorFalso([[/INSERT INTO fiscal_envios/, () => Promise.reject(enCurso)]]);
    await expect(repositorio.registrar(otro, registro())).rejects.toMatchObject({ codigo: 'FISCAL_ENVIO_EN_CURSO' });

    const ajeno = Object.assign(new Error('otra cosa'), { code: '23503' });
    const tercero = consultorFalso([[/INSERT INTO fiscal_envios/, () => Promise.reject(ajeno)]]);
    await expect(repositorio.registrar(tercero, registro())).rejects.toBe(ajeno);
  });
});

describe('EnvioFiscalRepository: reclamos, cierre y consultas', () => {
  it('reintento seguro: SKIP LOCKED, reclamo vencido, nunca RECUPERAR_CDR, sube el intento y trae el ZIP', async () => {
    const { repositorio, bd } = crear();
    await repositorio.reclamarReintento(5);
    const { sql, parametros } = bd.llamadas[0];
    expect(sql).toMatch(/FOR UPDATE SKIP LOCKED/);
    expect(sql).toMatch(/\(e\.bloqueado_hasta IS NULL OR e\.bloqueado_hasta < NOW\(\)\)/);
    expect(sql).toMatch(/IS DISTINCT FROM 'RECUPERAR_CDR'/);
    expect(sql).toMatch(/e\.estado = 'PENDIENTE_REENVIO'/);
    expect(sql).toMatch(/OR e\.estado = 'ENVIANDO'/);
    expect(sql).toMatch(/intento = e\.intento \+ 1/);
    expect(sql).toMatch(/tipo_artifacto = 'zip'/);
    expect(parametros).toEqual([5, 60]);
  });

  it('primer envío: solo si sigue como se registró (intento 1, sin respuesta)', async () => {
    const { repositorio, bd } = crear();
    expect(await repositorio.reclamarPrimerEnvio(6, false)).toBeNull();
    expect(bd.llamadas[0].sql).toMatch(/e\.intento = 1 AND e\.fecha_respuesta IS NULL/);
    expect(bd.llamadas[0].sql).not.toMatch(/tipo_artifacto = 'zip'/);
    await repositorio.reclamarPrimerEnvio(6, true);
    expect(bd.llamadas[1].sql).toMatch(/tipo_artifacto = 'zip'/);
  });

  it('lee el envío con el documento, el plazo y la marca de «registrado con otros datos»', async () => {
    const documento = facturaPrueba(undefined, { serie: 'F001', numero: 9 });
    const { repositorio } = crear([
      [
        /SELECT/,
        [
          {
            id_envio: 3,
            ambiente: 'produccion',
            tipo_documento: '01',
            estado: 'PENDIENTE_REENVIO',
            intento: 2,
            nombre_archivo: '20610206337-01-F001-00000009.zip',
            identificador: '20610206337-01-F001-00000009',
            id_comprobante: 12,
            codigo_sunat: '1033',
            accion: 'RECUPERAR_CDR',
            libre: true,
            fecha_limite_envio: null,
            documento,
            digest: 'D',
            cadena_qr: 'Q',
            registrado_con_otros_datos: true,
          },
        ],
      ],
    ]);
    const envio = await repositorio.leer(3);
    expect(envio).toMatchObject({
      ambiente: 'produccion',
      nombre_base: '20610206337-01-F001-00000009',
      accion: 'RECUPERAR_CDR',
      libre: true,
      registrado_con_otros_datos: true,
      fecha_limite_envio: '2026-10-16',
      datos: { digest: 'D', cadena_qr: 'Q', documento: { serie: 'F001' } },
      zip: null,
    });
  });

  it('completar: filtra por ambiente, solo pisa estados abiertos, guarda el CDR en UNA sentencia y actualiza el comprobante', async () => {
    const { repositorio, tx, transacciones } = crear([
      [/UPDATE fiscal_envios/, [[{ id_comprobante: 12, tipo_documento: '01', archivos: ['zip', 'xml_firmado', 'xml_original'] }], 1]],
    ]);
    const cerrado = await repositorio.completar(3, 'produccion', '20610206337-01-F001-00000009', {
      estado: 'ACEPTADO',
      accion: 'NINGUNA',
      mensaje: 'Aceptada',
      sunat: { codigo: '0', descripcion: 'Aceptada', observaciones: [], tiempoMs: 812.4 },
      json: { clasificacion: { estado: 'ACEPTADO', accion: 'NINGUNA' } },
      cdr: { xml: '<ApplicationResponse/>', zip: Buffer.from('PK') },
      proximoIntentoMin: null,
    });

    expect(transacciones.ejecutar).toHaveBeenCalledTimes(1);
    expect(cerrado).toEqual({ id_comprobante: 12, tipo_documento: '01', archivos: ['zip', 'xml_firmado', 'xml_original'] });
    const [envio, cdr, comprobante] = tx.llamadas;
    expect(envio.sql).toMatch(/WHERE e\.id_envio = \$1 AND e\.ambiente = \$2 AND e\.estado = ANY\(\$12::text\[\]\)/);
    expect(envio.parametros.slice(0, 7)).toEqual([3, 'produccion', 'ACEPTADO', '0', 'Aceptada', '[]', 812]);
    expect(envio.parametros[11]).toEqual(['ENVIANDO', 'PENDIENTE_REENVIO', 'EXCEPCION']);
    expect(cdr.sql).toMatch(/INSERT INTO fiscal_artifacts/);
    expect(cdr.parametros).toEqual(expect.arrayContaining(['cdr_xml', 'cdr_zip', 'R-20610206337-01-F001-00000009.xml', 'bd:produccion:3:cdr_zip']));
    expect(comprobante.sql).toMatch(/UPDATE comprobantes/);
    expect(comprobante.parametros.slice(0, 5)).toEqual([12, 'emitido', 'ACEPTADO', 3, true]);
  });

  it('completar devuelve null si otro proceso ya cerró el envío (no toca el comprobante)', async () => {
    const { repositorio, tx } = crear([[/UPDATE fiscal_envios/, [[], 0]]]);
    const cerrado = await repositorio.completar(3, 'beta', 'X', {
      estado: 'PENDIENTE_REENVIO',
      accion: 'RECUPERAR_CDR',
      mensaje: 'm',
      sunat: null,
      json: {},
      proximoIntentoMin: null,
    });
    expect(cerrado).toBeNull();
    expect(tx.llamadas).toHaveLength(1);
  });

  it('candidatos de la tarea: ambiente vigente, REINTENTAR con turno vencido o ENVIANDO sin reclamo, con tope', async () => {
    const { repositorio, bd } = crear([[/SELECT t\.id_envio/, [{ id_envio: 4 }, { id_envio: 9 }]]]);
    expect(await repositorio.candidatosTarea('produccion', 10)).toEqual([4, 9]);
    const { sql, parametros } = bd.llamadas[0];
    expect(sql).toMatch(/t\.ambiente = \$1/);
    expect(sql).toMatch(/COALESCE\(t\.respuesta_json #>> '\{clasificacion,accion\}', 'REINTENTAR'\) = 'REINTENTAR'/);
    expect(sql).toMatch(/t\.proximo_intento_en <= NOW\(\)/);
    expect(sql).toMatch(/OR t\.estado = 'ENVIANDO'/);
    expect(sql).toMatch(/t\.id_comprobante IS NOT NULL/);
    expect(sql).toMatch(/LIMIT \$2/);
    expect(parametros).toEqual(['produccion', 10]);
  });

  it('listar: filtros parametrizados y por_pagina recortado a 100', async () => {
    const { repositorio, bd } = crear([
      [/COUNT\(\*\)::int AS total/, [{ total: 3 }]],
      [
        /SELECT/,
        [
          {
            id_envio: 8,
            ambiente: 'beta',
            tipo_documento: '03',
            nombre_archivo: 'x.zip',
            estado: 'ACEPTADO',
            codigo_sunat: '0',
            mensaje_sunat: 'Aceptada',
            accion_sunat: 'NINGUNA',
            id_comprobante: null,
            creado_en: new Date('2026-10-13T15:00:00Z'),
            actualizado_en: null,
            intento: 1,
            proximo_intento_en: null,
            bloqueado_hasta: null,
            serie: 'BB01',
            numero: 4,
            archivos: ['zip', 'cdr_xml', 'xml_original'],
          },
        ],
      ],
    ]);
    const pagina = await repositorio.listar({ ambiente: 'beta', estado: 'ACEPTADO', tipo: '03', pagina: 2, por_pagina: 500 });
    expect(pagina).toMatchObject({ total: 3, pagina: 2, por_pagina: MAXIMO_ENVIOS_POR_PAGINA });
    expect(pagina.datos[0]).toMatchObject({ id_envio: 8, serie: 'BB01', numero: 4, creado_en: '2026-10-13T15:00:00.000Z' });
    expect(pagina.datos[0].archivos).toEqual(['xml_original', 'zip', 'cdr_xml']);
    const consulta = bd.llamadas.find((l) => /LIMIT \$5 OFFSET \$6/.test(l.sql))!;
    expect(consulta.parametros).toEqual([['03'], 'beta', 'ACEPTADO', null, 100, 100]);
  });

  it('archivo: el último de ese tipo con contenido, o null', async () => {
    const { repositorio } = crear([[/FROM fiscal_artifacts a/, [{ nombre: 'R-X.xml', mime: 'application/xml', contenido: Buffer.from('<a/>') }]]]);
    expect(await repositorio.archivo(3, 'cdr_xml')).toEqual({ nombre: 'R-X.xml', mime: 'application/xml', contenido: Buffer.from('<a/>') });
    const vacio = crear();
    expect(await vacio.repositorio.archivo(3, 'cdr_xml')).toBeNull();
  });

  it('contadores de cola y plazos del ambiente (comprobantes no aceptados por fecha límite)', async () => {
    const { repositorio, bd } = crear([[/AS pendientes/, [{ pendientes: 2, inciertos: 1, vencen_hoy: 3, vencidos: 4 }]]]);
    expect(await repositorio.contadores('produccion', '2026-10-21')).toEqual({ pendientes: 2, inciertos: 1, vencen_hoy: 3, vencidos: 4 });
    expect(bd.llamadas[0].parametros).toEqual(['produccion', '2026-10-21']);
    expect(bd.llamadas[0].sql).toMatch(/c\.fecha_limite_envio < \$2::date/);
    expect(bd.llamadas[0].sql).toMatch(/NOT IN \('ACEPTADO', 'ACEPTADO_OBS', 'RECHAZADO', 'ANULADO', 'BAJA_PENDIENTE'\)/);
  });

  it('BETA: primer número libre por serie según lo ya enviado (las pruebas del panel cuentan)', async () => {
    const { repositorio, bd } = crear([[/GROUP BY 1/, [{ serie: 'FB01', ultimo: '3' }, { serie: 'BB01', ultimo: 4 }]]]);
    expect(await repositorio.primerosLibresBeta(['FB01', 'BB01', 'FBC1'])).toEqual({ FB01: 4, BB01: 5 });
    expect(bd.llamadas[0].sql).toMatch(/t\.ambiente = 'beta'/);

    const otro = crear([[/GREATEST/, [{ siguiente: '7' }]]]);
    expect(await otro.repositorio.siguienteNumeroPruebaBeta('FB01')).toBe(7);
  });
});

describe('forma de pago del comprobante', () => {
  it('normaliza a Contado o Credito y arma las cuotas solo al crédito', () => {
    const contado = facturaPrueba(undefined, { formaPago: { tipo: 'Contado' } });
    expect(formaPagoDe(contado)).toBe('Contado');
    expect(cuotasDe(contado)).toBeNull();
    const credito = facturaPrueba(undefined, { formaPago: { tipo: 'CRÉDITO' as 'Credito', cuotas: [{ numero: 1, monto: 5, fechaPago: '2026-11-01' }] } });
    expect(formaPagoDe(credito)).toBe('Credito');
    expect(JSON.parse(cuotasDe(credito)!)).toEqual([{ numero: 1, monto: 5, fechaPago: '2026-11-01' }]);
    expect(formaPagoDe(facturaPrueba(undefined, { formaPago: undefined }))).toBeNull();
  });
});

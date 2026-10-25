import type { GrePreparada } from '../../sunat/gre/gre.contrato';
import { TIMEOUT_GRE_MS } from '../../sunat/gre/gre-rest-client';
import {
  EnvioGuiaEnCursoError,
  GuiaRemisionRepository,
  NumeroGuiaOcupadoError,
  SEGUNDOS_RECLAMO_CONSULTA_GUIA,
  SEGUNDOS_RECLAMO_ENVIO_GUIA,
} from './guia-remision.repository';

function errorUnico(constraint: string) {
  return Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505', constraint });
}

function preparada(): GrePreparada {
  const zip = Buffer.from('zip');
  return {
    documento: { serie: 'T001', numero: 4, fechaEmision: '2026-10-22', horaEmision: '10:00:00', remitente: { ruc: '20610206337' } } as any,
    nombreBase: '20610206337-09-T001-00000004',
    xml: '<x/>',
    xmlFirmado: '<x firmado/>',
    zip,
    zipBase64: zip.toString('base64'),
    sha256: 'h',
    digestValue: 'DIGEST==',
    advertencias: [],
  };
}

function montar() {
  const bd = { query: jest.fn(async (): Promise<unknown> => []) };
  const tx = { query: jest.fn(async (): Promise<unknown> => []) };
  const transacciones = { ejecutar: jest.fn(async (trabajo: (t: unknown) => unknown) => trabajo(tx)) };
  return { repo: new GuiaRemisionRepository(bd as any, transacciones as any), bd, tx };
}

describe('GuiaRemisionRepository', () => {
  it('listado: comodines LIKE escapados, por_pagina tope 100 y el conteo con los mismos filtros (sin LIMIT)', async () => {
    const { repo, bd } = montar();
    bd.query.mockResolvedValueOnce([]).mockResolvedValueOnce([{ total: 0 }]);
    await repo.listar({ texto: '50%_a\\b', estado: 'borrador', pagina: 2, por_pagina: 500 });
    const [sql, parametros] = bd.query.mock.calls[0] as unknown as [string, unknown[]];
    expect(parametros).toEqual(['borrador', '%50\\%\\_a\\\\b%', 100, 100]);
    expect(sql).toContain(`ILIKE $2 ESCAPE '\\'`);
    const [sqlConteo, parametrosConteo] = bd.query.mock.calls[1] as unknown as [string, unknown[]];
    expect(sqlConteo).toContain('COUNT(*)');
    expect(parametrosConteo).toEqual(['borrador', '%50\\%\\_a\\\\b%']);
  });

  it('un texto numérico también busca por número de venta y de guía', async () => {
    const { repo, bd } = montar();
    bd.query.mockResolvedValueOnce([]).mockResolvedValueOnce([{ total: 0 }]);
    await repo.listar({ texto: '125', pagina: 1, por_pagina: 20 });
    const [sql, parametros] = bd.query.mock.calls[0] as unknown as [string, unknown[]];
    expect(parametros.slice(0, 2)).toEqual(['%125%', 125]);
    expect(sql).toContain('g.id_venta = $2::int OR g.numero = $2::int');
  });

  it('siguiente número: el mayor entre MAX + 1 y el correlativo inicial', async () => {
    const { repo, bd } = montar();
    bd.query.mockResolvedValue([{ ultimo: 7 }]);
    expect(await repo.siguienteNumero('T001', 1)).toBe(8);
    expect(await repo.siguienteNumero('T001', 500)).toBe(500);
    expect(bd.query).toHaveBeenCalledWith(expect.stringContaining('MAX(numero)'), ['T001']);
  });

  it('registra la emisión: guía pendiente, envío ENVIANDO con reclamo y los 3 artefactos en un solo INSERT', async () => {
    const { repo, tx } = montar();
    tx.query.mockResolvedValueOnce([[{ id_guia: 7 }], 1]).mockResolvedValueOnce([{ id_envio: 31 }]).mockResolvedValueOnce([]);
    expect(await repo.registrarEmision(tx as any, { idGuia: 7, numeroAnterior: null, idComprobante: 3, idUsuario: 2, preparada: preparada() })).toBe(31);
    const [sqlGuia, pGuia] = tx.query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sqlGuia).toContain("estado = 'pendiente'");
    expect(sqlGuia).toContain('numero IS NOT DISTINCT FROM $7::int');
    expect(pGuia.slice(0, 5)).toEqual([7, 'T001', 4, '2026-10-22', 3]);
    const [sqlEnvio, pEnvio] = tx.query.mock.calls[1] as unknown as [string, unknown[]];
    expect(sqlEnvio).toContain("'09', 'produccion', 'sunat_directo', 'emitir', 1, 'ENVIANDO'");
    expect(pEnvio.slice(0, 5)).toEqual([7, '20610206337-09-T001-00000004.zip', '20610206337-09-T001-00000004', 2, SEGUNDOS_RECLAMO_ENVIO_GUIA]);
    const [sqlArchivos, pArchivos] = tx.query.mock.calls[2] as unknown as [string, unknown[]];
    expect(sqlArchivos.match(/\(\$1, /g)).toHaveLength(3);
    expect(pArchivos.filter((p) => ['xml_original', 'xml_firmado', 'zip'].includes(p as string))).toEqual(['xml_original', 'xml_firmado', 'zip']);
  });

  it('traduce los índices únicos: número tomado por otra guía y envío ya en curso', async () => {
    const { repo, tx } = montar();
    tx.query.mockRejectedValueOnce(errorUnico('uq_guias_remision_serie_numero'));
    const ocupado = await repo.registrarEmision(tx as any, { idGuia: 7, numeroAnterior: null, idComprobante: null, idUsuario: null, preparada: preparada() }).catch((e) => e);
    expect(ocupado).toBeInstanceOf(NumeroGuiaOcupadoError);
    expect(ocupado.siguiente).toBe(5);

    tx.query.mockResolvedValueOnce([[{ id_guia: 7 }], 1]).mockRejectedValueOnce(errorUnico('uq_fiscal_envio_gre_en_curso'));
    await expect(repo.registrarEmision(tx as any, { idGuia: 7, numeroAnterior: null, idComprobante: null, idUsuario: null, preparada: preparada() })).rejects.toBeInstanceOf(EnvioGuiaEnCursoError);
  });

  it('el reclamo del envío y el de la consulta cubren el peor caso del cliente REST (token, 401 y reintentos)', () => {
    // Una petición: su timeout + 2 s del corte de respaldo; el token: 1 reintento con 1 s de pausa.
    const peticion = TIMEOUT_GRE_MS + 2_000;
    const token = 2 * peticion + 1_000;
    // Envío: token + POST, y otra vez ambos si SUNAT responde 401.
    expect(SEGUNDOS_RECLAMO_ENVIO_GUIA * 1000).toBeGreaterThan(2 * (token + peticion));
    // Consulta: token + GET (401) + token + GET con 2 reintentos (pausas de 1 y 3 s).
    expect(SEGUNDOS_RECLAMO_CONSULTA_GUIA * 1000).toBeGreaterThan(2 * token + 4 * peticion + 4_000);
  });

  it('cerrar el envío no pisa uno que otro proceso ya cerró (ni toca la guía)', async () => {
    const { repo, tx } = montar();
    tx.query.mockResolvedValueOnce([[], 0]);
    const cerrado = await repo.cerrarEnvio(31, {
      estadoEnvio: 'TICKET_PENDIENTE',
      estadoGuia: 'enviado',
      ticket: 'T-1',
      codigo: null,
      mensaje: 'ok',
      errorGuia: null,
      respuesta: {},
      proximoIntentoSeg: 30,
    });
    expect(cerrado).toBe(false);
    expect(tx.query).toHaveBeenCalledTimes(1);
    expect((tx.query.mock.calls[0] as unknown as [string])[0]).toContain("f.estado = 'ENVIANDO'");
  });
});

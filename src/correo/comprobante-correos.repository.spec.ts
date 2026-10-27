import type { DataSource } from 'typeorm';
import { ComprobanteCorreosRepository, DIAS_SIEMBRA_CORREO, SEGUNDOS_RECLAMO_CORREO } from './comprobante-correos.repository';

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
  return { repositorio: new ComprobanteCorreosRepository(bd as unknown as DataSource), bd };
}

describe('ComprobanteCorreosRepository', () => {
  it('tablaDisponible detecta la ausencia de la tabla, no falla y guarda la respuesta', async () => {
    const { repositorio, bd } = crear([[/to_regclass/, [{ existe: false }]]]);
    expect(await repositorio.tablaDisponible()).toBe(false);
    expect(await repositorio.tablaDisponible()).toBe(false);
    expect(bd.query).toHaveBeenCalledTimes(1);

    const conError = crear();
    conError.bd.query.mockRejectedValueOnce(new Error('sin conexión'));
    expect(await conError.repositorio.tablaDisponible()).toBe(false);
  });

  it('sembrar inserta PENDIENTE/OMITIDO solo de comprobantes con enviar_cliente, recientes y sin fila', async () => {
    const { repositorio, bd } = crear([[/INSERT INTO comprobante_correos/, [{ id_correo: 1 }, { id_correo: 2 }]]]);
    expect(await repositorio.sembrar(50)).toBe(2);
    const { sql, parametros } = bd.llamadas[0];
    expect(sql).toContain('c.enviar_cliente = true');
    expect(sql).toContain("'PENDIENTE'");
    expect(sql).toContain("'OMITIDO'");
    expect(sql).toContain("c.proveedor_fiscal IS DISTINCT FROM 'sunat_directo'");
    expect(sql).toContain("NOT IN ('RECHAZADO', 'ANULADO')");
    expect(sql).toContain('NOT EXISTS (SELECT 1 FROM comprobante_correos x WHERE x.id_comprobante = c.id_comprobante)');
    expect(sql).toContain("ON CONFLICT (id_comprobante) WHERE origen = 'automatico' DO NOTHING");
    expect(parametros).toEqual([[1, 2], DIAS_SIEMBRA_CORREO, 50]);
  });

  it('omitirRechazados pasa a OMITIDO los pendientes de comprobantes rechazados o anulados', async () => {
    const { repositorio, bd } = crear([[/UPDATE comprobante_correos t/, [[{ id_correo: 9 }], 1]]]);
    expect(await repositorio.omitirRechazados()).toBe(1);
    expect(bd.llamadas[0].sql).toContain("t.estado = 'PENDIENTE'");
    expect(bd.llamadas[0].sql).toContain("IN ('RECHAZADO', 'ANULADO')");
  });

  it('candidatos exige aceptado, no anulado, turno vencido y sin reclamo vigente, con LIMIT', async () => {
    const { repositorio, bd } = crear([[/SELECT t.id_correo/, [{ id_correo: 4 }, { id_correo: 7 }]]]);
    expect(await repositorio.candidatos(10)).toEqual([4, 7]);
    const { sql, parametros } = bd.llamadas[0];
    expect(sql).toContain("c.estado_sunat IN ('ACEPTADO', 'ACEPTADO_OBS')");
    expect(sql).toContain('COALESCE(c.anulado, false) = false');
    expect(sql).toContain('t.proximo_intento_en <= NOW()');
    expect(sql).toContain('t.bloqueado_hasta < NOW()');
    expect(sql).toContain('ORDER BY');
    expect(sql).toContain('LIMIT $1');
    expect(parametros).toEqual([10]);
  });

  it('reclamar usa SKIP LOCKED, suma el intento y devuelve null si otra réplica lo tomó', async () => {
    const fila = { id_correo: 4, id_comprobante: 20, estado: 'ENVIANDO', intentos: 1 };
    const { repositorio, bd } = crear([[/UPDATE comprobante_correos t/, [[fila], 1]]]);
    expect(await repositorio.reclamar(4)).toEqual(fila);
    const { sql, parametros } = bd.llamadas[0];
    expect(sql).toContain("SET estado = 'ENVIANDO'");
    expect(sql).toContain('intentos = t.intentos + 1');
    expect(sql).toContain('FOR UPDATE SKIP LOCKED');
    expect(sql).toContain("s.estado IN ('PENDIENTE', 'ENVIANDO')");
    expect(sql).toContain('s.bloqueado_hasta < NOW()');
    expect(parametros).toEqual([4, SEGUNDOS_RECLAMO_CORREO]);

    const ocupado = crear([[/UPDATE comprobante_correos t/, [[], 0]]]);
    expect(await ocupado.repositorio.reclamar(4)).toBeNull();
  });

  it('marcarEnviado, marcarError y marcarOmitido fijan el estado esperado', async () => {
    const { repositorio, bd } = crear();
    await repositorio.marcarEnviado(4, 'msg-1');
    expect(bd.llamadas[0].sql).toContain("estado = 'ENVIADO'");
    expect(bd.llamadas[0].parametros).toEqual([4, 'msg-1']);

    await repositorio.marcarError(4, 'timeout', 5);
    expect(bd.llamadas[1].sql).toContain("THEN 'ERROR' ELSE 'PENDIENTE'");
    expect(bd.llamadas[1].parametros).toEqual([4, 'timeout', 5]);
    await repositorio.marcarError(4, 'definitivo', null);
    expect(bd.llamadas[2].parametros).toEqual([4, 'definitivo', null]);

    await repositorio.marcarOmitido(4, 'ambiente beta sin correo de pruebas');
    expect(bd.llamadas[3].sql).toContain("estado = 'OMITIDO'");
    expect(bd.llamadas[3].parametros).toEqual([4, 'ambiente beta sin correo de pruebas']);
  });

  it('historial, ultimo y reenviosUltimaHora consultan por comprobante', async () => {
    const { repositorio, bd } = crear([
      [/COUNT\(\*\)/, [{ total: 2 }]],
      [/LIMIT 1/, [{ id_correo: 8 }]],
      [/LIMIT 50/, [{ id_correo: 8 }, { id_correo: 5 }]],
    ]);
    expect((await repositorio.historial(20)).map((f) => f.id_correo)).toEqual([8, 5]);
    expect((await repositorio.ultimo(20))?.id_correo).toBe(8);
    expect(await repositorio.reenviosUltimaHora(20)).toBe(2);
    expect(bd.llamadas[2].sql).toContain("origen = 'manual'");
    expect(bd.llamadas[2].sql).toContain("INTERVAL '1 hour'");
    expect(bd.llamadas.every((l) => l.parametros[0] === 20)).toBe(true);
  });

  it('crearManual inserta PENDIENTE manual y devuelve null si ya hay un envío abierto', async () => {
    const { repositorio, bd } = crear([[/INSERT INTO comprobante_correos/, [{ id_correo: 31 }]]]);
    expect(await repositorio.crearManual(20, 'a@b.pe', 3)).toBe(31);
    expect(bd.llamadas[0].sql).toContain("'PENDIENTE', 'manual'");
    expect(bd.llamadas[0].sql).toContain("ON CONFLICT (id_comprobante) WHERE estado IN ('PENDIENTE', 'ENVIANDO') DO NOTHING");
    expect(bd.llamadas[0].parametros).toEqual([20, 'a@b.pe', 3]);

    const abierto = crear();
    expect(await abierto.repositorio.crearManual(20, 'a@b.pe', null)).toBeNull();
  });
});

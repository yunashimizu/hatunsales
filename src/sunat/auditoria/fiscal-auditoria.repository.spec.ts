import { FiscalAuditoriaRepository } from './fiscal-auditoria.repository';

function crear(opciones: { tabla?: boolean; filas?: unknown[] } = {}) {
  const query = jest.fn(async () => opciones.filas ?? []);
  const esquema = { tiene: jest.fn(async () => opciones.tabla ?? true) };
  return { repo: new FiscalAuditoriaRepository({ query } as never, esquema as never), query };
}

describe('FiscalAuditoriaRepository · consultas de S5/S7', () => {
  it('ultimoDeEntidad trae el último evento de esa acción y entidad', async () => {
    const { repo, query } = crear({
      filas: [{ id_auditoria: '9', creado_en: new Date('2026-11-08T10:00:00Z'), id_usuario: null, accion: 'FISCAL_PEDIDO_WEB_EMITIDO', entidad: 'pedido', id_entidad: '57', detalle: { motivo: 'x' }, ip: null }],
    });

    const r = await repo.ultimoDeEntidad('FISCAL_PEDIDO_WEB_EMITIDO', 'pedido', 57);

    expect(r).toMatchObject({ id_auditoria: 9, id_entidad: '57', detalle: { motivo: 'x' } });
    const [sql, parametros] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toMatch(/ORDER BY id_auditoria DESC\s+LIMIT 1/);
    expect(parametros).toEqual(['FISCAL_PEDIDO_WEB_EMITIDO', 'pedido', '57']);
  });

  it('sin eventos devuelve null y sin la tabla ni consulta', async () => {
    expect(await crear().repo.ultimoDeEntidad('A', 'e', 1)).toBeNull();
    const sinTabla = crear({ tabla: false });
    expect(await sinTabla.repo.ultimoDeEntidad('A', 'e', 1)).toBeNull();
    expect(sinTabla.query).not.toHaveBeenCalled();
  });

  it('existeHoy compara el día en hora de Lima', async () => {
    const { repo, query } = crear({ filas: [{ '?column?': 1 }] });

    await expect(repo.existeHoy('FISCAL_ALERTA_ENVIADA', 'tipo', 'envios_revision', '2026-11-09')).resolves.toBe(true);

    const [sql, parametros] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toMatch(/AT TIME ZONE 'America\/Lima'/);
    expect(parametros).toEqual(['FISCAL_ALERTA_ENVIADA', 'tipo', 'envios_revision', '2026-11-09']);
    await expect(crear().repo.existeHoy('A', 'tipo', 'x', '2026-11-09')).resolves.toBe(false);
  });
});

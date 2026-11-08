import { AlertasFiscalesRepository } from './alertas-fiscales.repository';

describe('AlertasFiscalesRepository.contadores', () => {
  it('lee los tres contadores del ambiente en una sola consulta', async () => {
    const query = jest.fn(async () => [{ excepcion: '2', lotes_por_liberar: 1, pendientes_antiguos: 25 }]);
    const repo = new AlertasFiscalesRepository({ query } as never);

    await expect(repo.contadores('produccion')).resolves.toEqual({ excepcion: 2, lotes_por_liberar: 1, pendientes_antiguos: 25 });

    const [sql, parametros] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(parametros).toEqual(['produccion']);
    expect(sql).toMatch(/estado = 'EXCEPCION'/);
    expect(sql).toMatch(/'\{clasificacion,accion\}' = 'LIBERAR'/);
    expect(sql).toMatch(/INTERVAL '2 hours'/);
    // Solo comprobantes: las guías no cuentan en estos avisos.
    expect(sql).toMatch(/tipo_documento IN \('01', '03', '07', '08'\)/);
  });

  it('sin filas devuelve ceros', async () => {
    const repo = new AlertasFiscalesRepository({ query: jest.fn(async () => []) } as never);
    await expect(repo.contadores('beta')).resolves.toEqual({ excepcion: 0, lotes_por_liberar: 0, pendientes_antiguos: 0 });
  });
});

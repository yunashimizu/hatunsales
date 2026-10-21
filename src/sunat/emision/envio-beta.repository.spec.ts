import { DataSource } from 'typeorm';
import { EnvioBetaRepository } from './envio-beta.repository';

describe('EnvioBetaRepository: reintento seguro', () => {
  const query = jest.fn();
  const repositorio = new EnvioBetaRepository({ query } as unknown as DataSource);

  beforeEach(() => query.mockReset().mockResolvedValue([]));

  it('incluye la acción clasificada al listar envíos para guiar la recuperación en el panel', async () => {
    await repositorio.listar();

    expect(query.mock.calls[0][0]).toContain(
      "e.respuesta_json #>> '{clasificacion,accion}' AS accion_sunat",
    );
  });

  it('solo permite reintentar envíos pendientes con ZIP y excluye envíos en curso o CDR por recuperar', async () => {
    await repositorio.tomarReenvio(42);

    const sql = query.mock.calls[0][0] as string;
    expect(sql).toContain("estado='PENDIENTE_REENVIO'");
    expect(sql).not.toContain("estado IN ('ENVIANDO','PENDIENTE_REENVIO')");
    expect(sql).toContain(
      "respuesta_json #>> '{clasificacion,accion}' IS DISTINCT FROM 'RECUPERAR_CDR'",
    );
    expect(sql).toContain("tipo_artifacto='zip' AND contenido IS NOT NULL");
  });
});

import { CajaSesionRepository } from './caja-sesion.repository';
import { SnapshotEsquema } from '../../caja/esquema/esquema-caja.service';
import { sqlEsperadoTurno } from '../../caja/arqueo/sql-esperado';

/**
 * El resumen del turno (GET /caja/sesion, dashboard, cierre) debe contar lo mismo que el
 * arqueo: solo ventas de mostrador. Una venta web asignada a la caja abierta se cobró
 * fuera de la gaveta y no puede inflar el total del cajero.
 */
function snapshot(conOrigen: boolean): SnapshotEsquema {
  const columnas = new Map<string, Set<string>>([
    ['ventas', new Set(['id_venta', 'id_caja', 'fecha', 'total', 'estado', ...(conOrigen ? ['origen'] : [])])],
    ['aperturas_caja', new Set(['id_apertura', 'id_caja', 'fecha', 'monto_inicial', 'id_usuario'])],
    ['cierres_caja', new Set(['id_cierre', 'id_apertura', 'fecha', 'monto_conteo', 'monto_final'])],
    ['cajas', new Set(['id_caja', 'nombre'])],
  ]);
  return new SnapshotEsquema(columnas, Date.now());
}

function armar(conOrigen: boolean) {
  const query = jest.fn(async (sql: string) =>
    sql.includes('GROUP BY') ? [{ metodo: 'Efectivo', total: '80.00', cantidad: 2 }] : [{ ventas: 2, total: '80.00' }],
  );
  const esquema = { snapshot: jest.fn().mockResolvedValue(snapshot(conOrigen)) };
  const repo = new CajaSesionRepository({ query } as any, esquema as any, {} as any);
  return { repo, query };
}

const apertura = {
  id_apertura: 12,
  id_caja: 1,
  caja_nombre: 'Caja 1',
  id_sucursal: 1,
  sucursal_nombre: 'Principal',
  id_usuario: 3,
  fecha: '2026-10-21T13:00:00.000Z',
  monto_inicial: 50,
};

describe('CajaSesionRepository.resumenTurno', () => {
  it('cuenta solo ventas de mostrador en el total y en el desglose por método', async () => {
    const { repo, query } = armar(true);

    const resumen = await repo.resumenTurno(apertura);

    expect(resumen).toEqual({ ventas: 2, total: 80, por_metodo: [{ metodo: 'Efectivo', total: 80, cantidad: 2 }] });
    expect(query).toHaveBeenCalledTimes(2);
    for (const [sql] of query.mock.calls) {
      expect(sql).toMatch(/COALESCE\(v\.origen, 'mostrador'\) = 'mostrador'/);
      expect(sql).toMatch(/COALESCE\(v\.estado, 'activa'\) <> 'anulada'/);
    }
  });

  it('usa el mismo criterio de origen que el efectivo esperado del arqueo', async () => {
    const { repo, query } = armar(true);
    await repo.resumenTurno(apertura);

    const arqueo = sqlEsperadoTurno({ conAbonos: false, movimientosPorTurno: true, conEstado: true, conOrigen: true });
    expect(arqueo).toMatch(/vs\.origen = 'mostrador'/);
    expect(arqueo).toMatch(/COALESCE\(v\.origen, 'mostrador'\)/);
    expect(query.mock.calls[0][0]).toMatch(/COALESCE\(v\.origen, 'mostrador'\) = 'mostrador'/);
  });

  it('en un esquema sin ventas.origen no filtra por origen (todas son de mostrador)', async () => {
    const { repo, query } = armar(false);

    await repo.resumenTurno(apertura);

    for (const [sql] of query.mock.calls) expect(sql).not.toMatch(/origen/);
  });
});

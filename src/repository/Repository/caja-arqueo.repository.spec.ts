import { CajaArqueoRepository } from './caja-arqueo.repository';
import { SnapshotEsquema } from '../../caja/esquema/esquema-caja.service';
import { Dinero } from '../../caja/dominio/dinero';

/** Fase 7: el INSERT y la lectura de movimientos_caja con y sin las columnas de sql/fase20. */
function catalogo(conFase20: boolean): SnapshotEsquema {
  return new SnapshotEsquema(
    new Map([
      ['movimientos_caja', new Set(['id_movimiento', 'id_caja', 'tipo', 'monto', 'descripcion', 'fecha', 'id_apertura', 'id_usuario',
        ...(conFase20 ? ['id_venta', 'categoria', 'nro_comprobante'] : [])])],
    ]),
    Date.now(),
  );
}

function armar(conFase20: boolean) {
  const manager = { query: jest.fn(async (_sql: string, _p?: unknown[]) => [{ id_movimiento: 77 }]) };
  const dataSource = { query: jest.fn(async (_sql: string, _p?: unknown[]) => [] as unknown[]) };
  const esquema = { snapshot: jest.fn().mockResolvedValue(catalogo(conFase20)) };
  const repo = new CajaArqueoRepository(dataSource as never, esquema as never);
  return { repo, manager, dataSource, esquema };
}

const BASE = { id_apertura: 5, id_caja: 1, id_usuario: 3, tipo: 'egreso' as const, monto: Dinero.deSoles(40), descripcion: 'Devolución de la venta 9' };
const SQL_DE_ANTES = 'INSERT INTO movimientos_caja (id_caja, tipo, monto, descripcion, fecha, id_apertura, id_usuario)';

describe('CajaArqueoRepository.registrarMovimiento (Fase 7)', () => {
  it('sin campos nuevos: el INSERT es exactamente el de antes y ni siquiera lee el catálogo', async () => {
    const { repo, manager, esquema } = armar(true);
    expect(await repo.registrarMovimiento(manager as never, BASE)).toBe(77);
    const [sql, valores] = manager.query.mock.calls[0];
    expect(sql).toContain(SQL_DE_ANTES);
    expect(sql).toContain('VALUES ($1, $2, $3::numeric, $4, NOW(), $5, $6)');
    expect(valores).toEqual([1, 'egreso', '40.00', 'Devolución de la venta 9', 5, 3]);
    expect(esquema.snapshot).not.toHaveBeenCalled();
  });

  it('con fase20 (columnas presentes): id_venta, categoria y nro_comprobante como parámetros $7..$9', async () => {
    const { repo, manager } = armar(true);
    await repo.registrarMovimiento(manager as never, { ...BASE, id_venta: 9, categoria: 'devolucion', nro_comprobante: 'R-1' });
    const [sql, valores] = manager.query.mock.calls[0];
    expect(sql).toContain('id_usuario, id_venta, categoria, nro_comprobante)');
    expect(sql).toContain('$6, $7, $8, $9)');
    expect(valores).toEqual([1, 'egreso', '40.00', 'Devolución de la venta 9', 5, 3, 9, 'devolucion', 'R-1']);
  });

  it('sin fase20 (columnas ausentes): los campos nuevos se ignoran y el INSERT es el de antes', async () => {
    const { repo, manager } = armar(false);
    await repo.registrarMovimiento(manager as never, { ...BASE, id_venta: 9, categoria: 'transporte', nro_comprobante: 'R-1' });
    const [sql, valores] = manager.query.mock.calls[0];
    expect(sql).toContain(SQL_DE_ANTES);
    expect(valores).toHaveLength(6);
  });

  it('listarMovimientos lee las columnas nuevas si existen; si no, NULL tipado', async () => {
    const con = armar(true);
    await con.repo.listarMovimientos(5, 10);
    expect(String(con.dataSource.query.mock.calls[0][0])).toContain('m.id_venta AS id_venta');
    const sin = armar(false);
    await sin.repo.listarMovimientos(5, 10);
    const sql = String(sin.dataSource.query.mock.calls[0][0]);
    expect(sql).toContain('NULL::int AS id_venta');
    expect(sql).toContain('NULL::text AS categoria');
    expect(sql).not.toContain('m.categoria');
  });
});

describe('CajaArqueoRepository.filasEsperado (Fase 7.1)', () => {
  it('con fase20 pide el SQL con devoluciones enlazadas; sin fase20, el de antes', async () => {
    const con = armar(true);
    await con.repo.filasEsperado(5);
    expect(String(con.dataSource.query.mock.calls[0][0])).toContain('devuelta_despues');
    const sin = armar(false);
    await sin.repo.filasEsperado(5);
    expect(String(sin.dataSource.query.mock.calls[0][0])).not.toContain('devuelta_despues');
  });
});

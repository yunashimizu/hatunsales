import { CheckoutRepository } from './checkout.repository';

/**
 * TypeORM con PostgreSQL devuelve `[filas, filasAfectadas]` en un UPDATE … RETURNING.
 * Contar `resultado.length` daba siempre 2: el tope de usos del cupón no frenaba
 * a la segunda compra que llegaba a la vez.
 */
function armar(resultadoUpdate: unknown) {
  const manager = { query: jest.fn(async () => resultadoUpdate) };
  const repo = new CheckoutRepository({} as any, {} as any, { manager } as any);
  return { repo, manager };
}

describe('CheckoutRepository.incrementarUsoCupon', () => {
  it('devuelve false si el cupón ya llegó a su tope (el UPDATE no tocó filas)', async () => {
    const { repo } = armar([[], 0]);
    await expect(repo.incrementarUsoCupon(1)).resolves.toBe(false);
  });

  it('devuelve true si sumó el uso', async () => {
    const { repo } = armar([[{ id_cupon: 1 }], 1]);
    await expect(repo.incrementarUsoCupon(1)).resolves.toBe(true);
  });

  it('usa el manager de la transacción del checkout cuando se lo pasan', async () => {
    const { repo, manager } = armar([[], 0]);
    const externo = { query: jest.fn(async () => [[{ id_cupon: 1 }], 1]) };

    await expect(repo.incrementarUsoCupon(1, externo)).resolves.toBe(true);
    expect(manager.query).not.toHaveBeenCalled();
  });
});

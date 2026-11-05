import { DataSource } from 'typeorm';
import { ConfiguracionRepository } from './configuracion.repository';

describe('ConfiguracionRepository.obtenerNumero', () => {
  function repositorio(filas: Array<{ valor: unknown }>) {
    const dataSource = { query: jest.fn().mockResolvedValue(filas) } as unknown as DataSource;
    return new ConfiguracionRepository(dataSource);
  }

  it('devuelve el valor por defecto cuando la clave no existe (no 0)', async () => {
    await expect(repositorio([]).obtenerNumero('tienda_igv_porcentaje', 18)).resolves.toBe(18);
  });

  it('devuelve el valor por defecto cuando la clave está vacía', async () => {
    await expect(repositorio([{ valor: '' }]).obtenerNumero('tienda_igv_porcentaje', 18)).resolves.toBe(18);
  });

  it('devuelve el valor por defecto cuando el texto no es un número', async () => {
    await expect(repositorio([{ valor: 'abc' }]).obtenerNumero('tienda_igv_porcentaje', 18)).resolves.toBe(18);
  });

  it('respeta un 0 escrito a propósito', async () => {
    await expect(repositorio([{ valor: '0' }]).obtenerNumero('pos_recargo_tarjeta_pct', 3)).resolves.toBe(0);
  });

  it('lee el número guardado', async () => {
    await expect(repositorio([{ valor: '10.5' }]).obtenerNumero('pos_recargo_tarjeta_pct', 3)).resolves.toBe(10.5);
  });
});

describe('ConfiguracionRepository.obtenerVarias', () => {
  it('la segunda lectura sale de la memoria, incluidas las claves ausentes', async () => {
    const query = jest.fn().mockResolvedValue([{ clave: 'pos_recargo_tarjeta_pct', valor: '3' }]);
    const repo = new ConfiguracionRepository({ query } as unknown as DataSource);
    const claves = ['pos_recargo_tarjeta_pct', 'clave_que_no_existe'];

    const primera = await repo.obtenerVarias(claves);
    const segunda = await repo.obtenerVarias(claves);

    expect(primera).toEqual({ pos_recargo_tarjeta_pct: '3', clave_que_no_existe: null });
    expect(segunda).toEqual(primera);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('tras guardar una clave vuelve a leer de la base', async () => {
    const query = jest.fn().mockResolvedValue([{ clave: 'a', valor: '1' }]);
    const transaction = jest.fn().mockResolvedValue(undefined);
    const repo = new ConfiguracionRepository({ query, transaction } as unknown as DataSource);

    await repo.obtenerVarias(['a']);
    await repo.guardar('a', '2');
    await repo.obtenerVarias(['a']);

    expect(query).toHaveBeenCalledTimes(2);
  });
});

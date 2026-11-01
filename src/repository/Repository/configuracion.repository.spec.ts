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

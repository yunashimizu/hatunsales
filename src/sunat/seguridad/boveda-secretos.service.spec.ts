import { Logger } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { RelojFiscal } from '../config/reloj-fiscal';
import { NotificadorCambiosFiscales } from '../config/notificador-cambios-fiscales';
import { BovedaSecretosFiscales, SECRETOS_FISCALES } from './boveda-secretos.service';
import { CifradoFiscalService } from './cifrado-fiscal.service';
import type { SecretoFiscalGuardado } from './secretos-fiscales.repository';

const LLAVE_VIEJA = randomBytes(32).toString('base64');
const LLAVE_NUEVA = randomBytes(32).toString('base64');
const OTRA = randomBytes(32).toString('base64');

class RelojPrueba extends RelojFiscal {
  t = 1_000_000;
  ahora(): Date {
    return new Date(this.t);
  }
}

/** Repositorio en memoria de fiscal_secretos. */
function repositorioFalso() {
  const filas = new Map<string, SecretoFiscalGuardado>();
  return {
    filas,
    leer: jest.fn(async (clave: string) => filas.get(clave) ?? null),
    metadatos: jest.fn(async (clave: string) => {
      const f = filas.get(clave);
      return f ? { actualizado_en: f.actualizado_en, actualizado_por: f.actualizado_por } : null;
    }),
    guardar: jest.fn(async (clave: string, valor: Buffer, idUsuario: number | null) => {
      filas.set(clave, { valor_cifrado: valor, actualizado_en: new Date(), actualizado_por: idUsuario });
    }),
    eliminar: jest.fn(async (clave: string) => filas.delete(clave)),
  };
}

function armar(llaves: { actual?: string | null; anterior?: string | null }, repo = repositorioFalso()) {
  const cifrado = new CifradoFiscalService(llaves);
  const esquema = { tiene: jest.fn(async () => true), exigir: jest.fn(async () => undefined) };
  const boveda = new BovedaSecretosFiscales(repo as any, cifrado, esquema as any, new RelojPrueba(), new NotificadorCambiosFiscales());
  return { boveda, cifrado, repo, esquema };
}

/** Deja guardados los tres secretos cifrados con la llave dada. */
function sembrar(repo: ReturnType<typeof repositorioFalso>, llave: string) {
  const cifrado = new CifradoFiscalService({ actual: llave });
  for (const [nombre, valor] of [
    [SECRETOS_FISCALES.claveSol, 'ClaveSol#1'],
    [SECRETOS_FISCALES.greClientId, 'cliente-id'],
    [SECRETOS_FISCALES.greClientSecret, 'cliente-secreto'],
  ] as const) {
    repo.filas.set(nombre, {
      valor_cifrado: cifrado.cifrarTexto(valor, BovedaSecretosFiscales.contexto(nombre)),
      actualizado_en: new Date('2026-10-01'),
      actualizado_por: 7,
    });
  }
}

describe('BovedaSecretosFiscales', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('guarda cifrado y lo lee en claro; el valor no queda en texto plano en la base', async () => {
    const { boveda, repo } = armar({ actual: LLAVE_NUEVA });
    await boveda.guardar(SECRETOS_FISCALES.claveSol, 'MiClave', 3, {} as any);
    expect(repo.filas.get('sol_clave')!.valor_cifrado.toString('utf8')).not.toContain('MiClave');
    await expect(boveda.leer(SECRETOS_FISCALES.claveSol)).resolves.toBe('MiClave');
  });

  it('rotación perezosa: leer un secreto abierto con la llave anterior lo vuelve a cifrar con la vigente', async () => {
    const repo = repositorioFalso();
    sembrar(repo, LLAVE_VIEJA);
    const { boveda } = armar({ actual: LLAVE_NUEVA, anterior: LLAVE_VIEJA }, repo);

    await expect(boveda.leer(SECRETOS_FISCALES.claveSol)).resolves.toBe('ClaveSol#1');
    await new Promise((r) => setImmediate(r));

    // Ya abre solo con la vigente.
    const soloNueva = new CifradoFiscalService({ actual: LLAVE_NUEVA });
    expect(soloNueva.descifrarTexto(repo.filas.get('sol_clave')!.valor_cifrado, 'secreto:sol_clave')).toBe('ClaveSol#1');
    // Los que no se leyeron siguen con la anterior: ese es el hueco que cierra revisarLlaves.
    expect(() => soloNueva.descifrarTexto(repo.filas.get('gre_client_secret')!.valor_cifrado, 'secreto:gre_client_secret')).toThrow();
  });

  it('revisarLlaves(false) cuenta los pendientes sin cambiar nada', async () => {
    const repo = repositorioFalso();
    sembrar(repo, LLAVE_VIEJA);
    const { boveda } = armar({ actual: LLAVE_NUEVA, anterior: LLAVE_VIEJA }, repo);

    const r = await boveda.revisarLlaves(false);

    expect(r.map((x) => x.estado)).toEqual(['con_llave_anterior', 'con_llave_anterior', 'con_llave_anterior']);
    expect(repo.guardar).not.toHaveBeenCalled();
  });

  it('revisarLlaves(true) re-cifra TODOS los secretos con la vigente, sin esperar a que se lean, y conserva autor y valor', async () => {
    const repo = repositorioFalso();
    sembrar(repo, LLAVE_VIEJA);
    const { boveda } = armar({ actual: LLAVE_NUEVA, anterior: LLAVE_VIEJA }, repo);

    const r = await boveda.revisarLlaves(true);

    expect(r.every((x) => x.estado === 'recifrado')).toBe(true);
    const soloNueva = new CifradoFiscalService({ actual: LLAVE_NUEVA });
    expect(soloNueva.descifrarTexto(repo.filas.get('gre_client_secret')!.valor_cifrado, 'secreto:gre_client_secret')).toBe('cliente-secreto');
    expect(soloNueva.descifrarTexto(repo.filas.get('gre_client_id')!.valor_cifrado, 'secreto:gre_client_id')).toBe('cliente-id');
    expect(repo.filas.get('sol_clave')!.actualizado_por).toBe(7);
    // Una segunda pasada ya no tiene nada que hacer.
    expect((await boveda.revisarLlaves(true)).every((x) => x.estado === 'al_dia')).toBe(true);
  });

  it('sin llave anterior definida, lo cifrado con una llave perdida se informa como ilegible (no se pierde en silencio)', async () => {
    const repo = repositorioFalso();
    sembrar(repo, LLAVE_VIEJA);
    const { boveda } = armar({ actual: LLAVE_NUEVA }, repo);

    const r = await boveda.revisarLlaves(true);

    expect(r.every((x) => x.estado === 'ilegible')).toBe(true);
    expect(repo.guardar).not.toHaveBeenCalled();
  });

  it('distingue lo que falta, lo que está al día y lo que no abre con ninguna llave', async () => {
    const repo = repositorioFalso();
    const vigente = new CifradoFiscalService({ actual: LLAVE_NUEVA });
    repo.filas.set('sol_clave', { valor_cifrado: vigente.cifrarTexto('x', 'secreto:sol_clave'), actualizado_en: new Date(), actualizado_por: null });
    repo.filas.set('gre_client_id', {
      valor_cifrado: new CifradoFiscalService({ actual: OTRA }).cifrarTexto('y', 'secreto:gre_client_id'),
      actualizado_en: new Date(),
      actualizado_por: null,
    });
    const { boveda } = armar({ actual: LLAVE_NUEVA, anterior: LLAVE_VIEJA }, repo);

    const r = await boveda.revisarLlaves(false);

    expect(Object.fromEntries(r.map((x) => [x.nombre, x.estado]))).toEqual({
      sol_clave: 'al_dia',
      gre_client_id: 'ilegible',
      gre_client_secret: 'falta',
    });
  });

  it('sin FISCAL_SECRET_KEY vigente no descifra nada: sin_cifrado', async () => {
    const repo = repositorioFalso();
    sembrar(repo, LLAVE_VIEJA);
    const { boveda } = armar({ actual: null }, repo);
    expect((await boveda.revisarLlaves(true)).every((x) => x.estado === 'sin_cifrado')).toBe(true);
  });

  it('el diagnóstico informa ilegible cuando cambió la llave y no hay anterior', async () => {
    const repo = repositorioFalso();
    sembrar(repo, LLAVE_VIEJA);
    const { boveda } = armar({ actual: LLAVE_NUEVA }, repo);
    await expect(boveda.diagnostico(SECRETOS_FISCALES.claveSol)).resolves.toBe('ilegible');
    await expect(armar({ actual: LLAVE_NUEVA }).boveda.diagnostico(SECRETOS_FISCALES.claveSol)).resolves.toBe('falta');
  });
});

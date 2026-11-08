import { Logger } from '@nestjs/common';
import { RecifradoFiscalService } from './recifrado-fiscal.service';

function crear(opciones: {
  rotacion?: boolean;
  secretos?: Array<{ nombre: string; estado: string }>;
  certs?: Array<{ ambiente: string; estado: string }>;
  falla?: boolean;
} = {}) {
  const secretos = opciones.secretos ?? [
    { nombre: 'sol_clave', estado: 'con_llave_anterior' },
    { nombre: 'gre_client_id', estado: 'falta' },
    { nombre: 'gre_client_secret', estado: 'falta' },
  ];
  const certs = opciones.certs ?? [{ ambiente: 'beta', estado: 'falta' }, { ambiente: 'produccion', estado: 'con_llave_anterior' }];
  const convertir = (estado: string, aplicar: boolean) => (aplicar && estado === 'con_llave_anterior' ? 'recifrado' : estado);
  const boveda = {
    revisarLlaves: jest.fn(async (aplicar: boolean) => {
      if (opciones.falla) throw new Error('bd caída');
      return secretos.map((s) => ({ nombre: s.nombre, estado: convertir(s.estado, aplicar) }));
    }),
  };
  const certificados = { revisarLlaves: jest.fn(async (aplicar: boolean) => certs.map((c) => ({ ambiente: c.ambiente, estado: convertir(c.estado, aplicar) }))) };
  const cifrado = { diagnostico: jest.fn(() => ({ rotacion: opciones.rotacion ?? true })), exigirDisponible: jest.fn() };
  const auditoria = { registrar: jest.fn(async () => undefined) };
  const notificador = { notificar: jest.fn() };
  const servicio = new RecifradoFiscalService(boveda as any, certificados as any, cifrado as any, auditoria as any, notificador as any);
  return { servicio, boveda, certificados, cifrado, auditoria, notificador };
}

describe('RecifradoFiscalService (S7)', () => {
  beforeEach(() => jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined));
  afterEach(() => jest.restoreAllMocks());

  it('sin llave anterior definida el estado es 0 y no toca la base de datos', async () => {
    const { servicio, boveda, certificados } = crear({ rotacion: false });
    await expect(servicio.estadoLlave()).resolves.toEqual({ anterior_definida: false, secretos_con_llave_anterior: 0 });
    expect(boveda.revisarLlaves).not.toHaveBeenCalled();
    expect(certificados.revisarLlaves).not.toHaveBeenCalled();
  });

  it('con rotación en curso cuenta los secretos y certificados que aún dependen de la llave anterior (sin cambiarlos)', async () => {
    const { servicio, boveda, certificados } = crear();
    await expect(servicio.estadoLlave()).resolves.toEqual({ anterior_definida: true, secretos_con_llave_anterior: 2 });
    expect(boveda.revisarLlaves).toHaveBeenCalledWith(false);
    expect(certificados.revisarLlaves).toHaveBeenCalledWith(false);
  });

  it('si no se puede revisar, el estado no rompe GET /fiscal/estado', async () => {
    const { servicio } = crear({ falla: true });
    await expect(servicio.estadoLlave()).resolves.toEqual({ anterior_definida: true, secretos_con_llave_anterior: 0 });
  });

  it('recifrarTodo re-cifra, resume lo hecho, avisa que ya se puede quitar la llave anterior, audita y refresca la salud', async () => {
    const { servicio, auditoria, notificador } = crear();

    const r = await servicio.recifrarTodo({ id_usuario: 4, nombre: 'Ana', ip: '10.0.0.1' });

    expect(r).toMatchObject({ revisados: 2, recifrados: 2, ya_vigentes: 0, ilegibles: 0, puede_quitar_llave_anterior: true });
    expect(r.detalle).toEqual(expect.arrayContaining([
      { secreto: 'Clave SOL', estado: 'recifrado' },
      { secreto: 'Certificado digital de producción', estado: 'recifrado' },
      { secreto: 'Certificado digital de BETA', estado: 'falta' },
    ]));
    expect(auditoria.registrar).toHaveBeenCalledWith(expect.objectContaining({
      accion: 'FISCAL_SECRETOS_RECIFRADOS', id_usuario: 4, ip: '10.0.0.1',
      detalle: expect.objectContaining({ recifrados: 2, revisados: 2 }),
    }));
    expect(notificador.notificar).toHaveBeenCalledWith('credenciales');
  });

  it('un secreto ilegible impide quitar la llave anterior y se cuenta', async () => {
    const { servicio } = crear({ secretos: [{ nombre: 'sol_clave', estado: 'ilegible' }, { nombre: 'gre_client_id', estado: 'al_dia' }], certs: [] });
    const r = await servicio.recifrarTodo({ id_usuario: 1, nombre: null, ip: null });
    expect(r).toMatchObject({ ilegibles: 1, ya_vigentes: 1, recifrados: 0, puede_quitar_llave_anterior: false });
  });

  it('sin FISCAL_SECRET_KEY vigente no hace nada y falla antes de tocar secretos', async () => {
    const e = crear();
    e.cifrado.exigirDisponible.mockImplementation(() => { throw new Error('sin llave'); });
    await expect(e.servicio.recifrarTodo({ id_usuario: 1, nombre: null, ip: null })).rejects.toThrow('sin llave');
    expect(e.boveda.revisarLlaves).not.toHaveBeenCalled();
    expect(e.auditoria.registrar).not.toHaveBeenCalled();
  });
});

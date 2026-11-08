import { CertificadoFiscalService } from '../certificado/certificado-fiscal.service';
import { ActorFiscal } from '../config/fiscal-config.tipos';
import { EmisorPruebaBeta } from '../config/fiscal-tokens';
import { FiscalAdminBussnies } from './fiscal-admin.bussnies';

const ACTOR = { id_usuario: 1, nombre: 'admin', ip: '127.0.0.1' } as unknown as ActorFiscal;

describe('FiscalAdminBussnies.generarCertificadoAutofirmado', () => {
  function crear() {
    const generarAutofirmadoBeta = jest.fn().mockResolvedValue({ ambiente: 'beta', ruc: '20614736420' });
    const certificados = { generarAutofirmadoBeta } as unknown as CertificadoFiscalService;
    const emisorBeta: EmisorPruebaBeta = {
      obtenerEmisor: jest.fn().mockResolvedValue({ ruc: '20614736420', razonSocial: 'EMISOR BETA SAC', direccion: 'x' }),
    };
    const admin = new FiscalAdminBussnies(
      {} as never,
      {} as never,
      certificados,
      {} as never,
      {} as never,
      {} as never,
      emisorBeta,
    );
    return { admin, generarAutofirmadoBeta, emisorBeta };
  }

  it('pasa el RUC y la razón social del emisor BETA al generar el autofirmado', async () => {
    const { admin, generarAutofirmadoBeta, emisorBeta } = crear();
    await admin.generarCertificadoAutofirmado({ dias: 90 }, ACTOR);
    expect(emisorBeta.obtenerEmisor).toHaveBeenCalledTimes(1);
    expect(generarAutofirmadoBeta).toHaveBeenCalledWith(ACTOR, 90, { ruc: '20614736420', razonSocial: 'EMISOR BETA SAC' });
  });

  it('usa 365 días cuando no se indican', async () => {
    const { admin, generarAutofirmadoBeta } = crear();
    await admin.generarCertificadoAutofirmado({}, ACTOR);
    expect(generarAutofirmadoBeta).toHaveBeenCalledWith(ACTOR, 365, { ruc: '20614736420', razonSocial: 'EMISOR BETA SAC' });
  });
});

describe('FiscalAdminBussnies.subirCertificado', () => {
  const ARCHIVO = { buffer: Buffer.from('x'), originalname: 'c.pfx' };

  function crear() {
    const subir = jest.fn().mockResolvedValue({ ambiente: 'beta', ruc: '20614736420' });
    const certificados = { subir } as unknown as CertificadoFiscalService;
    const emisorBeta: EmisorPruebaBeta = {
      obtenerEmisor: jest.fn().mockResolvedValue({ ruc: '20614736420', razonSocial: 'EMISOR BETA SAC', direccion: 'x' }),
    };
    const admin = new FiscalAdminBussnies({} as never, {} as never, certificados, {} as never, {} as never, {} as never, emisorBeta);
    return { admin, subir, emisorBeta };
  }

  it('pasa el emisor BETA al servicio cuando el ambiente es beta', async () => {
    const { admin, subir, emisorBeta } = crear();
    await admin.subirCertificado(ARCHIVO, { clave: 'k', ambiente: 'beta' } as never, ACTOR);
    expect(emisorBeta.obtenerEmisor).toHaveBeenCalledTimes(1);
    expect(subir).toHaveBeenCalledWith(
      ARCHIVO,
      'k',
      { ambiente: 'beta', forzar: undefined },
      ACTOR,
      expect.objectContaining({ ruc: '20614736420' }),
    );
  });

  it('no consulta ni pasa el emisor BETA en produccion ni sin ambiente', async () => {
    const { admin, subir, emisorBeta } = crear();
    await admin.subirCertificado(ARCHIVO, { clave: 'k', ambiente: 'produccion' } as never, ACTOR);
    await admin.subirCertificado(ARCHIVO, { clave: 'k' } as never, ACTOR);
    expect(emisorBeta.obtenerEmisor).not.toHaveBeenCalled();
    expect(subir.mock.calls.every((c) => c[4] === undefined)).toBe(true);
  });

  it('si el emisor BETA no se puede obtener, el error sube y no se guarda nada', async () => {
    const { admin, subir, emisorBeta } = crear();
    (emisorBeta.obtenerEmisor as jest.Mock).mockRejectedValue(new Error('sin emisor'));
    await expect(admin.subirCertificado(ARCHIVO, { clave: 'k', ambiente: 'beta' } as never, ACTOR)).rejects.toThrow('sin emisor');
    expect(subir).not.toHaveBeenCalled();
  });
});

describe('FiscalAdminBussnies · re-cifrado y avisos (S7)', () => {
  function crear(conServicios = true) {
    const recifrado = { recifrarTodo: jest.fn().mockResolvedValue({ revisados: 3, recifrados: 3 }) };
    const alertas = {
      estado: jest.fn().mockResolvedValue({ correo: 'antes@x.pe', correo_efectivo: 'antes@x.pe', origen: 'configurado' }),
      guardarCorreo: jest.fn().mockResolvedValue({ correo: 'nuevo@x.pe', correo_efectivo: 'nuevo@x.pe', origen: 'configurado' }),
    };
    const auditoria = { registrar: jest.fn().mockResolvedValue(undefined) };
    const emisorBeta: EmisorPruebaBeta = { obtenerEmisor: jest.fn() };
    const admin = new FiscalAdminBussnies(
      {} as never, {} as never, {} as never, {} as never, {} as never, auditoria as never, emisorBeta,
      conServicios ? (recifrado as never) : undefined,
      conServicios ? (alertas as never) : undefined,
    );
    return { admin, recifrado, alertas, auditoria };
  }

  it('recifrarSecretos delega con el actor (la auditoría la hace el servicio de re-cifrado)', async () => {
    const { admin, recifrado } = crear();
    await expect(admin.recifrarSecretos(ACTOR)).resolves.toEqual({ revisados: 3, recifrados: 3 });
    expect(recifrado.recifrarTodo).toHaveBeenCalledWith(ACTOR);
  });

  it('guardar el correo de avisos audita quién lo cambió, con el valor anterior y el nuevo', async () => {
    const { admin, alertas, auditoria } = crear();
    const r = await admin.guardarCorreoAlertas('nuevo@x.pe', ACTOR);
    expect(r.correo).toBe('nuevo@x.pe');
    expect(alertas.guardarCorreo).toHaveBeenCalledWith('nuevo@x.pe');
    expect(auditoria.registrar).toHaveBeenCalledWith(expect.objectContaining({
      accion: 'CONFIG_OPERACION', id_usuario: 1, ip: '127.0.0.1',
      detalle: { cambio: 'correo_alertas', antes: 'antes@x.pe', despues: 'nuevo@x.pe' },
    }));
  });

  it('sin los servicios registrados responde un error claro en lugar de fallar con un TypeError', () => {
    const { admin } = crear(false);
    expect(() => admin.recifrarSecretos(ACTOR)).toThrow(/no está disponible/);
    expect(() => admin.estadoAlertas()).toThrow(/no están disponibles/);
  });
});

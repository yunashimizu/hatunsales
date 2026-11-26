import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { ReceptorBussnies } from './receptor.bussnies';

/**
 * Buscar una empresa por RUC: la base local manda. Solo si no está se valida el dígito
 * verificador y recién entonces se sale a la consulta externa (que gasta cuota).
 */
const RUC_BUENO = '20131312955';
const RUC_MALO = '20131312954'; // mismo número con el dígito final cambiado

function armar(enBase: any = null) {
  const repo = {
    buscarEmpresaPorRuc: jest.fn().mockResolvedValue(enBase),
    guardarEmpresa: jest.fn(async (datos: any) => ({ id_empresa: 11, ...datos })),
  };
  const consulta = {
    consultarRuc: jest.fn().mockResolvedValue({
      razon_social: 'SUNAT', nombre_comercial: '', telefonos: '', tipo: '', estado: 'ACTIVO', condicion: 'HABIDO',
      direccion: 'AV. GARCILASO DE LA VEGA 1472', departamento: '', provincia: '', distrito: '', ubigeo: '', capital: '',
      fecha_inscripcion: '', fecha_baja: '',
    }),
  };
  return { servicio: new ReceptorBussnies(repo as never, consulta as never), repo, consulta };
}

describe('ReceptorBussnies.buscarEmpresa · dígito verificador del RUC', () => {
  it('un RUC mal digitado y no guardado responde «RUC no válido» sin llamar a la consulta externa', async () => {
    const { servicio, repo, consulta } = armar();

    await expect(servicio.buscarEmpresa(RUC_MALO)).rejects.toThrow(new BadRequestException('RUC no válido'));
    expect(repo.buscarEmpresaPorRuc).toHaveBeenCalledWith(RUC_MALO); // primero se miró la base local
    expect(consulta.consultarRuc).not.toHaveBeenCalled();
    expect(repo.guardarEmpresa).not.toHaveBeenCalled();
  });

  it('lo mismo entrando por buscarPorDocumento, con y sin guardar', async () => {
    const { servicio, consulta } = armar();

    await expect(servicio.buscarPorDocumento(RUC_MALO, true)).rejects.toBeInstanceOf(BadRequestException);
    await expect(servicio.buscarPorDocumento(RUC_MALO, false)).rejects.toBeInstanceOf(BadRequestException);
    expect(consulta.consultarRuc).not.toHaveBeenCalled();
  });

  it('un RUC ya guardado se sigue devolviendo aunque su dígito esté mal', async () => {
    const guardada = { id_empresa: 5, ruc: RUC_MALO, razon_social: 'FERRETERIA ANTIGUA SAC', estado: 'ACTIVO', condicion: 'HABIDO' };
    const { servicio, consulta } = armar(guardada);

    const receptor = await servicio.buscarEmpresa(RUC_MALO);

    expect(receptor).toMatchObject({ origen: 'base', id_empresa: 5, numero_documento: RUC_MALO, denominacion: 'FERRETERIA ANTIGUA SAC' });
    expect(consulta.consultarRuc).not.toHaveBeenCalled();
  });

  it('un RUC válido y no guardado sí se consulta, y con guardar=false no se registra', async () => {
    const { servicio, repo, consulta } = armar();

    const receptor = await servicio.buscarEmpresa(RUC_BUENO, false);

    expect(consulta.consultarRuc).toHaveBeenCalledWith(RUC_BUENO);
    expect(repo.guardarEmpresa).not.toHaveBeenCalled();
    expect(receptor).toMatchObject({ origen: 'externo', numero_documento: RUC_BUENO, estado: 'ACTIVO', condicion: 'HABIDO' });
  });

  it('un RUC válido con guardar=true queda registrado', async () => {
    const { servicio, repo } = armar();

    const receptor = await servicio.buscarEmpresa(RUC_BUENO, true);

    expect(repo.guardarEmpresa).toHaveBeenCalledTimes(1);
    expect(receptor).toMatchObject({ origen: 'externo', id_empresa: 11 });
  });

  it('si la consulta externa no está disponible deja el borrador de siempre (no es un RUC inválido)', async () => {
    const { servicio, consulta } = armar();
    consulta.consultarRuc.mockRejectedValue(new ServiceUnavailableException('Sin conexión'));

    const receptor = await servicio.buscarEmpresa(RUC_BUENO);

    expect(receptor).toMatchObject({ tipo: 'empresa', numero_documento: RUC_BUENO, denominacion: '' });
    expect(receptor.advertencia).toBeTruthy();
  });
});

/**
 * Alta o actualización a mano: con 11 dígitos el RUC tiene que ser válido. Un RUC con dígito
 * verificador malo no puede existir: la factura fallaría al emitirse.
 */
describe('ReceptorBussnies.registrarManual · dígito verificador del RUC', () => {
  it('un RUC de dígito malo responde «RUC no válido» y no guarda nada', async () => {
    const { servicio, repo } = armar();

    await expect(servicio.registrarManual(RUC_MALO, { denominacion: 'FERRETERIA EL SUR SAC' }))
      .rejects.toThrow(new BadRequestException('RUC no válido'));
    expect(repo.guardarEmpresa).not.toHaveBeenCalled();
  });

  it('un RUC válido se guarda como siempre (aunque venga con guiones o espacios)', async () => {
    const { servicio, repo } = armar();

    const receptor = await servicio.registrarManual('20-131 312955', { denominacion: 'FERRETERIA EL SUR SAC', direccion: 'AV. LIMA 1' });

    expect(repo.guardarEmpresa).toHaveBeenCalledWith(expect.objectContaining({ ruc: RUC_BUENO, razon_social: 'FERRETERIA EL SUR SAC' }));
    expect(receptor).toMatchObject({ tipo: 'empresa', id_empresa: 11 });
  });

  it('un DNI de 8 dígitos no se ve afectado', async () => {
    const { servicio, repo } = armar();
    (repo as any).guardarCliente = jest.fn(async (datos: any) => ({ id_cliente: 21, ...datos }));

    const receptor = await servicio.registrarManual('71739060', { denominacion: 'ROSA QUISPE MAMANI' });

    expect((repo as any).guardarCliente).toHaveBeenCalledTimes(1);
    expect(receptor).toMatchObject({ tipo: 'cliente', id_cliente: 21 });
  });

  it('un documento con otro largo y el nombre vacío se rechazan como antes', async () => {
    const { servicio, repo } = armar();

    await expect(servicio.registrarManual('123456789', { denominacion: 'X' }))
      .rejects.toThrow(new BadRequestException('El documento debe tener 8 dígitos si es DNI u 11 si es RUC'));
    await expect(servicio.registrarManual(RUC_BUENO, { denominacion: '  ' }))
      .rejects.toThrow(new BadRequestException('Indique el nombre o razón social'));
    expect(repo.guardarEmpresa).not.toHaveBeenCalled();
  });
});

describe('ReceptorBussnies · ubigeo y correo en la respuesta (Fases 3.4 y 3.5)', () => {
  const UBICACION = { ubigeo: '150101', departamento: 'LIMA', provincia: 'LIMA', distrito: 'LIMA' };

  it('RUC ya guardado: trae ubigeo, departamento, provincia, distrito y el correo de la ficha', async () => {
    const { servicio } = armar({ id_empresa: 3, ruc: RUC_BUENO, razon_social: 'SUNAT', email: 'compras@sunat.pe', ...UBICACION });
    const r = await servicio.buscarPorDocumento(RUC_BUENO, false);
    expect(r).toMatchObject({ origen: 'base', id_empresa: 3, email: 'compras@sunat.pe', ...UBICACION });
  });

  it('RUC consultado sin guardar: la ubicación sale de la consulta externa; vacíos o «-» no se mandan', async () => {
    const { servicio, consulta } = armar();
    consulta.consultarRuc.mockResolvedValue({
      razon_social: 'SUNAT', nombre_comercial: '', telefonos: '', tipo: '', estado: 'ACTIVO', condicion: 'HABIDO',
      direccion: 'AV. X', departamento: 'LIMA', provincia: '-', distrito: '', ubigeo: '150101', capital: '',
      fecha_inscripcion: '', fecha_baja: '',
    });
    const r = await servicio.buscarPorDocumento(RUC_BUENO, false);
    expect(r).toMatchObject({ origen: 'externo', ubigeo: '150101', departamento: 'LIMA' });
    expect(r).not.toHaveProperty('provincia');
    expect(r).not.toHaveProperty('distrito');
  });

  it('empresa antigua sin correo ni ubigeo: email vacío como antes y sin campos de ubicación', async () => {
    const { servicio } = armar({ id_empresa: 3, ruc: RUC_BUENO, razon_social: 'SUNAT' });
    const r = await servicio.buscarPorDocumento(RUC_BUENO, true);
    expect(r.email).toBe('');
    expect(r).not.toHaveProperty('ubigeo');
  });
});

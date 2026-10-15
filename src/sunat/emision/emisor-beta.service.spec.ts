import { EmisorBetaService, CLAVE_EMISOR_BETA } from './emisor-beta.service';

describe('EmisorBetaService', () => {
  const beta = {
    ruc: '20131312955',
    razon_social: 'EMISOR DE PRUEBAS',
    nombre_comercial: '',
    direccion: 'DOMICILIO BETA',
    ubigeo: '150101',
    distrito: 'LIMA',
    provincia: 'LIMA',
    departamento: 'LIMA',
    codigo_establecimiento: '0000',
  };

  it('guarda y lee un emisor separado sin sobrescribir las claves del negocio', async () => {
    const valores: Record<string, string> = {};
    const repo = {
      leer: jest.fn(async () => valores),
      guardar: jest.fn(async (pares) => {
        Object.assign(valores, pares);
      }),
    };
    const general = { emisor: jest.fn() };
    const servicio = new EmisorBetaService(
      repo as any,
      general as any,
      { infoActivo: jest.fn().mockResolvedValue(null) } as any,
      { registrar: jest.fn().mockResolvedValue(undefined) } as any,
    );
    const vista = await servicio.guardar(beta, {
      id_usuario: 1,
      nombre: 'Admin',
      ip: null,
    });
    expect(Object.keys(repo.guardar.mock.calls[0][0])).toEqual([
      CLAVE_EMISOR_BETA,
    ]);
    expect(vista.emisor.ruc).toBe(beta.ruc);
    expect((await servicio.obtenerEmisor()).razonSocial).toBe(
      beta.razon_social,
    );
    expect(general.emisor).not.toHaveBeenCalled();
  });

  it('rechaza un RUC con dígito verificador incorrecto antes de escribir', async () => {
    const repo = { guardar: jest.fn() };
    const servicio = new EmisorBetaService(
      repo as any,
      {} as any,
      {} as any,
      {} as any,
    );
    await expect(
      servicio.guardar(
        { ...beta, ruc: '20131312950' },
        { id_usuario: null, nombre: null, ip: null },
      ),
    ).rejects.toMatchObject({ codigo: 'FISCAL_CONFIG_INVALIDA' });
    expect(repo.guardar).not.toHaveBeenCalled();
  });
});

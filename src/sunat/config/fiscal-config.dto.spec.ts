import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync, ValidationError } from 'class-validator';
import {
  ActualizarConfigFiscalDto,
  AmbienteRequeridoDto,
  AuditoriaConsultaDto,
  CertificadoPublicoConsultaDto,
  CredencialesGreDto,
  CredencialesSolDto,
  SubirCertificadoDto,
} from './fiscal-config.dto';

/** Igual que el ValidationPipe global: transform + whitelist. */
function validar<T extends object>(clase: new () => T, cuerpo: object): { valor: T; errores: string[] } {
  const valor = plainToInstance(clase, cuerpo);
  const aplanar = (errores: ValidationError[]): string[] =>
    errores.flatMap((e) => [...Object.values(e.constraints ?? {}), ...aplanar(e.children ?? [])]);
  return { valor, errores: aplanar(validateSync(valor, { whitelist: true })) };
}

describe('DTOs de /fiscal/*', () => {
  it('ActualizarConfigFiscalDto acepta un cambio completo y normaliza mayúsculas/minúsculas', () => {
    const { valor, errores } = validar(ActualizarConfigFiscalDto, {
      proveedor: 'SUNAT_DIRECTO',
      ambiente: 'Produccion',
      boletas_modo: 'individual',
      envio_en_linea: 'true',
      aplicar_reglas_2027: false,
      series: { factura: 'f001', boleta: 'b001', nc_factura: 'fc01', gre_remitente: 't001' },
      emisor: { ubigeo: '150119', codigo_establecimiento: '0000', distrito: ' LURIN ' },
      codigo_producto_defecto: '',
      sol: { usuario: 'hatun001', clave: 'Clave#2026' },
      gre: { activa: 'false', correlativo_inicial: '25', partida: { ubigeo: '', direccion: 'ALMACÉN' } },
      confirmo_no_ose: true,
    });
    expect(errores).toEqual([]);
    expect(valor).toMatchObject({
      proveedor: 'sunat_directo',
      ambiente: 'produccion',
      envio_en_linea: true,
      aplicar_reglas_2027: 'false',
      series: { factura: 'F001', boleta: 'B001', nc_factura: 'FC01', gre_remitente: 'T001' },
      emisor: { distrito: 'LURIN' },
      sol: { usuario: 'HATUN001' },
      gre: { activa: false, correlativo_inicial: 25, partida: { ubigeo: '', direccion: 'ALMACÉN' } },
    });
  });

  it('rechaza series con el prefijo equivocado, con mensajes en español', () => {
    const { errores } = validar(ActualizarConfigFiscalDto, {
      series: { factura: 'B001', boleta: 'F001', nd_boleta: 'BD1', gre_remitente: 'G001' },
    });
    expect(errores).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/factura debe tener 4 caracteres y empezar con F/),
        expect.stringMatching(/boleta debe tener 4 caracteres y empezar con B/),
        expect.stringMatching(/nota de débito de boleta/),
        expect.stringMatching(/guía de remisión remitente/),
      ]),
    );
  });

  it('valida proveedor, ambiente, ubigeo, código de establecimiento y código de producto', () => {
    const { errores } = validar(ActualizarConfigFiscalDto, {
      proveedor: 'ose',
      ambiente: 'test',
      emisor: { ubigeo: '15011', codigo_establecimiento: '00001' },
      codigo_producto_defecto: '123',
      gre: { correlativo_inicial: 0, partida: { ubigeo: 'ABC' } },
    });
    expect(errores).toEqual(
      expect.arrayContaining([
        'El proveedor debe ser nubefact o sunat_directo.',
        'El ambiente debe ser beta o produccion.',
        expect.stringMatching(/ubigeo debe tener 6 dígitos/),
        expect.stringMatching(/código de establecimiento debe tener 4 dígitos/),
        expect.stringMatching(/código de producto SUNAT debe tener 8 dígitos/),
        expect.stringMatching(/correlativo inicial de la GRE debe ser al menos 1/),
        expect.stringMatching(/ubigeo del punto de partida/),
      ]),
    );
  });

  it('descarta campos desconocidos (whitelist) sin fallar', () => {
    const { valor, errores } = validar(ActualizarConfigFiscalDto, { proveedor: 'nubefact', hackeo: true, emisor: { ruc: '1' } });
    expect(errores).toEqual([]);
    expect(valor).not.toHaveProperty('hackeo');
    expect(valor.emisor).not.toHaveProperty('ruc');
  });

  it('CredencialesSolDto: usuario de 8 (o con el RUC delante) y clave de 8 a 12', () => {
    expect(validar(CredencialesSolDto, { usuario: 'HATUN001' }).errores).toEqual([]);
    expect(validar(CredencialesSolDto, { usuario: '20610206337HATUN001', clave: '12345678' }).errores).toEqual([]);
    expect(validar(CredencialesSolDto, { usuario: 'HAT01' }).errores.join(' ')).toMatch(/8 caracteres/);
    expect(validar(CredencialesSolDto, { usuario: 'HATUN001', clave: '1234567' }).errores.join(' ')).toMatch(/entre 8 y 12/);
    expect(validar(CredencialesSolDto, { usuario: 'HATUN001', clave: '1234567890123' }).errores.join(' ')).toMatch(/entre 8 y 12/);
  });

  it('SubirCertificadoDto (multipart): clave obligatoria, forzar como texto y ambiente opcional', () => {
    const { valor, errores } = validar(SubirCertificadoDto, { clave: 'abc', forzar: 'true', ambiente: 'BETA' });
    expect(errores).toEqual([]);
    expect(valor).toMatchObject({ forzar: true, ambiente: 'beta' });
    expect(validar(SubirCertificadoDto, {}).errores.join(' ')).toMatch(/contraseña del certificado/);
    expect(validar(SubirCertificadoDto, { clave: 'x'.repeat(129) }).errores.join(' ')).toMatch(/128/);
  });

  it('CredencialesGreDto: client_id de SOL y client_secret sin espacios', () => {
    expect(validar(CredencialesGreDto, { client_id: '1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d', client_secret: 'Hty/M6QshYvPgItX2P0+Kw==' }).errores).toEqual([]);
    expect(validar(CredencialesGreDto, { client_id: 'mi id', client_secret: 'secreto largo' }).errores.length).toBe(2);
    expect(validar(CredencialesGreDto, {}).errores.join(' ')).toMatch(/client_id/);
  });

  it('consultas: límite de auditoría, ambiente obligatorio al borrar y formato del .cer', () => {
    expect(validar(AuditoriaConsultaDto, { limite: '20', antes_de: '90' }).valor).toMatchObject({ limite: 20, antes_de: 90 });
    expect(validar(AuditoriaConsultaDto, { limite: '500' }).errores.join(' ')).toMatch(/hasta 200/);
    expect(validar(AmbienteRequeridoDto, {}).errores.join(' ')).toMatch(/ambiente=beta o ambiente=produccion/);
    expect(validar(CertificadoPublicoConsultaDto, { formato: 'PEM', ambiente: 'produccion' }).errores).toEqual([]);
    expect(validar(CertificadoPublicoConsultaDto, { formato: 'p12' }).errores.join(' ')).toMatch(/cer, der o pem/);
  });
});

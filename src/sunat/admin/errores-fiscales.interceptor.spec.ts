import { BadRequestException, HttpException, NotFoundException, PayloadTooLargeException } from '@nestjs/common';
import { lastValueFrom, throwError } from 'rxjs';
import { FiscalConfigError } from '../config/fiscal-errores';
import { ErroresFiscalesInterceptor, traducirErrorFiscal } from './errores-fiscales.interceptor';

describe('ErroresFiscalesInterceptor', () => {
  it('convierte FiscalConfigError en HTTP con { statusCode, message, codigo, ...detalle }', () => {
    const error = new FiscalConfigError('FISCAL_NO_LISTO', 'Todavía no se puede activar.', {
      faltantes: ['clave_sol'],
      codigo: 'NO_DEBE_PISAR',
    });
    const http = traducirErrorFiscal(error) as HttpException;
    expect(http).toBeInstanceOf(HttpException);
    expect(http.getStatus()).toBe(409);
    expect(http.getResponse()).toEqual({
      statusCode: 409,
      message: 'Todavía no se puede activar.',
      codigo: 'FISCAL_NO_LISTO',
      faltantes: ['clave_sol'],
    });
  });

  it('usa el estado HTTP de cada código (400, 404, 413, 422, 503)', () => {
    const estado = (codigo: any) => (traducirErrorFiscal(new FiscalConfigError(codigo, 'x')) as HttpException).getStatus();
    expect(estado('FISCAL_CERT_CLAVE_INCORRECTA')).toBe(400);
    expect(estado('FISCAL_CERT_NO_CARGADO')).toBe(404);
    expect(estado('FISCAL_CERT_DEMASIADO_GRANDE')).toBe(413);
    expect(estado('FISCAL_CERT_RUC_NO_COINCIDE')).toBe(422);
    expect(estado('FISCAL_CLAVE_MAESTRA_NO_CONFIGURADA')).toBe(503);
    expect(estado('FISCAL_MIGRACION_PENDIENTE')).toBe(503);
    expect(estado('FISCAL_CREDENCIALES_EN_USO')).toBe(409);
  });

  it('traduce los errores de multer a códigos fiscales en español', () => {
    const grande = traducirErrorFiscal(new PayloadTooLargeException('File too large')) as HttpException;
    expect(grande.getStatus()).toBe(413);
    expect(grande.getResponse()).toMatchObject({ codigo: 'FISCAL_CERT_DEMASIADO_GRANDE' });

    const campo = traducirErrorFiscal(new BadRequestException('Unexpected field')) as HttpException;
    expect(campo.getStatus()).toBe(400);
    expect(campo.getResponse()).toMatchObject({ codigo: 'FISCAL_CERT_FORMATO_INVALIDO' });
  });

  it('deja pasar el resto de errores tal cual (validación, 404 genérico, errores internos)', () => {
    const validacion = new BadRequestException(['clave must be a string']);
    expect(traducirErrorFiscal(validacion)).toBe(validacion);
    const noEncontrado = new NotFoundException();
    expect(traducirErrorFiscal(noEncontrado)).toBe(noEncontrado);
    const interno = new Error('boom');
    expect(traducirErrorFiscal(interno)).toBe(interno);
  });

  it('intercepta el flujo del controlador', async () => {
    const interceptor = new ErroresFiscalesInterceptor();
    const resultado = interceptor.intercept({} as any, {
      handle: () => throwError(() => new FiscalConfigError('FISCAL_SOLO_BETA', 'Solo en BETA.')),
    });
    await expect(lastValueFrom(resultado)).rejects.toMatchObject({ status: 409 });
  });
});

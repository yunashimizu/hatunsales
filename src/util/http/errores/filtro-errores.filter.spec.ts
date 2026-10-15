import {
  ArgumentsHost,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  PayloadTooLargeException,
  UnauthorizedException,
} from '@nestjs/common';
import { EntityNotFoundError, QueryFailedError } from 'typeorm';
import { MARCA_ERROR_REGISTRADO } from '../registro-peticiones.middleware';
import { DemasiadasPeticionesException } from '../limite-peticiones/demasiadas-peticiones.exception';
import { cuerpoErrorValidacion } from '../validacion/mensajes-validacion';
import { ErrorDominio } from './error-dominio';
import { EsquemaPendienteError } from './esquema-pendiente.error';
import { FiltroErroresGlobal } from './filtro-errores.filter';

class RespuestaFalsa {
  statusCode = 200;
  cuerpo: any;
  cabeceras: Record<string, string> = {};
  headersSent = false;
  writableEnded = false;
  destruida = false;
  locals: Record<string, unknown> = {};

  status(codigo: number) {
    this.statusCode = codigo;
    return this;
  }
  json(cuerpo: unknown) {
    this.cuerpo = cuerpo;
    return this;
  }
  setHeader(nombre: string, valor: unknown) {
    this.cabeceras[nombre.toLowerCase()] = String(valor);
  }
  getHeader(nombre: string) {
    return this.cabeceras[nombre.toLowerCase()];
  }
  removeHeader(nombre: string) {
    delete this.cabeceras[nombre.toLowerCase()];
  }
  destroy() {
    this.destruida = true;
  }
}

function errorPg(codigo: string, mensaje: string, extra: Record<string, unknown> = {}) {
  return Object.assign(new Error(mensaje), { code: codigo, severity: 'ERROR', ...extra });
}

function consultaFallida(sql: string, codigo: string, mensaje: string, extra: Record<string, unknown> = {}) {
  return new QueryFailedError(sql, ['12345678', 'secreto@correo.pe'], errorPg(codigo, mensaje, extra));
}

describe('FiltroErroresGlobal', () => {
  let filtro: FiltroErroresGlobal;
  let error: jest.SpyInstance;
  let warn: jest.SpyInstance;

  beforeEach(() => {
    filtro = new FiltroErroresGlobal();
    error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  function ejecutar(excepcion: unknown, url = '/venta/12', opciones: { metodo?: string; res?: RespuestaFalsa } = {}) {
    const res = opciones.res ?? new RespuestaFalsa();
    if (!res.locals.idPeticion) res.locals.idPeticion = 'id-de-prueba-123';
    const req = { method: opciones.metodo ?? 'GET', originalUrl: url, url, headers: {} };
    const host = {
      getType: () => 'http',
      switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
    } as unknown as ArgumentsHost;
    filtro.catch(excepcion, host);
    return res;
  }

  const textoLogs = () => JSON.stringify([...error.mock.calls, ...warn.mock.calls]);

  describe('HttpException', () => {
    it('conserva message y codigo de un cuerpo de dominio y agrega ruta e idPeticion', () => {
      const res = ejecutar(new BadRequestException({ message: 'Stock insuficiente', codigo: 'STOCK_INSUFICIENTE' }));
      expect(res.statusCode).toBe(400);
      expect(res.cuerpo).toEqual({
        statusCode: 400,
        message: 'Stock insuficiente',
        error: 'Solicitud inválida',
        codigo: 'STOCK_INSUFICIENTE',
        ruta: '/venta/12',
        idPeticion: 'id-de-prueba-123',
      });
      expect(error).not.toHaveBeenCalled();
    });

    it('mantiene los campos extra del dominio (p. ej. el producto en un 409)', () => {
      const res = ejecutar(new ConflictException({ message: 'Ya existe', codigo: 'PRODUCTO_DUPLICADO', producto: { id: 3 } }));
      expect(res.cuerpo).toMatchObject({ statusCode: 409, codigo: 'PRODUCTO_DUPLICADO', producto: { id: 3 } });
    });

    it('un texto simple sigue siendo texto y recibe un código por estado', () => {
      const res = ejecutar(new BadRequestException('La fecha es obligatoria'));
      expect(res.cuerpo).toMatchObject({ message: 'La fecha es obligatoria', codigo: 'SOLICITUD_INVALIDA' });
    });

    it('las validaciones siguen siendo un arreglo, con codigo VALIDACION y campos', () => {
      const cuerpo = cuerpoErrorValidacion([
        { property: 'cantidad', constraints: { min: 'cantidad must not be less than 1' }, children: [] },
      ]);
      const res = ejecutar(new BadRequestException(cuerpo));
      expect(res.cuerpo.message).toEqual(['El campo «cantidad» no puede ser menor que 1.']);
      expect(res.cuerpo).toMatchObject({ codigo: 'VALIDACION', campos: ['cantidad'], error: 'Solicitud inválida' });
    });

    it('traduce un arreglo de validación en inglés del ValidationPipe por defecto', () => {
      const res = ejecutar(new BadRequestException(['items.0.cantidad must be an integer number', 'Celular inválido']));
      expect(res.cuerpo.message).toEqual([
        'El campo «cantidad» (fila 1 de «items») debe ser un número entero.',
        'Celular inválido',
      ]);
      expect(res.cuerpo.codigo).toBe('VALIDACION');
    });

    it('ruta inexistente: mensaje en español, sin query string ni DNI', () => {
      const res = ejecutar(new NotFoundException('Cannot GET /sunat/dni/12345678?token=abc'), '/sunat/dni/12345678?token=abc');
      expect(res.statusCode).toBe(404);
      expect(res.cuerpo.message).toBe('No existe la ruta GET /sunat/dni/*** en el servidor.');
      expect(res.cuerpo.codigo).toBe('RUTA_NO_ENCONTRADA');
      expect(res.cuerpo.ruta).toBe('/sunat/dni/***');
      expect(JSON.stringify(res.cuerpo)).not.toContain('token');
    });

    it('traduce los textos por defecto de Nest', () => {
      expect(ejecutar(new ForbiddenException()).cuerpo).toMatchObject({
        message: 'No tienes permiso para realizar esta acción.',
        codigo: 'SIN_PERMISO',
        error: 'Sin permiso',
      });
      expect(ejecutar(new UnauthorizedException()).cuerpo).toMatchObject({ codigo: 'NO_AUTENTICADO', error: 'No autenticado' });
      expect(ejecutar(new PayloadTooLargeException('File too large')).cuerpo).toMatchObject({
        message: 'El archivo supera el tamaño máximo permitido.',
        codigo: 'ARCHIVO_MUY_GRANDE',
      });
      expect(ejecutar(new BadRequestException('Unexpected end of JSON input')).cuerpo.codigo).toBe('JSON_INVALIDO');
      expect(ejecutar(new BadRequestException('Validation failed (numeric string is expected)')).cuerpo).toMatchObject({
        message: 'El identificador debe ser un número entero.',
        codigo: 'ID_INVALIDO',
      });
    });

    it('no pisa un `error` personalizado pero sí la frase en inglés de Nest', () => {
      expect(ejecutar(new HttpException({ message: 'x', error: 'Detalle propio' }, 400)).cuerpo.error).toBe('Detalle propio');
      expect(ejecutar(new BadRequestException('x')).cuerpo.error).toBe('Solicitud inválida');
    });

    it('registra los 5xx y marca la respuesta para que el middleware no duplique la línea', () => {
      const res = ejecutar(new InternalServerErrorException('No se pudo generar el PDF'));
      expect(res.statusCode).toBe(500);
      expect(res.cuerpo.message).toBe('No se pudo generar el PDF');
      expect(error).toHaveBeenCalledTimes(1);
      expect(res.locals[MARCA_ERROR_REGISTRADO]).toBe(true);
    });

    it('429: cabecera Retry-After y reintentarEnSeg en el cuerpo', () => {
      const res = ejecutar(new DemasiadasPeticionesException(42, 'Demasiados intentos. Intente de nuevo en 42 s.'));
      expect(res.statusCode).toBe(429);
      expect(res.cabeceras['retry-after']).toBe('42');
      expect(res.cuerpo).toMatchObject({ codigo: 'DEMASIADAS_SOLICITUDES', reintentarEnSeg: 42, error: 'Demasiadas solicitudes' });
    });
  });

  describe('errores de dominio (sin HttpException)', () => {
    it('usa estadoHttp, codigo y cuerpo() como FiscalConfigError', () => {
      const fiscal = Object.assign(new Error('Falta ejecutar sql/fase9_sunat_directo.sql'), {
        codigo: 'FISCAL_MIGRACION_PENDIENTE',
        estadoHttp: 503,
        cuerpo() {
          return { statusCode: 503, message: this.message, codigo: this.codigo, faltantes: ['fiscal_envios'] };
        },
      });
      const res = ejecutar(fiscal);
      expect(res.statusCode).toBe(503);
      expect(res.cuerpo).toMatchObject({
        codigo: 'FISCAL_MIGRACION_PENDIENTE',
        message: 'Falta ejecutar sql/fase9_sunat_directo.sql',
        faltantes: ['fiscal_envios'],
      });
      expect(res.cabeceras['retry-after']).toBe('5');
    });

    it('acepta la forma de ErrorCaja (codigo + estadoHttp)', () => {
      const caja = Object.assign(new Error('Solo el dueño del turno'), { codigo: 'CAJA_TURNO_AJENO', estadoHttp: 403 });
      expect(ejecutar(caja).cuerpo).toMatchObject({ statusCode: 403, codigo: 'CAJA_TURNO_AJENO', message: 'Solo el dueño del turno' });
    });

    it('sin estado declarado responde 500 conservando código y mensaje (ErrorNucleoFiscal)', () => {
      const nucleo = Object.assign(new Error('El comprobante no pasa las validaciones'), {
        codigo: 'FISCAL_DOCUMENTO_INVALIDO',
        detalle: { errores: ['Falta el RUC'] },
      });
      const res = ejecutar(nucleo);
      expect(res.statusCode).toBe(500);
      expect(res.cuerpo).toMatchObject({ codigo: 'FISCAL_DOCUMENTO_INVALIDO', errores: ['Falta el RUC'] });
    });

    it('EsquemaPendienteError (ErrorDominio) → 503 con el script en el mensaje', () => {
      const res = ejecutar(new EsquemaPendienteError('sql/fase10_indices_rendimiento.sql'));
      expect(res.statusCode).toBe(503);
      expect(res.cuerpo).toMatchObject({
        codigo: 'ESQUEMA_PENDIENTE',
        message: 'Falta ejecutar sql/fase10_indices_rendimiento.sql en Railway.',
        script: 'sql/fase10_indices_rendimiento.sql',
      });
      expect(new EsquemaPendienteError('x')).toBeInstanceOf(ErrorDominio);
    });
  });

  describe('PostgreSQL', () => {
    it('23505 → 409 DUPLICADO con campos y sin los valores de la fila', () => {
      const res = ejecutar(
        consultaFallida('INSERT INTO usuarios (email) VALUES ($1)', '23505', 'duplicate key value violates unique constraint "uq_usuarios_email_lower"', {
          detail: 'Key (lower(email::text))=(secreto@correo.pe) already exists.',
          table: 'usuarios',
          constraint: 'uq_usuarios_email_lower',
        }),
        '/auth/register',
        { metodo: 'POST' },
      );
      expect(res.statusCode).toBe(409);
      expect(res.cuerpo).toMatchObject({ codigo: 'DUPLICADO', campos: ['email'] });
      expect(JSON.stringify(res.cuerpo)).not.toContain('secreto');
      expect(warn).toHaveBeenCalledTimes(1);
      expect(textoLogs()).not.toContain('secreto');
      expect(textoLogs()).not.toContain('12345678');
    });

    it('23503 al borrar → REGISTRO_EN_USO; al insertar → REFERENCIA_INVALIDA', () => {
      const borrar = ejecutar(
        consultaFallida('DELETE FROM clientes WHERE id_cliente = $1', '23503', 'update or delete on table "clientes" violates foreign key constraint'),
      );
      expect(borrar.cuerpo).toMatchObject({ statusCode: 409, codigo: 'REGISTRO_EN_USO' });
      const insertar = ejecutar(
        consultaFallida('INSERT INTO ventas (id_cliente) VALUES ($1)', '23503', 'insert or update on table "ventas" violates foreign key constraint', {
          detail: 'Key (id_cliente)=(999) is not present in table "clientes".',
        }),
      );
      expect(insertar.cuerpo).toMatchObject({ statusCode: 409, codigo: 'REFERENCIA_INVALIDA', campos: ['id_cliente'] });
    });

    it('datos inválidos y obligatorios → 400', () => {
      expect(ejecutar(consultaFallida('SELECT 1', '22P02', 'invalid input syntax for type integer: "abc"')).cuerpo).toMatchObject({
        statusCode: 400,
        codigo: 'DATO_INVALIDO',
      });
      expect(ejecutar(consultaFallida('INSERT', '23502', 'null value in column "nombre"', { column: 'nombre' })).cuerpo).toMatchObject({
        statusCode: 400,
        codigo: 'DATO_OBLIGATORIO',
        campos: ['nombre'],
      });
      expect(
        ejecutar(consultaFallida('UPDATE', '22001', 'value too long for type character varying(100)')).cuerpo.message,
      ).toBe('Un texto supera el largo máximo permitido (100 caracteres).');
      expect(textoLogs()).not.toContain('"abc"');
    });

    it('CHECK de stock → 409 INVENTARIO_STOCK_NEGATIVO', () => {
      const res = ejecutar(
        consultaFallida('UPDATE inventario SET stock = stock - $1', '23514', 'new row violates check constraint', {
          constraint: 'ck_inventario_stock_no_negativo',
        }),
      );
      expect(res.cuerpo).toMatchObject({ statusCode: 409, codigo: 'INVENTARIO_STOCK_NEGATIVO' });
    });

    it('deadlock → 503 REINTENTAR con Retry-After; timeout → TIEMPO_AGOTADO; tabla faltante → ESQUEMA_PENDIENTE', () => {
      const deadlock = ejecutar(consultaFallida('UPDATE inventario', '40P01', 'deadlock detected'));
      expect(deadlock.statusCode).toBe(503);
      expect(deadlock.cuerpo.codigo).toBe('REINTENTAR');
      expect(deadlock.cabeceras['retry-after']).toBe('1');

      expect(ejecutar(consultaFallida('SELECT', '57014', 'canceling statement due to statement timeout')).cuerpo.codigo).toBe('TIEMPO_AGOTADO');
      expect(ejecutar(consultaFallida('SELECT', '42P01', 'relation "arqueo_caja" does not exist')).cuerpo).toMatchObject({
        statusCode: 503,
        codigo: 'ESQUEMA_PENDIENTE',
      });
      expect(ejecutar(consultaFallida('SELECT', '53300', 'sorry, too many clients already')).cuerpo.codigo).toBe('BD_NO_DISPONIBLE');
    });

    it('defecto del programa (25P02) → 500 genérico con el SQL saneado solo en el log', () => {
      const res = ejecutar(consultaFallida("SELECT * FROM x WHERE dni = '44556677'", '25P02', 'current transaction is aborted'));
      expect(res.statusCode).toBe(500);
      expect(res.cuerpo.codigo).toBe('ERROR_SERVIDOR');
      expect(JSON.stringify(res.cuerpo)).not.toContain('transaction');
      expect(textoLogs()).toContain('25P02');
      expect(textoLogs()).not.toContain('44556677');
    });

    it('pool agotado o conexión caída → 503 BD_NO_DISPONIBLE', () => {
      expect(ejecutar(new Error('timeout exceeded when trying to connect')).cuerpo.codigo).toBe('BD_NO_DISPONIBLE');
      expect(ejecutar(new QueryFailedError('SELECT 1', [], new Error('Connection terminated unexpectedly'))).cuerpo.codigo).toBe(
        'BD_NO_DISPONIBLE',
      );
    });

    it('EntityNotFoundError → 404 y UpdateValuesMissingError → 400', () => {
      expect(ejecutar(new EntityNotFoundError('Producto', { id_producto: 9 })).cuerpo).toMatchObject({ statusCode: 404, codigo: 'NO_ENCONTRADO' });
      const sinValores = Object.assign(new Error('Cannot perform update query because update values are not defined.'), {
        name: 'UpdateValuesMissingError',
      });
      expect(ejecutar(sinValores).cuerpo).toMatchObject({ statusCode: 400, codigo: 'SIN_CAMBIOS' });
    });
  });

  describe('errores externos y desconocidos', () => {
    it('axios → 502 sin exponer la URL (que puede llevar el token)', () => {
      const axios = Object.assign(new Error('Request failed with status code 500'), {
        isAxiosError: true,
        config: { method: 'get', url: 'https://apiperu.dev/api/dni/12345678?token=SECRETO' },
        response: { status: 500 },
      });
      const res = ejecutar(axios);
      expect(res.statusCode).toBe(502);
      expect(res.cuerpo.codigo).toBe('SERVICIO_EXTERNO_NO_DISPONIBLE');
      expect(textoLogs()).toContain('apiperu.dev');
      expect(textoLogs()).not.toContain('SECRETO');
    });

    it('axios por tiempo → 504', () => {
      const axios = Object.assign(new Error('timeout of 8000ms exceeded'), { isAxiosError: true, code: 'ECONNABORTED', config: {} });
      expect(ejecutar(axios).statusCode).toBe(504);
    });

    it('body-parser: cuerpo demasiado grande → 413 con el límite', () => {
      const grande = Object.assign(new Error('request entity too large'), {
        status: 413,
        statusCode: 413,
        expose: true,
        type: 'entity.too.large',
        limit: 1048576,
      });
      expect(ejecutar(grande).cuerpo).toMatchObject({
        statusCode: 413,
        codigo: 'ARCHIVO_MUY_GRANDE',
        message: 'Los datos enviados superan el tamaño permitido (máximo 1 MB).',
      });
    });

    it('error desconocido → 500 genérico; el detalle va al log con datos enmascarados', () => {
      const res = ejecutar(new TypeError('No se encontró el cliente 44556677 (juan@correo.pe)'));
      expect(res.statusCode).toBe(500);
      expect(res.cuerpo).toMatchObject({ codigo: 'ERROR_SERVIDOR', error: 'Error interno del servidor' });
      expect(JSON.stringify(res.cuerpo)).not.toContain('cliente');
      expect(textoLogs()).toContain('TypeError');
      expect(textoLogs()).not.toContain('44556677');
      expect(textoLogs()).not.toContain('juan@correo.pe');
    });

    it('un valor que no es Error también se maneja', () => {
      expect(ejecutar('texto lanzado').statusCode).toBe(500);
    });
  });

  describe('respuesta', () => {
    it('no-store, sin Content-Disposition y con X-Request-Id', () => {
      const res = new RespuestaFalsa();
      res.setHeader('Content-Disposition', 'attachment; filename="venta.pdf"');
      ejecutar(new BadRequestException('x'), '/venta/1/pdf', { res });
      expect(res.cabeceras['cache-control']).toBe('no-store');
      expect(res.cabeceras['content-disposition']).toBeUndefined();
      expect(res.cabeceras['x-request-id']).toBe('id-de-prueba-123');
    });

    it('si la respuesta ya empezó, la corta en vez de mandar JSON', () => {
      const res = new RespuestaFalsa();
      res.headersSent = true;
      ejecutar(new Error('fallo a mitad del PDF'), '/venta/1/pdf', { res });
      expect(res.destruida).toBe(true);
      expect(res.cuerpo).toBeUndefined();
    });

    it('sin middleware usa la cabecera X-Request-Id válida de la petición', () => {
      const res = new RespuestaFalsa();
      res.locals = {};
      const req = { method: 'GET', originalUrl: '/x', headers: { 'x-request-id': 'cliente-abc-12345' } };
      const host = {
        getType: () => 'http',
        switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
      } as unknown as ArgumentsHost;
      filtro.catch(new BadRequestException('x'), host);
      expect(res.cuerpo.idPeticion).toBe('cliente-abc-12345');
      expect(res.cabeceras['x-request-id']).toBe('cliente-abc-12345');
    });
  });
});

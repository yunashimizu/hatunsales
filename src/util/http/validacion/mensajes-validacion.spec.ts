import { BadRequestException } from '@nestjs/common';
import { IsEmail, IsInt, IsOptional, IsString, Matches, MaxLength, Min, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import {
  aplanarErroresValidacion,
  cuerpoErrorValidacion,
  etiquetaCampo,
  traducirMensajeSuelto,
  traducirMensajeValidacion,
} from './mensajes-validacion';
import { crearValidationPipe } from './validation-pipe.factory';

class LineaDto {
  @IsInt()
  @Min(1)
  cantidad!: number;
}

class VentaDto {
  @IsString()
  @MaxLength(5)
  nombre!: string;

  @IsEmail()
  email!: string;

  @IsOptional()
  @Matches(/^9\d{8}$/, { message: 'Celular inválido' })
  telefono?: string;

  @ValidateNested({ each: true })
  @Type(() => LineaDto)
  items!: LineaDto[];
}

describe('mensajes de validación en español', () => {
  it('traduce los mensajes por defecto de class-validator', () => {
    expect(traducirMensajeValidacion('nombre should not be empty', 'nombre', 'nombre')).toBe('El campo «nombre» es obligatorio.');
    expect(traducirMensajeValidacion('precio must not be less than 0.5', 'precio', 'precio')).toBe(
      'El campo «precio» no puede ser menor que 0.5.',
    );
    expect(traducirMensajeValidacion('dias must not be greater than 365', 'dias', 'dias')).toBe(
      'El campo «dias» no puede ser mayor que 365.',
    );
    expect(traducirMensajeValidacion('ruc must be longer than or equal to 11 characters', 'ruc', 'ruc')).toBe(
      'El campo «ruc» debe tener al menos 11 caracteres.',
    );
    expect(traducirMensajeValidacion('motivo must be one of the following values: a, b', 'motivo', 'motivo')).toBe(
      'El campo «motivo» debe ser uno de estos valores: a, b.',
    );
    expect(traducirMensajeValidacion('each value in ids must be an integer number', 'ids', 'ids')).toBe(
      'Cada valor de «ids» debe ser un número entero.',
    );
    expect(traducirMensajeValidacion('nested property items must be either object or array', 'items', 'items')).toBe(
      'El campo «items» debe ser un objeto o una lista.',
    );
    expect(traducirMensajeValidacion('fecha must be a valid ISO 8601 date string', 'fecha', 'fecha')).toBe(
      'El campo «fecha» debe ser una fecha válida (AAAA-MM-DD).',
    );
  });

  it('deja intactos los mensajes personalizados y usa un genérico para defaults desconocidos', () => {
    expect(traducirMensajeValidacion('Celular inválido', 'telefono', 'telefono')).toBe('Celular inválido');
    expect(traducirMensajeValidacion('codigo must be a Firebase Push Id', 'codigo', 'codigo')).toBe('El campo «codigo» no es válido.');
  });

  it('etiqueta los campos anidados con la fila (base 1)', () => {
    expect(etiquetaCampo('items.0.cantidad')).toBe('«cantidad» (fila 1 de «items»)');
    expect(etiquetaCampo('items.2')).toBe('«items» (fila 3)');
    expect(etiquetaCampo('id_producto')).toBe('«id producto»');
    expect(etiquetaCampo('cliente.nombre')).toBe('«cliente.nombre»');
  });

  it('traduce mensajes ya aplanados (ValidationPipe por defecto)', () => {
    expect(traducirMensajeSuelto('items.1.cantidad must not be less than 1')).toBe(
      'El campo «cantidad» (fila 2 de «items») no puede ser menor que 1.',
    );
    expect(traducirMensajeSuelto('La cantidad debe ser entera')).toBe('La cantidad debe ser entera');
  });

  it('aplana errores anidados con su ruta', () => {
    const planos = aplanarErroresValidacion([
      {
        property: 'items',
        children: [{ property: '0', children: [{ property: 'cantidad', constraints: { min: 'cantidad must not be less than 1' } }] }],
      },
    ]);
    expect(planos).toEqual([{ ruta: 'items.0.cantidad', mensajes: ['El campo «cantidad» (fila 1 de «items») no puede ser menor que 1.'] }]);
  });

  it('cuerpoErrorValidacion: arreglo, código y campos', () => {
    const cuerpo = cuerpoErrorValidacion([{ property: 'email', constraints: { isEmail: 'email must be an email' } }]);
    expect(cuerpo).toEqual({
      statusCode: 400,
      message: ['El campo «email» debe ser un correo electrónico válido.'],
      error: 'Solicitud inválida',
      codigo: 'VALIDACION',
      campos: ['email'],
    });
    expect(cuerpoErrorValidacion([]).message).toEqual(['Los datos enviados no son válidos.']);
  });
});

describe('crearValidationPipe', () => {
  const pipe = crearValidationPipe();
  const metadata = { type: 'body' as const, metatype: VentaDto, data: '' };

  it('responde 400 en español, un mensaje por campo y con campos', async () => {
    const error = await pipe
      .transform({ nombre: 'demasiado largo', email: 'no-es-correo', telefono: '123', items: [{ cantidad: 0 }] }, metadata)
      .then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(BadRequestException);
    const cuerpo = (error as BadRequestException).getResponse() as Record<string, any>;
    expect(cuerpo.codigo).toBe('VALIDACION');
    expect(cuerpo.message).toEqual(
      expect.arrayContaining([
        'El campo «nombre» debe tener como máximo 5 caracteres.',
        'El campo «email» debe ser un correo electrónico válido.',
        'Celular inválido',
        'El campo «cantidad» (fila 1 de «items») no puede ser menor que 1.',
      ]),
    );
    expect(cuerpo.campos).toEqual(expect.arrayContaining(['nombre', 'email', 'telefono', 'items.0.cantidad']));
  });

  it('whitelist: descarta los campos no declarados sin responder 400 (el front envía campos extra)', async () => {
    const valor = await pipe.transform({ nombre: 'ok', email: 'a@b.pe', items: [], extra: 'x' }, metadata);
    expect(valor).toBeInstanceOf(VentaDto);
    expect((valor as Record<string, unknown>).extra).toBeUndefined();
  });
});

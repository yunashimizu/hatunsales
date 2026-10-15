import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import {
  AMBIENTES_FISCALES,
  CORRELATIVO_MAXIMO,
  MODOS_BOLETAS,
  MODOS_REGLAS_2027,
  PROVEEDORES_FISCALES,
} from './fiscal-config.tipos';
import type { AmbienteFiscal, ModoBoletas, ModoReglas2027, ProveedorFiscal } from './fiscal-config.tipos';

/**
 * DTOs del API /fiscal/* (class-validator). El ValidationPipe global usa
 * `whitelist: true` y `transform: true`: lo que no está aquí se descarta.
 * Los mensajes van en español, listos para mostrar en el panel.
 */

type Transformacion = { value: unknown };

const recortar = ({ value }: Transformacion) => (typeof value === 'string' ? value.trim() : value);
const mayusculas = ({ value }: Transformacion) => (typeof value === 'string' ? value.trim().toUpperCase() : value);
const minusculas = ({ value }: Transformacion) => (typeof value === 'string' ? value.trim().toLowerCase() : value);

/** Acepta true/false reales y también 'true'/'false'/'1'/'0' (multipart y query llegan como texto). */
export const aBooleano = ({ value }: Transformacion) => {
  if (value === true || value === 'true' || value === '1' || value === 1) return true;
  if (value === false || value === 'false' || value === '0' || value === 0) return false;
  return value;
};

const textoDeOpcion = ({ value }: Transformacion) => (typeof value === 'boolean' ? String(value) : minusculas({ value }));

const SERIE_F = /^F[A-Z0-9]{3}$/;
const SERIE_B = /^B[A-Z0-9]{3}$/;
const SERIE_T = /^T[A-Z0-9]{3}$/;

export class SeriesFiscalesDto {
  @IsOptional()
  @Transform(mayusculas)
  @Matches(SERIE_F, { message: 'La serie de factura debe tener 4 caracteres y empezar con F (ej. F001).' })
  factura?: string;

  @IsOptional()
  @Transform(mayusculas)
  @Matches(SERIE_B, { message: 'La serie de boleta debe tener 4 caracteres y empezar con B (ej. B001).' })
  boleta?: string;

  @IsOptional()
  @Transform(mayusculas)
  @Matches(SERIE_F, { message: 'La serie de nota de crédito de factura debe empezar con F (ej. FC01).' })
  nc_factura?: string;

  @IsOptional()
  @Transform(mayusculas)
  @Matches(SERIE_B, { message: 'La serie de nota de crédito de boleta debe empezar con B (ej. BC01).' })
  nc_boleta?: string;

  @IsOptional()
  @Transform(mayusculas)
  @Matches(SERIE_F, { message: 'La serie de nota de débito de factura debe empezar con F (ej. FD01).' })
  nd_factura?: string;

  @IsOptional()
  @Transform(mayusculas)
  @Matches(SERIE_B, { message: 'La serie de nota de débito de boleta debe empezar con B (ej. BD01).' })
  nd_boleta?: string;

  @IsOptional()
  @Transform(mayusculas)
  @Matches(SERIE_T, { message: 'La serie de guía de remisión remitente debe tener 4 caracteres y empezar con T (ej. T001).' })
  gre_remitente?: string;
}

export class EmisorFiscalDto {
  @IsOptional()
  @Transform(recortar)
  @IsString()
  @Length(1, 200, { message: 'La razón social debe tener entre 1 y 200 caracteres.' })
  razon_social?: string;

  @IsOptional()
  @Transform(recortar)
  @IsString()
  @Length(0, 200, { message: 'El nombre comercial admite hasta 200 caracteres.' })
  nombre_comercial?: string;

  @IsOptional()
  @Transform(recortar)
  @IsString()
  @Length(1, 200, { message: 'La dirección debe tener entre 1 y 200 caracteres.' })
  direccion?: string;

  @IsOptional()
  @Transform(recortar)
  @Matches(/^\d{6}$/, { message: 'El ubigeo debe tener 6 dígitos (Lurín, Lima = 150119).' })
  ubigeo?: string;

  @IsOptional()
  @Transform(recortar)
  @IsString()
  @Length(1, 60, { message: 'El distrito debe tener entre 1 y 60 caracteres.' })
  distrito?: string;

  @IsOptional()
  @Transform(recortar)
  @IsString()
  @Length(1, 60, { message: 'La provincia debe tener entre 1 y 60 caracteres.' })
  provincia?: string;

  @IsOptional()
  @Transform(recortar)
  @IsString()
  @Length(1, 60, { message: 'El departamento debe tener entre 1 y 60 caracteres.' })
  departamento?: string;

  @IsOptional()
  @Transform(recortar)
  @Matches(/^\d{4}$/, { message: 'El código de establecimiento debe tener 4 dígitos (0000 = domicilio fiscal).' })
  codigo_establecimiento?: string;
}

export class CredencialesSolDto {
  /** 8 caracteres; si lo escriben con el RUC delante (19), el servicio lo quita. */
  @Transform(mayusculas)
  @IsString({ message: 'Ingrese el usuario secundario SOL.' })
  @Matches(/^(\d{11})?[A-Z0-9]{8}$/, {
    message: 'El usuario secundario SOL debe tener 8 caracteres (letras y números), sin el RUC.',
  })
  usuario!: string;

  /** Solo escritura: nunca se devuelve. */
  @IsOptional()
  @IsString()
  @Length(8, 12, { message: 'La clave SOL debe tener entre 8 y 12 caracteres.' })
  clave?: string;
}

export class PuntoPartidaGreDto {
  /** Vacío = volver a usar el del emisor. */
  @IsOptional()
  @Transform(recortar)
  @Matches(/^(\d{6})?$/, { message: 'El ubigeo del punto de partida debe tener 6 dígitos.' })
  ubigeo?: string;

  /** Vacío = volver a usar la del emisor. */
  @IsOptional()
  @Transform(recortar)
  @IsString()
  @MaxLength(200, { message: 'La dirección del punto de partida admite hasta 200 caracteres.' })
  direccion?: string;

  /** Vacío = volver a usar el del emisor. */
  @IsOptional()
  @Transform(recortar)
  @Matches(/^(\d{4})?$/, { message: 'El código de establecimiento del punto de partida debe tener 4 dígitos.' })
  codigo_establecimiento?: string;
}

export class ConfigGreDto {
  /** Enviar las GRE remitente a SUNAT (requiere producción, checklist GRE completo y la confirmación de no OSE). */
  @IsOptional()
  @Transform(aBooleano)
  @IsBoolean({ message: 'gre.activa debe ser verdadero o falso.' })
  activa?: boolean;

  /** Primer número de la serie si todavía no hay guías del sistema (continuar una numeración previa). */
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'El correlativo inicial de la GRE debe ser un número entero.' })
  @Min(1, { message: 'El correlativo inicial de la GRE debe ser al menos 1.' })
  @Max(CORRELATIVO_MAXIMO, { message: 'El correlativo inicial de la GRE admite hasta 8 dígitos.' })
  correlativo_inicial?: number;

  @IsOptional()
  @ValidateNested()
  @Type(() => PuntoPartidaGreDto)
  partida?: PuntoPartidaGreDto;
}

export class ActualizarConfigFiscalDto {
  @IsOptional()
  @Transform(minusculas)
  @IsIn([...PROVEEDORES_FISCALES], { message: 'El proveedor debe ser nubefact o sunat_directo.' })
  proveedor?: ProveedorFiscal;

  @IsOptional()
  @Transform(minusculas)
  @IsIn([...AMBIENTES_FISCALES], { message: 'El ambiente debe ser beta o produccion.' })
  ambiente?: AmbienteFiscal;

  @IsOptional()
  @Transform(minusculas)
  @IsIn([...MODOS_BOLETAS], { message: 'El modo de boletas debe ser individual o resumen.' })
  boletas_modo?: ModoBoletas;

  @IsOptional()
  @Transform(aBooleano)
  @IsBoolean({ message: 'envio_en_linea debe ser verdadero o falso.' })
  envio_en_linea?: boolean;

  @IsOptional()
  @Transform(aBooleano)
  @IsBoolean({ message: 'tareas_activas debe ser verdadero o falso.' })
  tareas_activas?: boolean;

  @IsOptional()
  @Transform(textoDeOpcion)
  @IsIn([...MODOS_REGLAS_2027], { message: 'aplicar_reglas_2027 debe ser auto, true o false.' })
  aplicar_reglas_2027?: ModoReglas2027;

  @IsOptional()
  @ValidateNested()
  @Type(() => SeriesFiscalesDto)
  series?: SeriesFiscalesDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => EmisorFiscalDto)
  emisor?: EmisorFiscalDto;

  /** 8 dígitos (UNSPSC, catálogo 25) o vacío para quitarlo. */
  @IsOptional()
  @Transform(recortar)
  @Matches(/^(\d{8})?$/, { message: 'El código de producto SUNAT debe tener 8 dígitos (o quedar vacío).' })
  codigo_producto_defecto?: string | null;

  @IsOptional()
  @ValidateNested()
  @Type(() => CredencialesSolDto)
  sol?: CredencialesSolDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => ConfigGreDto)
  gre?: ConfigGreDto;

  /** true = confirma que no hay OSE registrado ni es PRICO/agente; false = retira la confirmación. */
  @IsOptional()
  @Transform(aBooleano)
  @IsBoolean({ message: 'confirmo_no_ose debe ser verdadero o falso.' })
  confirmo_no_ose?: boolean;
}

/** Campos de texto del multipart de POST /fiscal/certificado (el archivo va en el campo «archivo»). */
export class SubirCertificadoDto {
  /** Contraseña del .pfx (puede ser vacía si el archivo no tiene). Nunca se devuelve ni se registra. */
  @IsString({ message: 'Ingrese la contraseña del certificado en el campo «clave».' })
  @MaxLength(128, { message: 'La contraseña del certificado admite hasta 128 caracteres.' })
  clave!: string;

  /** Por omisión: produccion si es un certificado real; beta si es autofirmado. */
  @IsOptional()
  @Transform(minusculas)
  @IsIn([...AMBIENTES_FISCALES], { message: 'El ambiente debe ser beta o produccion.' })
  ambiente?: AmbienteFiscal;

  /** Solo en beta: aceptar aunque el RUC del certificado no coincida. */
  @IsOptional()
  @Transform(aBooleano)
  @IsBoolean({ message: 'forzar debe ser verdadero o falso.' })
  forzar?: boolean;
}

export class CredencialesGreDto {
  @Transform(recortar)
  @IsString({ message: 'Ingrese el client_id de las credenciales API de SUNAT.' })
  @Matches(/^[A-Za-z0-9-]{8,100}$/, {
    message: 'El client_id tiene solo letras, números y guiones (ej. 1a2b3c4d-5e6f-…), tal como lo muestra SOL.',
  })
  client_id!: string;

  /** Solo escritura: nunca se devuelve. */
  @IsString({ message: 'Ingrese el client_secret de las credenciales API de SUNAT.' })
  @Length(8, 200, { message: 'El client_secret debe tener entre 8 y 200 caracteres.' })
  @Matches(/^\S+$/, { message: 'El client_secret no debe tener espacios.' })
  client_secret!: string;
}

export class AmbienteConsultaDto {
  @IsOptional()
  @Transform(minusculas)
  @IsIn([...AMBIENTES_FISCALES], { message: 'El ambiente debe ser beta o produccion.' })
  ambiente?: AmbienteFiscal;
}

/** Para operaciones destructivas (DELETE): el ambiente es obligatorio. */
export class AmbienteRequeridoDto {
  @Transform(minusculas)
  @IsIn([...AMBIENTES_FISCALES], { message: 'Indique ambiente=beta o ambiente=produccion.' })
  ambiente!: AmbienteFiscal;
}

export const FORMATOS_CERTIFICADO_PUBLICO = ['cer', 'der', 'pem'] as const;
export type FormatoDescargaCertificado = (typeof FORMATOS_CERTIFICADO_PUBLICO)[number];

export class CertificadoPublicoConsultaDto extends AmbienteConsultaDto {
  /** cer / der: binario DER (.cer); pem: texto Base64 (.cer). */
  @IsOptional()
  @Transform(minusculas)
  @IsIn([...FORMATOS_CERTIFICADO_PUBLICO], { message: 'El formato debe ser cer, der o pem.' })
  formato?: FormatoDescargaCertificado;
}

export class AuditoriaConsultaDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'limite debe ser un número entero.' })
  @Min(1, { message: 'limite debe ser al menos 1.' })
  @Max(200, { message: 'limite admite hasta 200.' })
  limite?: number;

  /** Paginación: trae los registros con id menor a este. */
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'antes_de debe ser un número entero.' })
  @Min(1, { message: 'antes_de debe ser al menos 1.' })
  antes_de?: number;
}

export const DOCUMENTOS_PRUEBA = ['cpe', 'gre'] as const;
export type DocumentoPrueba = (typeof DOCUMENTOS_PRUEBA)[number];

export class ProbarConexionDto {
  @IsOptional()
  @IsIn(['01', '03'], { message: 'tipo_cpe debe ser 01 (factura) o 03 (boleta).' })
  tipo_cpe?: '01' | '03';

  @IsOptional()
  @Transform(minusculas)
  @IsIn([...AMBIENTES_FISCALES], { message: 'El ambiente debe ser beta o produccion.' })
  ambiente?: AmbienteFiscal;

  /** cpe = factura/boleta/notas (por omisión); gre = guía de remisión remitente. */
  @IsOptional()
  @Transform(minusculas)
  @IsIn([...DOCUMENTOS_PRUEBA], { message: 'documento debe ser cpe o gre.' })
  documento?: DocumentoPrueba;
}

export class GenerarAutofirmadoDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'dias debe ser un número entero.' })
  @Min(30, { message: 'El certificado de prueba debe durar al menos 30 días.' })
  @Max(1825, { message: 'El certificado de prueba puede durar hasta 1825 días.' })
  dias?: number;
}

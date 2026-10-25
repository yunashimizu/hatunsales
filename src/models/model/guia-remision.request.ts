import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { UNIDADES_CATALOGO_03 } from '../../sunat/catalogos/sunat.catalogos';

/**
 * Cuerpos y filtros de /guia-remision (GRE remitente). Los catálogos son los de SUNAT: motivo (cat. 20,
 * solo 01, 04 y 13 habilitados), modalidad (cat. 18: 01 transporte público, 02 transporte privado),
 * documento de identidad (cat. 06) y unidad (cat. 03). Un borrador puede guardarse incompleto: los
 * campos de cada bloque son opcionales y lo que falta para emitir lo señala POST /guia-remision/:id/validar
 * (reglas del motor GRE, que dependen de varios campos a la vez).
 */

const FECHA = /^\d{4}-\d{2}-\d{2}$/;
const MENSAJE_FECHA = 'debe ser una fecha con formato aaaa-mm-dd';

/** Recorta los textos del formulario; vacío equivale a «no indicado» (un select sin elegir no da 400). */
const recortar = () =>
  Transform(({ value }) => {
    if (typeof value !== 'string') return value;
    const limpio = value.trim();
    return limpio === '' ? undefined : limpio;
  });

/** Como `recortar`, en mayúsculas (unidades, placas, licencias). */
const recortarMayusculas = () =>
  Transform(({ value }) => {
    if (typeof value !== 'string') return value;
    const limpio = value.trim().toUpperCase();
    return limpio === '' ? undefined : limpio;
  });

export const MOTIVOS_GUIA_HABILITADOS = ['01', '04', '13'] as const;
export const MODALIDADES_GUIA = ['01', '02'] as const;
export const UNIDADES_PESO_GUIA = ['KGM', 'TNE'] as const;
/** Catálogo 06 para el destinatario (el '0' sin documento no sirve en una guía). */
export const TIPOS_DOCUMENTO_GUIA = ['1', '4', '6', '7'] as const;
/** Catálogo 06 para el conductor: persona natural. */
export const TIPOS_DOCUMENTO_CONDUCTOR = ['1', '4', '7'] as const;
export const ESTADOS_GUIA = ['legacy', 'borrador', 'pendiente', 'enviado', 'aceptado', 'rechazado', 'anulado'] as const;
export type EstadoGuia = (typeof ESTADOS_GUIA)[number];

const CODIGOS_UNIDAD = Object.keys(UNIDADES_CATALOGO_03);

export class PuntoGuiaRequest {
  @IsOptional()
  @recortar()
  @Matches(/^\d{6}$/, { message: 'El ubigeo debe tener 6 dígitos (código INEI del distrito, p. ej. 150119 Lurín).' })
  ubigeo?: string;

  @IsOptional()
  @recortar()
  @IsString({ message: 'La dirección debe ser un texto.' })
  @MaxLength(500, { message: 'La dirección admite hasta 500 caracteres.' })
  direccion?: string;

  /** Solo con el motivo 04: código de establecimiento anexo registrado en SUNAT (0000 = domicilio fiscal). */
  @IsOptional()
  @recortar()
  @Matches(/^\d{4}$/, { message: 'El código de establecimiento tiene 4 dígitos (0000 = domicilio fiscal).' })
  codigo_establecimiento?: string;
}

export class DestinatarioGuiaRequest {
  @IsOptional()
  @recortar()
  @IsIn(TIPOS_DOCUMENTO_GUIA, { message: 'Tipo de documento del destinatario: use 1 (DNI), 4 (carné de extranjería), 6 (RUC) o 7 (pasaporte).' })
  tipo_documento?: string;

  @IsOptional()
  @recortar()
  @IsString({ message: 'El documento del destinatario debe ser un texto.' })
  @MaxLength(15, { message: 'El documento del destinatario admite hasta 15 caracteres.' })
  numero_documento?: string;

  @IsOptional()
  @recortar()
  @IsString({ message: 'El nombre del destinatario debe ser un texto.' })
  @MaxLength(250, { message: 'El nombre o razón social del destinatario admite hasta 250 caracteres.' })
  denominacion?: string;

  @IsOptional()
  @recortar()
  @IsString({ message: 'La dirección del destinatario debe ser un texto.' })
  @MaxLength(500, { message: 'La dirección del destinatario admite hasta 500 caracteres.' })
  direccion?: string;
}

export class TransportistaGuiaRequest {
  @IsOptional()
  @recortar()
  @Matches(/^\d{11}$/, { message: 'El RUC del transportista tiene 11 dígitos.' })
  ruc?: string;

  @IsOptional()
  @recortar()
  @IsString({ message: 'La razón social del transportista debe ser un texto.' })
  @MaxLength(250, { message: 'La razón social del transportista admite hasta 250 caracteres.' })
  razon_social?: string;

  @IsOptional()
  @recortarMayusculas()
  @IsString({ message: 'El registro MTC debe ser un texto.' })
  @MaxLength(20, { message: 'El registro MTC admite hasta 20 caracteres.' })
  registro_mtc?: string;
}

export class VehiculoGuiaRequest {
  /** Se guarda en mayúsculas y sin guiones ni espacios (ABC-123 → ABC123). */
  @IsOptional()
  @recortarMayusculas()
  @IsString({ message: 'La placa debe ser un texto.' })
  @MaxLength(12, { message: 'La placa admite hasta 8 letras o dígitos (sin guiones).' })
  placa?: string;

  @IsOptional()
  @recortarMayusculas()
  @IsString({ message: 'La tarjeta única de circulación debe ser un texto.' })
  @MaxLength(15, { message: 'La tarjeta única de circulación admite hasta 15 caracteres.' })
  tarjeta_circulacion?: string;

  @IsOptional()
  @recortar()
  @IsString({ message: 'La marca del vehículo debe ser un texto.' })
  @MaxLength(120, { message: 'La marca del vehículo admite hasta 120 caracteres.' })
  marca?: string;
}

export class ConductorGuiaRequest {
  @IsOptional()
  @recortar()
  @IsIn(TIPOS_DOCUMENTO_CONDUCTOR, { message: 'Tipo de documento del conductor: use 1 (DNI), 4 (carné de extranjería) o 7 (pasaporte).' })
  tipo_documento?: string;

  @IsOptional()
  @recortar()
  @IsString({ message: 'El documento del conductor debe ser un texto.' })
  @MaxLength(15, { message: 'El documento del conductor admite hasta 15 caracteres.' })
  numero_documento?: string;

  @IsOptional()
  @recortar()
  @IsString({ message: 'Los nombres del conductor deben ser un texto.' })
  @MaxLength(250, { message: 'Los nombres del conductor admiten hasta 250 caracteres.' })
  nombres?: string;

  @IsOptional()
  @recortar()
  @IsString({ message: 'Los apellidos del conductor deben ser un texto.' })
  @MaxLength(250, { message: 'Los apellidos del conductor admiten hasta 250 caracteres.' })
  apellidos?: string;

  @IsOptional()
  @recortarMayusculas()
  @IsString({ message: 'La licencia de conducir debe ser un texto.' })
  @MaxLength(10, { message: 'La licencia de conducir admite hasta 10 caracteres.' })
  licencia?: string;
}

export class ItemGuiaRequest {
  /** Con venta: un producto de la venta. Sin venta (motivos 04 y 13): cualquier producto del catálogo. */
  @Type(() => Number)
  @IsInt({ message: 'id_producto debe ser un número entero.' })
  @Min(1, { message: 'id_producto debe ser un número entero mayor que 0.' })
  id_producto!: number;

  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 3 }, { message: 'La cantidad debe ser un número con hasta 3 decimales.' })
  @IsPositive({ message: 'La cantidad debe ser mayor que 0.' })
  @Max(999_999_999, { message: 'La cantidad admite hasta 999999999.' })
  cantidad!: number;

  /** Por omisión, el nombre del producto. Se puede completar (marca, número de serie…). */
  @IsOptional()
  @recortar()
  @IsString({ message: 'La descripción del bien debe ser un texto.' })
  @MaxLength(500, { message: 'La descripción de un bien admite hasta 500 caracteres.' })
  descripcion?: string;

  /** Catálogo 03 (NIU, KGM, MTR, BX…); por omisión, la unidad del producto. */
  @IsOptional()
  @recortarMayusculas()
  @IsIn(CODIGOS_UNIDAD, { message: 'La unidad del bien debe ser un código del catálogo 03 de SUNAT (p. ej. NIU unidad, KGM kilogramo, MTR metro, BX caja).' })
  unidad?: string;
}

/**
 * POST /guia-remision (borrador) y PUT /guia-remision/:id (borrador o rechazada). Al editar, la venta
 * no cambia: si llega otra, se rechaza (se crea otra guía).
 */
export class GuardarGuiaRemisionRequest {
  /** Venta que sustenta el traslado: obligatoria con el motivo 01; sin venta solo se admiten 04 y 13. */
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'id_venta debe ser un número entero.' })
  @Min(1, { message: 'id_venta debe ser un número entero mayor que 0.' })
  id_venta?: number;

  @recortar()
  @IsIn(MOTIVOS_GUIA_HABILITADOS, {
    message: 'Motivo de traslado no habilitado: use 01 (venta), 04 (traslado entre establecimientos de la misma empresa) o 13 (otros).',
  })
  motivo_traslado!: string;

  /** Obligatoria con el motivo 13 (otros). */
  @IsOptional()
  @recortar()
  @IsString({ message: 'La descripción del motivo debe ser un texto.' })
  @MaxLength(100, { message: 'La descripción del motivo admite hasta 100 caracteres.' })
  descripcion_motivo?: string;

  @recortar()
  @IsIn(MODALIDADES_GUIA, { message: 'Modalidad de traslado: use 01 (transporte público) o 02 (transporte privado).' })
  modalidad_traslado!: string;

  @IsOptional()
  @recortar()
  @Matches(FECHA, { message: `fecha_inicio_traslado ${MENSAJE_FECHA}.` })
  fecha_inicio_traslado?: string;

  /** Solo transporte público: día en que se entregan los bienes al transportista. */
  @IsOptional()
  @recortar()
  @Matches(FECHA, { message: `fecha_entrega_transportista ${MENSAJE_FECHA}.` })
  fecha_entrega_transportista?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 3 }, { message: 'El peso bruto total debe ser un número con hasta 3 decimales.' })
  @Min(0, { message: 'El peso bruto total no puede ser negativo.' })
  @Max(999_999_999, { message: 'El peso bruto total admite hasta 999999999.' })
  peso_bruto_total?: number;

  @IsOptional()
  @recortarMayusculas()
  @IsIn(UNIDADES_PESO_GUIA, { message: 'Unidad del peso: use KGM (kilogramos) o TNE (toneladas).' })
  unidad_peso?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'El número de bultos debe ser un entero.' })
  @Min(1, { message: 'El número de bultos debe ser al menos 1 (o déjelo vacío).' })
  @Max(999_999, { message: 'El número de bultos admite hasta 999999.' })
  numero_bultos?: number;

  /** Con venta, por omisión el cliente de la venta; con el motivo 04 siempre es el propio emisor. */
  @IsOptional()
  @ValidateNested()
  @Type(() => DestinatarioGuiaRequest)
  destinatario?: DestinatarioGuiaRequest;

  @IsOptional()
  @ValidateNested()
  @Type(() => PuntoGuiaRequest)
  partida?: PuntoGuiaRequest;

  @IsOptional()
  @ValidateNested()
  @Type(() => PuntoGuiaRequest)
  llegada?: PuntoGuiaRequest;

  /** Modalidad 01 (transporte público). */
  @IsOptional()
  @ValidateNested()
  @Type(() => TransportistaGuiaRequest)
  transportista?: TransportistaGuiaRequest;

  /** Modalidad 02 (transporte privado). */
  @IsOptional()
  @ValidateNested()
  @Type(() => VehiculoGuiaRequest)
  vehiculo?: VehiculoGuiaRequest;

  /** Modalidad 02 (transporte privado): conductor principal. */
  @IsOptional()
  @ValidateNested()
  @Type(() => ConductorGuiaRequest)
  conductor?: ConductorGuiaRequest;

  @IsArray({ message: 'Indique los bienes a trasladar (items).' })
  @ArrayMinSize(1, { message: 'Agregue al menos un bien a trasladar.' })
  @ArrayMaxSize(500, { message: 'Una guía admite hasta 500 líneas en este sistema.' })
  @ValidateNested({ each: true })
  @Type(() => ItemGuiaRequest)
  items!: ItemGuiaRequest[];

  @IsOptional()
  @recortar()
  @IsString({ message: 'Las observaciones deben ser un texto.' })
  @MaxLength(250, { message: 'Las observaciones admiten hasta 250 caracteres.' })
  observaciones?: string;

  /** Repetir el POST con la misma clave devuelve la guía ya creada (doble clic, reintento de red). */
  @IsOptional()
  @recortar()
  @IsString({ message: 'clave_idempotencia debe ser un texto.' })
  @MaxLength(100, { message: 'clave_idempotencia admite hasta 100 caracteres.' })
  clave_idempotencia?: string;
}

export class ListarGuiasRemisionRequest {
  /** Serie-número, destinatario (nombre o documento), comprobante relacionado o número de venta. */
  @IsOptional()
  @recortar()
  @IsString({ message: 'texto debe ser un texto.' })
  @MaxLength(80, { message: 'La búsqueda admite hasta 80 caracteres.' })
  texto?: string;

  @IsOptional()
  @recortar()
  @IsIn(ESTADOS_GUIA, { message: `estado: use ${ESTADOS_GUIA.join(', ')}.` })
  estado?: string;

  /** Fecha de emisión desde (aaaa-mm-dd, Lima); los borradores cuentan por su fecha de creación. */
  @IsOptional()
  @recortar()
  @Matches(FECHA, { message: `desde ${MENSAJE_FECHA}.` })
  desde?: string;

  @IsOptional()
  @recortar()
  @Matches(FECHA, { message: `hasta ${MENSAJE_FECHA}.` })
  hasta?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'id_venta debe ser un número entero.' })
  @Min(1, { message: 'id_venta debe ser un número entero mayor que 0.' })
  id_venta?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'pagina debe ser un número entero.' })
  @Min(1, { message: 'pagina debe ser 1 o más.' })
  pagina?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'por_pagina debe ser un número entero.' })
  @Min(1, { message: 'por_pagina debe ser 1 o más.' })
  @Max(100, { message: 'por_pagina admite hasta 100.' })
  por_pagina?: number;
}

export class AnularGuiaRemisionRequest {
  @IsOptional()
  @recortar()
  @IsString({ message: 'El motivo de la anulación debe ser un texto.' })
  @MaxLength(250, { message: 'El motivo de la anulación admite hasta 250 caracteres.' })
  motivo?: string;
}

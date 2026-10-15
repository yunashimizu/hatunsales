/**
 * Traducción de códigos SQLSTATE de PostgreSQL a respuestas HTTP en español.
 * https://www.postgresql.org/docs/current/errcodes-appendix.html
 *
 * Nunca se devuelve al cliente el `detail` de PostgreSQL: trae los valores de
 * la fila (DNI, correos, montos). De él solo se extraen nombres de columnas.
 */

export interface InfoErrorPg {
  /** SQLSTATE de 5 caracteres. */
  readonly codigo: string;
  readonly mensaje: string;
  readonly detalle?: string;
  readonly tabla?: string;
  readonly columna?: string;
  readonly restriccion?: string;
  /** Primera palabra de la sentencia (INSERT, UPDATE, DELETE, SELECT…). */
  readonly sentencia?: string;
}

export interface ReglaPg {
  readonly estado: number;
  readonly codigo: string;
  readonly mensaje: string;
  readonly extra?: Readonly<Record<string, unknown>>;
  readonly reintentarEnSeg?: number;
}

const IDENTIFICADOR = /^[a-z_][a-z0-9_]*$/i;

/** `Key (lower(email::text))=(…)` → ['email']; `Key (id_producto, id_almacen)=(…)` → ambos. */
export function columnasDeDetalle(detalle: string | undefined): string[] {
  const m = /^Key \((.+?)\)=\(/.exec(String(detalle ?? ''));
  if (!m) return [];
  const columnas = m[1].split(',').map((parte) => {
    let texto = parte.trim().replace(/::[a-z ]+/gi, '');
    let funcion = /^[a-z_]+\((.*)\)$/i.exec(texto);
    while (funcion) {
      texto = funcion[1].trim();
      funcion = /^[a-z_]+\((.*)\)$/i.exec(texto);
    }
    return texto.replace(/^"|"$/g, '');
  });
  return Array.from(new Set(columnas.filter((c) => IDENTIFICADOR.test(c))));
}

const campo = (nombre: string): string => `«${nombre.replace(/_/g, ' ')}»`;

const ESQUEMA_PENDIENTE: ReglaPg = {
  estado: 503,
  codigo: 'ESQUEMA_PENDIENTE',
  mensaje:
    'La base de datos no tiene la estructura que necesita esta función: falta ejecutar un script SQL pendiente '
    + '(carpeta sql/) en Railway. Avise a sistemas.',
  reintentarEnSeg: 30,
};

const BD_NO_DISPONIBLE: ReglaPg = {
  estado: 503,
  codigo: 'BD_NO_DISPONIBLE',
  mensaje: 'La base de datos no está disponible en este momento. Intente de nuevo en unos segundos.',
  reintentarEnSeg: 5,
};

const TIEMPO_AGOTADO: ReglaPg = {
  estado: 503,
  codigo: 'TIEMPO_AGOTADO',
  mensaje:
    'La operación tardó demasiado y se canceló; no se guardó ningún cambio. '
    + 'Intente de nuevo o reduzca el rango de la consulta.',
  reintentarEnSeg: 5,
};

const REINTENTAR: ReglaPg = {
  estado: 503,
  codigo: 'REINTENTAR',
  mensaje: 'Otra operación estaba modificando los mismos datos; no se guardó ningún cambio. Intente de nuevo.',
  reintentarEnSeg: 1,
};

const DATO_INVALIDO: ReglaPg = {
  estado: 400,
  codigo: 'DATO_INVALIDO',
  mensaje: 'Un dato no tiene el formato esperado (por ejemplo, un número, una fecha o un identificador mal escrito).',
};

function duplicado(info: InfoErrorPg): ReglaPg {
  const columnas = columnasDeDetalle(info.detalle);
  return {
    estado: 409,
    codigo: 'DUPLICADO',
    mensaje: columnas.length
      ? `Ya existe un registro con el mismo valor en ${columnas.map(campo).join(', ')}.`
      : 'Ya existe un registro con esos datos.',
    extra: columnas.length ? { campos: columnas } : undefined,
  };
}

type SentidoClaveForanea = 'en_uso' | 'inexistente' | 'desconocido';

/** Si el 23503 vino de borrar un registro con historial o de guardar una referencia que no existe. */
function sentidoClaveForanea(info: InfoErrorPg): SentidoClaveForanea {
  if (info.sentencia === 'DELETE') return 'en_uso';
  if (info.sentencia === 'INSERT') return 'inexistente';
  const mensaje = info.mensaje.toLowerCase();
  const detalle = String(info.detalle ?? '').toLowerCase();
  if (mensaje.startsWith('update or delete on table') || detalle.includes('is still referenced')) return 'en_uso';
  if (mensaje.startsWith('insert or update on table') || detalle.includes('is not present')) return 'inexistente';
  return 'desconocido';
}

function claveForanea(info: InfoErrorPg): ReglaPg {
  const sentido = sentidoClaveForanea(info);
  if (sentido === 'en_uso') {
    return {
      estado: 409,
      codigo: 'REGISTRO_EN_USO',
      mensaje:
        'No se puede eliminar o cambiar este registro porque otros datos dependen de él '
        + '(por ejemplo ventas, comprobantes o movimientos).',
    };
  }
  const columnas = columnasDeDetalle(info.detalle);
  return {
    estado: 409,
    codigo: 'REFERENCIA_INVALIDA',
    mensaje: sentido === 'inexistente'
      ? `Un registro relacionado no existe${columnas.length ? ` (${columnas.map(campo).join(', ')})` : ''}. `
        + 'Revise los datos seleccionados y vuelva a intentarlo.'
      : 'La operación rompe una relación entre registros (un dato relacionado no existe o está en uso).',
    extra: columnas.length ? { campos: columnas } : undefined,
  };
}

function noNulo(info: InfoErrorPg): ReglaPg {
  return {
    estado: 400,
    codigo: 'DATO_OBLIGATORIO',
    mensaje: info.columna ? `Falta un dato obligatorio: ${campo(info.columna)}.` : 'Falta un dato obligatorio.',
    extra: info.columna ? { campos: [info.columna] } : undefined,
  };
}

function reglaIncumplida(info: InfoErrorPg): ReglaPg {
  if (/stock/i.test(info.restriccion ?? '')) {
    return {
      estado: 409,
      codigo: 'INVENTARIO_STOCK_NEGATIVO',
      mensaje: 'No hay stock suficiente para completar la operación.',
    };
  }
  return {
    estado: 400,
    codigo: 'REGLA_INCUMPLIDA',
    mensaje: 'Los datos no cumplen una regla del sistema (por ejemplo, un monto o una cantidad fuera de lo permitido).',
  };
}

function textoLargo(info: InfoErrorPg): ReglaPg {
  const maximo = /character varying\((\d+)\)|character\((\d+)\)/i.exec(info.mensaje);
  const limite = maximo ? (maximo[1] ?? maximo[2]) : null;
  return {
    estado: 400,
    codigo: 'TEXTO_DEMASIADO_LARGO',
    mensaje: limite
      ? `Un texto supera el largo máximo permitido (${limite} caracteres).`
      : 'Un texto supera el largo máximo permitido.',
  };
}

function datoInvalido(info: InfoErrorPg): ReglaPg {
  if (/for enum/i.test(info.mensaje)) {
    return { ...DATO_INVALIDO, mensaje: 'Uno de los valores enviados no está permitido para ese campo.' };
  }
  return DATO_INVALIDO;
}

type Fabrica = (info: InfoErrorPg) => ReglaPg;
const fija = (regla: ReglaPg): Fabrica => () => regla;

const POR_CODIGO: Readonly<Record<string, Fabrica>> = {
  // Clase 23: integridad
  '23505': duplicado,
  '23503': claveForanea,
  '23502': noNulo,
  '23514': reglaIncumplida,
  '23P01': fija({ estado: 409, codigo: 'CONFLICTO', mensaje: 'El registro se cruza con otro ya existente.' }),
  '23001': fija({ estado: 409, codigo: 'REGISTRO_EN_USO', mensaje: 'No se puede eliminar: otros datos dependen de este registro.' }),
  // Clase 22: datos
  '22001': textoLargo,
  '22003': fija({ estado: 400, codigo: 'NUMERO_FUERA_DE_RANGO', mensaje: 'Un número supera el rango permitido.' }),
  '22P02': datoInvalido,
  '22007': fija({ estado: 400, codigo: 'FECHA_INVALIDA', mensaje: 'Una fecha u hora no es válida.' }),
  '22008': fija({ estado: 400, codigo: 'FECHA_INVALIDA', mensaje: 'Una fecha u hora está fuera de rango.' }),
  // Clase 40 y 55: concurrencia (la transacción se deshizo; reintentar es seguro)
  '40P01': fija(REINTENTAR),
  '40001': fija(REINTENTAR),
  '55P03': fija({ ...REINTENTAR, reintentarEnSeg: 2, mensaje: 'Los datos están ocupados por otra operación. Intente de nuevo en unos segundos.' }),
  '55006': fija({ ...REINTENTAR, reintentarEnSeg: 2 }),
  // Clase 57 y 25: cancelaciones y sesión
  '57014': fija(TIEMPO_AGOTADO),
  '25P03': fija(TIEMPO_AGOTADO),
  '57P05': fija(TIEMPO_AGOTADO),
  '57P01': fija(BD_NO_DISPONIBLE),
  '57P02': fija(BD_NO_DISPONIBLE),
  '57P03': fija(BD_NO_DISPONIBLE),
  '25006': fija(BD_NO_DISPONIBLE),
  // Clase 42: objetos que no existen → falta un script SQL
  '42P01': fija(ESQUEMA_PENDIENTE),
  '42703': fija(ESQUEMA_PENDIENTE),
  '42704': fija(ESQUEMA_PENDIENTE),
  '42883': fija(ESQUEMA_PENDIENTE),
};

const POR_CLASE: Readonly<Record<string, Fabrica>> = {
  '08': fija(BD_NO_DISPONIBLE),
  '53': fija(BD_NO_DISPONIBLE),
  '22': fija(DATO_INVALIDO),
  '23': fija({ estado: 409, codigo: 'CONFLICTO', mensaje: 'Los datos entran en conflicto con registros existentes.' }),
  '40': fija(REINTENTAR),
};

/** Regla para el SQLSTATE o null si es un defecto del programa (se responde 500). */
export function reglaParaErrorPg(info: InfoErrorPg): ReglaPg | null {
  const fabrica = POR_CODIGO[info.codigo] ?? POR_CLASE[info.codigo.slice(0, 2)];
  return fabrica ? fabrica(info) : null;
}

/** Clases de error que indican un problema operativo (no un dato mal enviado). */
export function esErrorPgOperativo(codigo: string): boolean {
  return ['08', '25', '40', '42', '53', '55', '57', '58', 'XX'].includes(String(codigo).slice(0, 2));
}

import { Injectable } from '@nestjs/common';
import { FilaUbigeo, UBIGEOS_INEI } from './ubigeo-inei';

/** Un distrito del catálogo INEI tal como lo usa la GRE y el formulario. */
export interface Ubigeo {
  codigo: string;
  departamento: string;
  provincia: string;
  distrito: string;
  /** «LURIN - LIMA - LIMA»: distrito, provincia y departamento, como SUNAT muestra el domicilio fiscal. */
  texto: string;
}

export const MINIMO_CARACTERES_BUSQUEDA_UBIGEO = 3;
export const MAXIMO_RESULTADOS_UBIGEO = 20;

const PATRON_UBIGEO = /^\d{6}$/;

/** Mayúsculas, sin tildes y sin signos: «Lurín» → «LURIN»; la Ñ pasa a N para que «pena» encuentre «PEÑA». */
export function normalizarTextoUbigeo(valor: unknown): string {
  return String(valor ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();
}

interface Entrada {
  ubigeo: Ubigeo;
  distrito: string;
  provincia: string;
  departamento: string;
  /** Distrito, provincia y departamento normalizados en una sola cadena (para buscar varias palabras). */
  todo: string;
}

function aUbigeo([codigo, departamento, provincia, distrito]: FilaUbigeo): Ubigeo {
  return { codigo, departamento, provincia, distrito, texto: `${distrito} - ${provincia} - ${departamento}` };
}

/**
 * Catálogo de ubigeos INEI en memoria (unos 1900 distritos, se arma una vez al arrancar). La búsqueda no
 * distingue tildes ni mayúsculas y acepta el nombre del distrito, de la provincia o el código (o su inicio).
 */
@Injectable()
export class UbigeoService {
  private readonly entradas: readonly Entrada[];
  private readonly porCodigo: ReadonlyMap<string, Ubigeo>;

  constructor(filas: readonly FilaUbigeo[] = UBIGEOS_INEI) {
    this.entradas = filas.map((fila) => {
      const ubigeo = aUbigeo(fila);
      const distrito = normalizarTextoUbigeo(ubigeo.distrito);
      const provincia = normalizarTextoUbigeo(ubigeo.provincia);
      const departamento = normalizarTextoUbigeo(ubigeo.departamento);
      return { ubigeo, distrito, provincia, departamento, todo: `${distrito} ${provincia} ${departamento}` };
    });
    this.porCodigo = new Map(this.entradas.map((e) => [e.ubigeo.codigo, e.ubigeo]));
  }

  get total(): number {
    return this.entradas.length;
  }

  obtener(codigo: string | null | undefined): Ubigeo | null {
    const limpio = String(codigo ?? '').trim();
    return PATRON_UBIGEO.test(limpio) ? (this.porCodigo.get(limpio) ?? null) : null;
  }

  existe(codigo: string | null | undefined): boolean {
    return this.obtener(codigo) !== null;
  }

  /** «150119 - LURIN - LIMA - LIMA», o el código solo si no está en el catálogo (para no esconder lo guardado). */
  textoLegible(codigo: string | null | undefined): string | null {
    const limpio = String(codigo ?? '').trim();
    if (!limpio) return null;
    const ubigeo = this.obtener(limpio);
    return ubigeo ? `${ubigeo.codigo} - ${ubigeo.texto}` : limpio;
  }

  /** Distrito exacto por sus nombres (p. ej. los que trae una empresa de la consulta RUC). */
  porNombres(departamento: unknown, provincia: unknown, distrito: unknown): Ubigeo | null {
    const [dep, prov, dist] = [departamento, provincia, distrito].map(normalizarTextoUbigeo);
    if (!dep || !prov || !dist) return null;
    return this.entradas.find((e) => e.departamento === dep && e.provincia === prov && e.distrito === dist)?.ubigeo ?? null;
  }

  /**
   * Hasta `limite` distritos. Dígitos: los códigos que empiezan así. Texto: los distritos donde aparecen
   * todas las palabras (en el distrito, la provincia o el departamento), primero los que coinciden con el
   * nombre del distrito y después los de la provincia.
   */
  buscar(consulta: string, limite = MAXIMO_RESULTADOS_UBIGEO): Ubigeo[] {
    const tope = Math.max(1, Math.min(MAXIMO_RESULTADOS_UBIGEO, Math.trunc(limite) || MAXIMO_RESULTADOS_UBIGEO));
    const texto = normalizarTextoUbigeo(consulta);
    if (texto.length < MINIMO_CARACTERES_BUSQUEDA_UBIGEO) return [];

    const digitos = texto.replace(/ /g, '');
    if (/^\d+$/.test(digitos)) {
      return this.entradas
        .filter((e) => e.ubigeo.codigo.startsWith(digitos))
        .slice(0, tope)
        .map((e) => e.ubigeo);
    }

    const palabras = texto.split(' ').filter(Boolean);
    const primera = palabras[0];
    const puntaje = (e: Entrada): number => {
      if (e.distrito === texto) return 0;
      if (e.distrito.startsWith(texto)) return 1;
      if (palabras.every((p) => e.distrito.includes(p))) return 2;
      if (e.distrito.startsWith(primera)) return 3;
      if (e.distrito.split(' ').some((p) => p.startsWith(primera))) return 4;
      if (e.provincia === texto || e.provincia.startsWith(primera)) return 5;
      return 6;
    };
    return this.entradas
      .filter((e) => palabras.every((p) => e.todo.includes(p)))
      .map((e) => ({ e, puntos: puntaje(e) }))
      .sort((a, b) => a.puntos - b.puntos || a.e.distrito.localeCompare(b.e.distrito) || a.e.ubigeo.codigo.localeCompare(b.e.ubigeo.codigo))
      .slice(0, tope)
      .map(({ e }) => e.ubigeo);
  }
}

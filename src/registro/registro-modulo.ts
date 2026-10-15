import type { Provider, Type } from '@nestjs/common';

/**
 * Lo que un módulo de dominio aporta a AppModule. Cada dominio mantiene su propio
 * archivo *.registro.ts y AppModule los une, así nadie edita app.module.ts para registrar.
 * Las entidades se registran en forFeature('pgConnection'); con autoLoadEntities la
 * conexión las carga sin tocar database.config.ts.
 */
export interface RegistroModulo {
  entidades: Function[];
  controladores: Type<unknown>[];
  proveedores: Provider[];
}

export function registroVacio(): RegistroModulo {
  return { entidades: [], controladores: [], proveedores: [] };
}

/** Une varios registros sin duplicar clases (un mismo provider en dos registros se registra una vez). */
export function unirRegistros(...registros: RegistroModulo[]): RegistroModulo {
  const unicos = <T>(lista: T[]): T[] => Array.from(new Set(lista));
  return {
    entidades: unicos(registros.flatMap((r) => r.entidades)),
    controladores: unicos(registros.flatMap((r) => r.controladores)),
    proveedores: unicos(registros.flatMap((r) => r.proveedores)),
  };
}

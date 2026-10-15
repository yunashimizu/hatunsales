import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { SaludController } from '../api/controllers/salud.controller';
import { LogBussnies } from '../bussnies/Bussnies/log.bussnies';
import { SaludBussnies } from '../bussnies/Bussnies/salud.bussnies';
import { LimitePeticionesGuard } from '../guards/limite-peticiones.guard';
import { Auditoria } from '../models/DBModel/auditoria.entity';
import { SaludRepository } from '../repository/Repository/salud.repository';
import { FiltroErroresGlobal } from '../util/http/errores/filtro-errores.filter';
import { PROVEEDORES_LIMITE_PETICIONES } from '../util/http/limite-peticiones/limite-peticiones.providers';
import { RegistroModulo } from './registro-modulo';

/**
 * Plataforma HTTP transversal:
 *  - GET /salud (monitoreo externo).
 *  - Filtro global de errores (formato uniforme, PostgreSQL → 4xx/5xx en español).
 *  - Límite de peticiones por IP (guard global, antes que JwtGuard).
 *  - Auditoría en PostgreSQL (GET /log; LogRepository sigue registrado en AppModule).
 * El ValidationPipe, CORS, cabeceras y el registro de peticiones lentas están en main.ts.
 */
export const REGISTRO_PLATAFORMA: RegistroModulo = {
  entidades: [Auditoria],
  controladores: [SaludController],
  proveedores: [
    SaludRepository,
    SaludBussnies,
    LogBussnies,
    ...PROVEEDORES_LIMITE_PETICIONES,
    { provide: APP_GUARD, useClass: LimitePeticionesGuard },
    { provide: APP_FILTER, useFactory: () => new FiltroErroresGlobal() },
  ],
};

import type { EntityManager } from 'typeorm';
import type { UsuarioToken } from '../../guards/usuario-actual.decorator';
import type { MovimientoCajaRequest } from '../../models/model/caja.request';
import type { RegistrarArqueoRequest } from '../../models/model/caja-arqueo.request';
import type {
  ArqueoDetalleResponse,
  ArqueoResumenResponse,
  MovimientoCajaResponse,
  MovimientosTurnoResponse,
  TurnoArqueoResponse,
} from '../../models/model/caja-arqueo.response';
import type { PreparacionCierre } from '../../repository/Repository/caja-sesion.repository';
import type { FormatoArqueoPdf } from '../../util/documentos/arqueo-pdf';
import type { ArqueoEsperadoConMarca } from '../../caja/arqueo/arqueo-ciego';

/** Lo que el arqueo aporta al cierre del turno (POST /caja/cerrar). */
export interface ResultadoPreparacionCierre {
  preparacion: PreparacionCierre;
  /** Efectivo esperado por el sistema al cerrar (cierres_caja.monto_final). */
  efectivo_esperado: number | null;
  /** Arqueo de cierre que respalda el cierre, si lo hay. */
  arqueo: ArqueoResumenResponse | null;
  /** Aviso para el cajero (p. ej. arqueo desactualizado que no se usó). */
  aviso?: string;
}

export interface ICajaArqueoBussniees {
  /** Con el arqueo ciego (Fase 7.3) y un usuario no admin, los montos del esperado van en null. */
  esperado(usuario: UsuarioToken, idApertura?: number): Promise<ArqueoEsperadoConMarca>;
  registrar(usuario: UsuarioToken, dto: RegistrarArqueoRequest): Promise<ArqueoDetalleResponse>;
  listar(
    usuario: UsuarioToken,
    idApertura?: number,
    limite?: number,
  ): Promise<{ apertura: TurnoArqueoResponse; items: ArqueoResumenResponse[] }>;
  obtener(usuario: UsuarioToken, idArqueo: number): Promise<ArqueoDetalleResponse>;
  pdf(usuario: UsuarioToken, idArqueo: number, formato: FormatoArqueoPdf): Promise<{ buffer: Buffer; nombreArchivo: string }>;
  registrarMovimiento(usuario: UsuarioToken, dto: MovimientoCajaRequest): Promise<MovimientoCajaResponse>;
  listarMovimientos(usuario: UsuarioToken, idApertura?: number, limite?: number): Promise<MovimientosTurnoResponse>;
  prepararCierre(
    manager: EntityManager,
    idApertura: number,
    opciones: { idArqueo?: number; montoConteoCuerpo?: number | null; ocultarEsperado?: boolean },
  ): Promise<ResultadoPreparacionCierre>;
}

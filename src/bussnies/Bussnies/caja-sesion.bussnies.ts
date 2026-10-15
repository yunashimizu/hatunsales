import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { CajaSesionRepository } from '../../repository/Repository/caja-sesion.repository';
import type { UsuarioToken } from '../../guards/usuario-actual.decorator';
import { CodigoError, cuerpoError } from '../../util/errores-operativos';
import { normalizarRol } from '../../config/roles.config';
import { AbrirCajaRequest, CerrarCajaRequest } from '../../models/model/caja.request';
import { CajaArqueoBussnies } from './caja-arqueo.bussnies';
import type { ResultadoPreparacionCierre } from '../Ibussnies/ICajaArqueoBussniees';
import { relanzarHttp } from '../../caja/http/errores-caja.http';

/**
 * Turno de caja (apertura / cierre). Sin DDL: el esquema se lee del catálogo una sola vez
 * y la configuración (caja_modo) sale de ConfiguracionRepository con su caché.
 */
@Injectable()
export class CajaSesionBussnies {
  constructor(
    private readonly repo: CajaSesionRepository,
    private readonly arqueos: CajaArqueoBussnies,
  ) {}

  /** GET /caja/sesion (dashboard y POS): modo y turno en paralelo. */
  async sesion(usuario: UsuarioToken) {
    const idUsuario = Number(usuario?.id_usuario);
    const [modo, apertura] = await Promise.all([
      this.repo.modoCaja(),
      idUsuario ? this.repo.sesionUsuario(idUsuario) : Promise.resolve(null),
    ]);
    if (!idUsuario) {
      return { modo, abierta: false, apertura: null, resumen: null };
    }
    const resumen = apertura ? await this.repo.resumenTurno(apertura) : null;
    return {
      modo,
      abierta: !!apertura,
      apertura,
      resumen,
    };
  }

  async resumenTurno(usuario: UsuarioToken) {
    const idUsuario = Number(usuario?.id_usuario);
    if (!idUsuario) {
      throw new ForbiddenException('Sesión inválida');
    }
    const apertura = await this.repo.sesionUsuario(idUsuario);
    if (!apertura) {
      throw new NotFoundException(
        cuerpoError(CodigoError.CAJA_NO_ABIERTA, 'No hay caja abierta para resumir'),
      );
    }
    const resumen = await this.repo.resumenTurno(apertura);
    return { apertura, resumen };
  }

  async disponibles() {
    const items = await this.repo.listarDisponibles();
    return { items };
  }

  async abrir(body: AbrirCajaRequest, usuario: UsuarioToken) {
    const idUsuario = Number(usuario?.id_usuario);
    if (!idUsuario) {
      throw new ForbiddenException('Sesión inválida');
    }
    const idCaja = Number(body?.id_caja);
    if (!Number.isInteger(idCaja) || idCaja <= 0) {
      throw new BadRequestException('Indique la caja a abrir (id_caja)');
    }
    if (!(await this.repo.cajaExiste(idCaja))) {
      throw new NotFoundException(
        cuerpoError(CodigoError.ENTIDAD_NO_ENCONTRADA, 'Caja no encontrada'),
      );
    }

    try {
      return await this.repo.abrir({
        idCaja,
        idUsuario,
        montoInicial: body?.monto_inicial,
      });
    } catch (e: any) {
      this.mapError(e);
    }
  }

  /**
   * Cierra el turno. Si llega id_arqueo (o hay un arqueo de cierre vigente y no se mandó
   * monto_conteo) el conteo sale del arqueo y queda enlazado; sin arqueo, igual que antes.
   * Además guarda el efectivo esperado en cierres_caja.monto_final.
   */
  async cerrar(body: CerrarCajaRequest, usuario: UsuarioToken) {
    const idUsuario = Number(usuario?.id_usuario);
    if (!idUsuario) {
      throw new ForbiddenException('Sesión inválida');
    }

    let idApertura = Number(body?.id_apertura);
    if (!Number.isInteger(idApertura) || idApertura <= 0) {
      const propia = await this.repo.sesionUsuario(idUsuario);
      if (!propia) {
        throw new NotFoundException(
          cuerpoError(
            CodigoError.CAJA_APERTURA_NO_ENCONTRADA,
            'No tiene una apertura abierta para cerrar',
          ),
        );
      }
      idApertura = propia.id_apertura;
    }

    const apertura = await this.repo.obtenerAperturaPorId(idApertura);
    if (!apertura) {
      throw new NotFoundException(
        cuerpoError(CodigoError.CAJA_APERTURA_NO_ENCONTRADA, 'Apertura no encontrada'),
      );
    }

    const esAdmin = normalizarRol(usuario?.rol) === 'admin';
    if (apertura.id_usuario != null && apertura.id_usuario !== idUsuario && !esAdmin) {
      throw new ForbiddenException(
        cuerpoError(
          CodigoError.CAJA_CIERRE_NO_PERMITIDO,
          'Solo puede cerrar su propia apertura (o un admin)',
        ),
      );
    }

    try {
      const resumen = await this.repo.resumenTurno(apertura);
      const info: { valor: ResultadoPreparacionCierre | null } = { valor: null };
      const cerrado = await this.repo.cerrar(
        {
          idApertura,
          idUsuario,
          montoConteo: body?.monto_conteo,
          observacion: body?.observacion,
        },
        async (manager) => {
          info.valor = await this.arqueos.prepararCierre(manager, idApertura, {
            idArqueo: body?.id_arqueo,
            montoConteoCuerpo: body?.monto_conteo,
          });
          return info.valor.preparacion;
        },
      );
      const extra = info.valor;
      return {
        ...cerrado,
        resumen,
        ...(extra?.efectivo_esperado != null ? { efectivo_esperado: extra.efectivo_esperado } : {}),
        ...(extra?.arqueo ? { arqueo: extra.arqueo } : {}),
        ...(extra?.aviso ? { aviso: extra.aviso } : {}),
      };
    } catch (e: any) {
      this.mapError(e);
    }
  }

  /** Para modo estricto en ventas (C4). */
  async usuarioTieneApertura(idUsuario?: number): Promise<boolean> {
    if (!idUsuario) return false;
    return this.repo.tieneAperturaAbiertaUsuario(idUsuario);
  }

  async configEstricto(): Promise<{ modo: 'blando' | 'estricto'; bypassAdmin: boolean }> {
    const [modo, bypassAdmin] = await Promise.all([this.repo.modoCaja(), this.repo.bypassAdminEstricto()]);
    return { modo, bypassAdmin };
  }

  private mapError(e: any): never {
    const code = String(e?.message ?? e);
    if (code === 'CAJA_YA_ABIERTA_USUARIO') {
      throw new BadRequestException(
        cuerpoError(
          CodigoError.CAJA_YA_ABIERTA_USUARIO,
          'Ya tiene una caja abierta. Ciérrela antes de abrir otra.',
        ),
      );
    }
    if (code === 'CAJA_OCUPADA') {
      throw new BadRequestException(
        cuerpoError(
          CodigoError.CAJA_OCUPADA,
          'Esa caja ya está abierta por otro turno. Elija otra o pida que la cierren.',
        ),
      );
    }
    if (code === 'CAJA_APERTURA_NO_ENCONTRADA') {
      throw new NotFoundException(
        cuerpoError(CodigoError.CAJA_APERTURA_NO_ENCONTRADA, 'Apertura no encontrada'),
      );
    }
    if (code === 'CAJA_YA_CERRADA') {
      throw new BadRequestException(
        cuerpoError(CodigoError.CAJA_YA_CERRADA, 'Esa apertura ya está cerrada'),
      );
    }
    relanzarHttp(e);
  }
}

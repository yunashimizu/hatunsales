import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { CajaSesionRepository } from '../../repository/Repository/caja-sesion.repository';
import type { UsuarioToken } from '../../guards/usuario-actual.decorator';
import { CodigoError, cuerpoError } from '../../util/errores-operativos';
import { normalizarRol } from '../../config/roles.config';

@Injectable()
export class CajaSesionBussnies implements OnModuleInit {
  constructor(private readonly repo: CajaSesionRepository) {}

  async onModuleInit() {
    await this.repo.asegurarSchema().catch(() => undefined);
  }

  async sesion(usuario: UsuarioToken) {
    const modo = await this.repo.modoCaja();
    const idUsuario = Number(usuario?.id_usuario);
    if (!idUsuario) {
      return { modo, abierta: false, apertura: null, resumen: null };
    }
    const apertura = await this.repo.sesionUsuario(idUsuario);
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

  async abrir(
    body: { id_caja?: number; monto_inicial?: number | null },
    usuario: UsuarioToken,
  ) {
    const idUsuario = Number(usuario?.id_usuario);
    if (!idUsuario) {
      throw new ForbiddenException('Sesión inválida');
    }
    const idCaja = Number(body?.id_caja);
    if (!Number.isFinite(idCaja) || idCaja <= 0) {
      throw new BadRequestException('Indique la caja a abrir (id_caja)');
    }
    if (!(await this.repo.cajaExiste(idCaja))) {
      throw new NotFoundException(
        cuerpoError(CodigoError.ENTIDAD_NO_ENCONTRADA, 'Caja no encontrada'),
      );
    }

    try {
      const apertura = await this.repo.abrir({
        idCaja,
        idUsuario,
        montoInicial: body?.monto_inicial,
      });
      return apertura;
    } catch (e: any) {
      this.mapError(e);
    }
  }

  async cerrar(
    body: {
      id_apertura?: number;
      monto_conteo?: number | null;
      observacion?: string | null;
    },
    usuario: UsuarioToken,
  ) {
    const idUsuario = Number(usuario?.id_usuario);
    if (!idUsuario) {
      throw new ForbiddenException('Sesión inválida');
    }

    let idApertura = Number(body?.id_apertura);
    if (!Number.isFinite(idApertura) || idApertura <= 0) {
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

    const rol = normalizarRol(usuario?.rol);
    const esAdmin = rol === 'admin';
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
      const cerrado = await this.repo.cerrar({
        idApertura,
        idUsuario,
        montoConteo: body?.monto_conteo,
        observacion: body?.observacion,
      });
      return { ...cerrado, resumen };
    } catch (e: any) {
      this.mapError(e);
    }
  }

  /** Para modo estricto en ventas (C4). */
  async usuarioTieneApertura(idUsuario?: number): Promise<boolean> {
    if (!idUsuario) return false;
    await this.repo.asegurarSchema();
    return this.repo.tieneAperturaAbiertaUsuario(idUsuario);
  }

  async configEstricto(): Promise<{ modo: 'blando' | 'estricto'; bypassAdmin: boolean }> {
    return {
      modo: await this.repo.modoCaja(),
      bypassAdmin: await this.repo.bypassAdminEstricto(),
    };
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
    throw e;
  }
}

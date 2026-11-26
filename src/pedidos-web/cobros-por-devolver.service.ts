import { BadRequestException, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { BitacoraService } from '../bitacora/bitacora.service';
import { ACCIONES_BITACORA } from '../bitacora/bitacora.acciones';
import { ConfiguracionRepository } from '../repository/Repository/configuracion.repository';
import { EnviadorCorreo } from '../correo/enviador-correo.contrato';
import { correoValido } from '../correo/correo.config';
import { filasDe } from '../caja/bd/resultado-consulta';
import type { UsuarioToken } from '../guards/usuario-actual.decorator';

/** Un cobro aprobado por la pasarela sobre un pedido que ya estaba cancelado (Fase 8.3). */
export interface CobroPorDevolver {
  id_pago: number;
  id_pedido: number;
  codigo: string;
  monto: number;
  moneda: string;
  proveedor: string;
  referencia_externa: string | null;
  fecha: string;
  cliente: string;
  correo_cliente: string | null;
}

export interface AvisoCobroCancelado {
  id_pedido: number;
  codigo?: string | null;
  monto: number;
  proveedor: string;
  referencia?: string | null;
  /** `pago`: el cobro del checkout volvió con el pedido ya cancelado; `webhook`: lo avisó la pasarela. */
  origen: 'pago' | 'webhook';
}

/** Clave dentro de `pedido_pagos.respuesta` (jsonb) con la que el admin marca el cobro como devuelto. */
export const MARCA_DEVUELTO = 'hs_devolucion';

/**
 * Fase 8.3: cobro aprobado sobre un pedido cancelado. NO devuelve el dinero en la pasarela (eso lo hace el
 * dueño en su panel de Culqi): lo deja a la vista para que no se pierda.
 *
 * - Queda en `pedido_pagos` (estado `aprobado` sobre un pedido `cancelado`): de ahí sale la lista del panel y
 *   el contador `cobros_por_devolver` de `GET admin/pedidos/resumen`. No hace falta SQL nuevo.
 * - Se anota en la bitácora (`pedido.cobro_sobre_cancelado`) y se manda un correo al mismo destino de los avisos
 *   fiscales (`fiscal_alertas_correo`, si no `emisor_email` o EMISOR_EMAIL).
 * - El admin lo marca como devuelto (`PUT admin/pedidos/pagos/:id/devuelto`): la marca va dentro de
 *   `pedido_pagos.respuesta` (la restricción de estado no admite otro valor) y en la bitácora.
 *
 * `avisar` nunca lanza: el cliente ya recibió su respuesta y el cobro ya está guardado.
 */
@Injectable()
export class CobrosPorDevolverService {
  private readonly log = new Logger(CobrosPorDevolverService.name);

  constructor(
    @InjectDataSource('pgConnection')
    private readonly dataSource: DataSource,
    @Optional() private readonly config?: ConfiguracionRepository,
    @Optional() private readonly enviador?: EnviadorCorreo,
    @Optional() private readonly bitacora?: BitacoraService,
  ) {}

  async avisar(aviso: AvisoCobroCancelado): Promise<void> {
    const codigo = aviso.codigo || `#${aviso.id_pedido}`;
    const monto = Number(aviso.monto ?? 0).toFixed(2);
    const titulo = `Cobro de S/ ${monto} aprobado sobre el pedido cancelado ${codigo}`;
    try {
      await this.bitacora?.registrarCon(() => ({
        accion: ACCIONES_BITACORA.PEDIDO_COBRO_SOBRE_CANCELADO,
        entidad: 'pedido',
        id_entidad: aviso.id_pedido,
        despues: {
          monto: Number(aviso.monto ?? 0),
          proveedor: aviso.proveedor,
          referencia: aviso.referencia ?? null,
          origen: aviso.origen,
        },
        motivo: 'Requiere devolver el dinero al cliente desde la pasarela',
      }));
    } catch (error) {
      this.log.warn(`No se pudo anotar en la bitácora el cobro sobre el pedido cancelado ${codigo}: ${(error as Error)?.message ?? error}`);
    }
    await this.enviarCorreo(titulo, codigo, monto, aviso);
  }

  /** Cobros aprobados sobre pedidos cancelados que nadie marcó como devueltos (más nuevos primero). */
  async listar(limite = 100): Promise<CobroPorDevolver[]> {
    const filas = filasDe<any>(await this.dataSource.query(
      `SELECT pp.id_pago, p.id_pedido, p.codigo, pp.monto, COALESCE(pp.moneda, 'PEN') AS moneda,
              COALESCE(pp.proveedor, '') AS proveedor, pp.referencia_externa, pp.creado_en AS fecha,
              TRIM(CONCAT_WS(' ', c.nombre, c.apellido_paterno, c.apellido_materno)) AS cliente, c.email AS correo_cliente
         FROM pedido_pagos pp
         JOIN pedidos p ON p.id_pedido = pp.id_pedido
         LEFT JOIN clientes c ON c.id_cliente = p.id_cliente
        WHERE pp.estado = 'aprobado'
          AND p.estado = 'cancelado'
          AND NOT (COALESCE(pp.respuesta, '{}'::jsonb) ? '${MARCA_DEVUELTO}')
        ORDER BY pp.creado_en DESC, pp.id_pago DESC
        LIMIT $1`,
      [Math.min(500, Math.max(1, Math.trunc(limite) || 100))],
    ));
    return filas.map((f) => ({
      id_pago: Number(f.id_pago),
      id_pedido: Number(f.id_pedido),
      codigo: String(f.codigo ?? ''),
      monto: Number(f.monto ?? 0),
      moneda: String(f.moneda ?? 'PEN'),
      proveedor: String(f.proveedor ?? ''),
      referencia_externa: f.referencia_externa ?? null,
      fecha: f.fecha,
      cliente: String(f.cliente ?? ''),
      correo_cliente: f.correo_cliente ?? null,
    }));
  }

  /** Para el contador del panel. Nunca lanza (ante un fallo, 0 y aviso en el log). */
  async contar(): Promise<number> {
    try {
      const filas = filasDe<{ n: number | string }>(await this.dataSource.query(
        `SELECT COUNT(*)::int AS n
           FROM pedido_pagos pp
           JOIN pedidos p ON p.id_pedido = pp.id_pedido
          WHERE pp.estado = 'aprobado'
            AND p.estado = 'cancelado'
            AND NOT (COALESCE(pp.respuesta, '{}'::jsonb) ? '${MARCA_DEVUELTO}')`,
      ));
      return Number(filas[0]?.n ?? 0);
    } catch (error) {
      this.log.warn(`No se pudo contar los cobros por devolver: ${(error as Error)?.message ?? error}`);
      return 0;
    }
  }

  /**
   * El admin ya devolvió el dinero desde la pasarela: marca el cobro (una sola vez) para que salga de la lista.
   * 404 si no es un cobro aprobado de un pedido cancelado; 400 si ya estaba marcado.
   */
  async marcarDevuelto(idPago: number, usuario?: UsuarioToken, referencia?: string): Promise<{ id_pago: number; devuelto: true }> {
    const ref = String(referencia ?? '').trim().slice(0, 120) || null;
    const filas = filasDe<any>(await this.dataSource.query(
      `UPDATE pedido_pagos pp
          SET respuesta = COALESCE(pp.respuesta, '{}'::jsonb)
                          || jsonb_build_object('${MARCA_DEVUELTO}', jsonb_build_object(
                               'fecha', to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
                               'id_usuario', $2::int,
                               'referencia', $3::text)),
              actualizado_en = NOW()
         FROM pedidos p
        WHERE pp.id_pago = $1
          AND p.id_pedido = pp.id_pedido
          AND pp.estado = 'aprobado'
          AND p.estado = 'cancelado'
          AND NOT (COALESCE(pp.respuesta, '{}'::jsonb) ? '${MARCA_DEVUELTO}')
        RETURNING pp.id_pago, pp.id_pedido, pp.monto`,
      [idPago, usuario?.id_usuario ?? null, ref],
    ));
    const fila = filas[0];
    if (!fila) {
      const existe = filasDe<any>(await this.dataSource.query(
        `SELECT pp.estado, p.estado AS estado_pedido, (COALESCE(pp.respuesta, '{}'::jsonb) ? '${MARCA_DEVUELTO}') AS marcado
           FROM pedido_pagos pp JOIN pedidos p ON p.id_pedido = pp.id_pedido
          WHERE pp.id_pago = $1`,
        [idPago],
      ))[0];
      if (existe && (existe.marcado === true || existe.marcado === 't')) {
        throw new BadRequestException('Ese cobro ya estaba marcado como devuelto.');
      }
      throw new NotFoundException('No hay un cobro aprobado de un pedido cancelado con ese número.');
    }
    await this.bitacora?.registrarCon(() => ({
      accion: ACCIONES_BITACORA.PEDIDO_COBRO_DEVUELTO,
      id_usuario: usuario?.id_usuario ?? null,
      rol: usuario?.rol ?? null,
      entidad: 'pedido',
      id_entidad: Number(fila.id_pedido),
      despues: { id_pago: Number(fila.id_pago), monto: Number(fila.monto ?? 0), referencia: ref },
    }));
    return { id_pago: Number(fila.id_pago), devuelto: true };
  }

  private async enviarCorreo(titulo: string, codigo: string, monto: string, aviso: AvisoCobroCancelado): Promise<void> {
    if (!this.enviador || !this.config) return;
    try {
      const destino = await this.destino();
      if (!destino) {
        this.log.warn(`${titulo}: no hay correo para avisos (fiscal_alertas_correo / emisor_email); queda en el panel y en la bitácora.`);
        return;
      }
      const detalle =
        `La pasarela (${aviso.proveedor}) aprobó un cobro de S/ ${monto}${aviso.referencia ? ` (referencia ${aviso.referencia})` : ''} ` +
        `para el pedido ${codigo}, que ya estaba cancelado. Devuelva el dinero al cliente desde el panel de la pasarela y ` +
        'márquelo como devuelto en Pedidos web.';
      const escapar = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      await this.enviador.enviar({
        para: destino,
        asunto: `HATUNSALES: ${titulo}`,
        html: `<!doctype html><html lang="es"><body style="font-family:Arial,Helvetica,sans-serif;color:#222;max-width:560px">
<h2 style="font-size:18px">${escapar(titulo)}</h2><p>${escapar(detalle)}</p></body></html>`,
        texto: `${titulo}\n\n${detalle}`,
        adjuntos: [],
      });
    } catch (error) {
      this.log.warn(`${titulo}: no se pudo enviar el correo de aviso: ${(error as Error)?.message ?? error}`);
    }
  }

  private async destino(): Promise<string | null> {
    const limpio = (v: string | null | undefined) => {
      const t = (v ?? '').trim();
      return t && correoValido(t) ? t : null;
    };
    return (
      limpio(await this.config!.obtener('fiscal_alertas_correo')) ??
      limpio((await this.config!.obtener('emisor_email')) ?? process.env.EMISOR_EMAIL ?? null)
    );
  }
}

import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtGuard } from '../../guards/jwt.guard';
import { RolesGuard } from '../../guards/roles.guard';
import { Roles } from '../../guards/roles.decorator';
import { FiscalProviderService } from '../fiscal/fiscal-provider.service';
import type { DocumentoFiscalBase, FiscalGreDocument } from '../fiscal/fiscal-provider.interface';
import { SunatDirectGreProvider } from '../fiscal/sunat-direct-gre.provider';
import { ResumenDiarioEnvioService } from '../fiscal/resumen-diario-envio.service';
import type { EmitirResumenDiarioBetaDto } from './resumen-diario-beta.service';
import { FiscalEnvioRepository } from '../repository/fiscal-envio.repository';
import { emisorConfig } from '../../config/emisor.config';

/**
 * Endpoints admin para probar el pipeline SUNAT-direct BETA (Factura,
 * Boleta, Nota de Crédito, Resumen Diario y Guía de Remisión) contra
 * SUNAT real, requiere SUNAT_DIRECT_ENABLED=true — si no, cada llamada
 * responde PENDIENTE sin intentar nada (mismo comportamiento seguro de
 * Fase 1 que el resto del módulo). No confundir con el flujo real de
 * ventas (Nubefact, comprobante.bussnies.ts): esto es solo para probar el
 * pipeline directo mientras se decide si se usa en producción.
 */
@ApiTags('Fiscal - BETA')
@ApiBearerAuth('access-token')
@Controller('sunat/beta')
@UseGuards(JwtGuard, RolesGuard)
@Roles('admin')
export class FacturaBetaAdminController {
  constructor(
    private readonly fiscalProviderService: FiscalProviderService,
    private readonly fiscalEnvioRepository: FiscalEnvioRepository,
  ) {}

  /** Factura (01), Boleta (03) o Nota de Crédito (07): documentType decide el flujo. */
  @Post('documento')
  async emitirDocumento(@Body() documento: DocumentoFiscalBase) {
    return this.fiscalProviderService.preparar(documento);
  }

  @Post('guia-remision')
  async emitirGuiaRemision(@Body() documento: FiscalGreDocument) {
    const provider = new SunatDirectGreProvider(this.fiscalEnvioRepository);
    return provider.emitir(documento);
  }

  @Post('resumen-diario')
  async enviarResumenDiario(@Body() dto: EmitirResumenDiarioBetaDto) {
    const service = new ResumenDiarioEnvioService(this.fiscalEnvioRepository);
    return service.enviar(dto);
  }

  @Get('resumen-diario/:ticket')
  async consultarResumenDiario(@Param('ticket') ticket: string) {
    const service = new ResumenDiarioEnvioService(this.fiscalEnvioRepository);
    return service.consultarTicket(ticket, emisorConfig.ruc);
  }
}

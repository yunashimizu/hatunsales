import { Injectable, Logger } from '@nestjs/common';
import { NoopFiscalProvider } from './noop-fiscal.provider';
import { SunatDirectFiscalProvider } from './sunat-direct-fiscal.provider';
import { DocumentoFiscalBase, FiscalProvider, ResultadoPreparacionFiscal } from './fiscal-provider.interface';
import { getFiscalConfig } from '../config/fiscal-config';
import { FiscalEnvioRepository } from '../repository/fiscal-envio.repository';

@Injectable()
export class FiscalProviderService {
  private readonly logger = new Logger(FiscalProviderService.name);

  constructor(private readonly fiscalEnvioRepository?: FiscalEnvioRepository) {}

  private resolveProvider(): FiscalProvider {
    const config = getFiscalConfig();
    return config.proveedorHabilitado && config.proveedorActivo === 'sunat-direct'
      ? new SunatDirectFiscalProvider(this.fiscalEnvioRepository)
      : new NoopFiscalProvider();
  }

  async preparar(documento: DocumentoFiscalBase): Promise<ResultadoPreparacionFiscal> {
    const config = getFiscalConfig();
    const provider = this.resolveProvider();

    if (!config.proveedorHabilitado || config.proveedorActivo !== 'sunat-direct') {
      this.logger.warn(`Fase 1: proveedor fiscal inactivo para ${documento.documentType}-${documento.series}-${documento.number}`);
      return provider.preparar(documento);
    }

    this.logger.log(`Proveedor fiscal directo habilitado para ${documento.documentType}-${documento.series}-${documento.number}`);
    return provider.preparar(documento);
  }
}

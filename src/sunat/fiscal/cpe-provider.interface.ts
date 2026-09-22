import {
  CpeProvider,
  FiscalCpeDocument,
  FiscalIssueResult,
  GreProvider,
  FiscalGreDocument,
} from './fiscal-provider.interface';

export interface CpeSoapConfig {
  betaUrl?: string;
  productionUrl?: string;
  environment?: 'beta' | 'produccion';
  user?: string;
  password?: string;
}

export interface CpeSoapClient extends CpeProvider {
  emit(documento: FiscalCpeDocument): Promise<FiscalIssueResult>;
  getStatus(ticket: string): Promise<FiscalIssueResult>;
}

export interface GreRestConfig {
  tokenUrl?: string;
  betaUrl?: string;
  productionUrl?: string;
  clientId?: string;
  clientSecret?: string;
  username?: string;
  password?: string;
}

export interface GreRestClient extends GreProvider {
  getToken(): Promise<string>;
}

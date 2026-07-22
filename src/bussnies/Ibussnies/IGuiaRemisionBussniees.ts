import { CrearGuiaRemisionRequest } from '../../models/model/guia-remision.request';
import { GuiaRemisionResponse } from '../../models/model/guia-remision.response';

export interface IGuiaRemisionBussniees {
  getAll(): Promise<GuiaRemisionResponse[]>;
  create(entity: CrearGuiaRemisionRequest): Promise<GuiaRemisionResponse>;
}

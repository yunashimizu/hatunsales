import { CrearProformaRequest } from '../../models/model/proforma.request';
import { ProformaResponse } from '../../models/model/proforma.response';

export interface IProformaBussniees {
  getAll(): Promise<ProformaResponse[]>;
  create(entity: CrearProformaRequest): Promise<ProformaResponse>;
}

import { DniResponse, RucResponse } from '../../models/model/sunat.response';
import { BuscarDniRequest, BuscarRucEmpresaRequest, BuscarRucProveedorRequest } from '../../models/model/sunat.request';

export interface ISunatBussniees {
  consultarDni(dni: string): Promise<DniResponse>;
  guardarClienteDni(dto: BuscarDniRequest): Promise<DniResponse>;
  consultarRuc(ruc: string): Promise<RucResponse>;
  guardarEmpresaRuc(dto: BuscarRucEmpresaRequest): Promise<RucResponse>;
  guardarProveedorRuc(dto: BuscarRucProveedorRequest): Promise<RucResponse>;
}
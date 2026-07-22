import { IBussniesCrud } from '../Ibussnies/ICRudBussnies/generic-crud.interface';
import { CrearClienteRequest, ActualizarClienteRequest } from '../../models/model/cliente.request';
import { ClienteResponse } from '../../models/model/cliente.response';

export interface IClienteBussniees extends IBussniesCrud<CrearClienteRequest, ClienteResponse> {
  crearDesdeUsuario(id_usuario: number): Promise<ClienteResponse>;
  crearDesdeSunatDni(dni: string): Promise<ClienteResponse>;
  crearDesdeSunatRuc(ruc: string): Promise<ClienteResponse>;
  update(entity: ActualizarClienteRequest, id?: number): Promise<ClienteResponse>;
}
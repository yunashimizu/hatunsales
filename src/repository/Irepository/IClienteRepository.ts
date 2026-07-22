import { Cliente } from '../../models/DBModel/cliente.entity';

export interface IClienteRepository {
  getAll(): Promise<Cliente[]>;
  getById(id: number): Promise<Cliente | null>;
  buscarPorDni(dni: number): Promise<Cliente | null>;
  buscarPorEmail(email: string): Promise<Cliente | null>;
  buscarPorUsuario(id_usuario: number): Promise<Cliente | null>;
  guardarConDocumento(data: Partial<Cliente>, tipoDoc: string, numeroDoc: number): Promise<Cliente>;
  guardarSinDocumento(data: Partial<Cliente>): Promise<Cliente>;
  actualizar(id: number, data: Partial<Cliente>): Promise<Cliente>;
  delete(id: number): Promise<number>;
}
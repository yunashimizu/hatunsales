import { ActualizarInventarioRequest } from '../../models/model/inventario.request';
import { InventarioResponse } from '../../models/model/inventario.response';

export interface IInventarioBussniees {
  getAll(): Promise<InventarioResponse[]>;
  getByProducto(id_producto: number): Promise<InventarioResponse>;
  update(entity: ActualizarInventarioRequest): Promise<InventarioResponse>;
}

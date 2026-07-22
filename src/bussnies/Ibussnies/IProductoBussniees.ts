import { CrearProductoRequest, ActualizarProductoRequest } from '../../models/model/producto.request';
import { ProductoResponse } from '../../models/model/producto.response';

export interface IProductoBussniees {
  getAll(): Promise<ProductoResponse[]>;
  getById(id: number): Promise<ProductoResponse>;
  create(entity: CrearProductoRequest): Promise<ProductoResponse>;
  update(entity: ActualizarProductoRequest, id: number): Promise<ProductoResponse>;
  delete(id: number): Promise<number>;
  buscarPorCodigoBarras(codigo_barras: string): Promise<ProductoResponse>;
}

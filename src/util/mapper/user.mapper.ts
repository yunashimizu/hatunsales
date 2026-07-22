import { Usuario } from '../../models/DBModel/user.entity';
import { UserRequest } from '../../models/model/user-request';
import { UserResponse } from '../../models/model/user-response';

export class UserMapper {

  static toEntity(dto: UserRequest): Partial<Usuario> {
    return {
      nombre: dto.nombre,
      contrasena: dto.contrasena,
    };
  }

  static toResponse(entity: Usuario): UserResponse {
    return {
      idusuario: entity.idusuario,
      nombre: entity.nombre,
    };
  }
}
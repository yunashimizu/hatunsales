import { Injectable } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { HatunsalesRepository } from '../../repository/Repository/user-repository';
import { LogRepository } from '../../repository/Repository/log-repository';
import { UserMapper } from '../../util/mapper/user.mapper';
import { UserRequest } from '../../models/model/user-request';

@Injectable()
export class UserService {

  constructor(
    private readonly repo: HatunsalesRepository,
    private readonly logRepo: LogRepository,
  ) {}

  async getAll() {
    const data = await this.repo.getAll();
    return data.map(UserMapper.toResponse);
  }

  async getById(id: number) {
    const user = await this.repo.getById(id);
    return user ? UserMapper.toResponse(user) : null;
  }

  async create(dto: UserRequest) {
    dto.contrasena = await bcrypt.hash(dto.contrasena, 10);
    const entity = UserMapper.toEntity(dto);
    const saved = await this.repo.create(entity);
    await this.logRepo.registrar('CREATE', 'usuario');
    return UserMapper.toResponse(saved);
  }

  async update(id: number, dto: UserRequest) {
    const entity = UserMapper.toEntity(dto);
    const updated = await this.repo.update(id, entity);
    await this.logRepo.registrar('UPDATE', 'usuario');
    return updated ? UserMapper.toResponse(updated) : null;
  }

  async delete(id: number) {
    await this.logRepo.registrar('DELETE', 'usuario');
    return this.repo.delete(id);
  }
}
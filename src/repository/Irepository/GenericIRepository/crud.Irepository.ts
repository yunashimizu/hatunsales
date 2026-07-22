import { Repository, DeepPartial, ObjectLiteral } from 'typeorm';

export class CrudRepository<T extends ObjectLiteral> {

  constructor(protected repo: Repository<T>) {}

  async getAll(): Promise<T[]> {
    return this.repo.find();
  }

  async getById(id: number): Promise<T | null> {
    return this.repo.findOne({ where: { idusuario: id } as any });
  }

  async create(entity: DeepPartial<T>): Promise<T> {
    const newEntity = this.repo.create(entity);
    return this.repo.save(newEntity);
  }

  async update(id: number, entity: DeepPartial<T>): Promise<T> {
    await this.repo.update(id, entity as any);
    return this.getById(id) as Promise<T>;
  }

  async delete(id: number): Promise<number> {
    const result = await this.repo.delete(id);
    return result.affected ?? 0;
  }
}
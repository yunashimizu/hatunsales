import { Repository, DeepPartial, ObjectLiteral, FindOptionsWhere } from 'typeorm';

export class CrudRepository<T extends ObjectLiteral> {

  constructor(protected repo: Repository<T>) {}

  async getAll(): Promise<T[]> {
    return this.repo.find();
  }

  /** Busca por la clave primaria real de la entidad (antes filtraba siempre por 'idusuario'). */
  async getById(id: number): Promise<T | null> {
    return this.repo.findOne({ where: { [this.propiedadClavePrimaria()]: id } as FindOptionsWhere<T> });
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

  /** Nombre de la propiedad de la clave primaria según la metadata de TypeORM. */
  protected propiedadClavePrimaria(): string {
    const primarias = this.repo.metadata.primaryColumns;
    if (primarias.length !== 1) {
      throw new Error(
        `CrudRepository.getById necesita una clave primaria simple y ${this.repo.metadata.name} tiene ${primarias.length}.`,
      );
    }
    return primarias[0].propertyName;
  }
}

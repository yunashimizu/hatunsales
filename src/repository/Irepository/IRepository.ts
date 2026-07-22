import { DeepPartial, ObjectLiteral } from 'typeorm';

export interface IRepository<T extends ObjectLiteral> {
  getAll(): Promise<T[]>;
  getById(id: number): Promise<T | null>;
  create(entity: DeepPartial<T>): Promise<T>;
  update(id: number, entity: DeepPartial<T>): Promise<T>;
  delete(id: number): Promise<number>;
}
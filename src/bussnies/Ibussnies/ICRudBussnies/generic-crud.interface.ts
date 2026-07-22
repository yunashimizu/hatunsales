export interface IBussniesCrud<T, Y> {
  getAll(): Promise<Y[]>;
  getById(id: number): Promise<Y>;
  create(entity: T): Promise<Y>;
  update(entity: T): Promise<Y>;
  delete(id: number): Promise<number>;
}
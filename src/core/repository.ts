import type { Result } from "./result.js";
import type { NotFoundError, ValidationError, StorageError } from "./errors.js";

/** Generic repository interface for CRUD operations */
export interface Repository<T, CreateInput, UpdateInput> {
  findById(id: string): Promise<Result<T, NotFoundError | StorageError>>;
  findMany(filter?: Record<string, unknown>): Promise<Result<T[], StorageError>>;
  create(input: CreateInput): Promise<Result<T, ValidationError | StorageError>>;
  update(id: string, input: UpdateInput): Promise<Result<T, NotFoundError | ValidationError | StorageError>>;
  delete(id: string): Promise<Result<void, NotFoundError | StorageError>>;
  exists(id: string): Promise<boolean>;
}

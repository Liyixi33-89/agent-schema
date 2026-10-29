import type { AnySchema } from './types';

export const LATEST_SCHEMA_VERSION = 1;
export class FutureSchemaVersionError extends Error {
  constructor(version: number) {
    super(`Unsupported future schema version: ${version}`);
    this.name = 'FutureSchemaVersionError';
  }
}
export function migrate(schema: AnySchema): AnySchema {
  if (!Number.isInteger(schema.schemaVersion) || schema.schemaVersion < 1) {
    throw new Error('Invalid schemaVersion');
  }
  if (schema.schemaVersion > LATEST_SCHEMA_VERSION) {
    throw new FutureSchemaVersionError(schema.schemaVersion);
  }
  return structuredClone(schema);
}

/**
 * Shared FakeServer mock for MCP tool handler tests.
 * Replaces 16+ identical copies across test files.
 */
export class FakeServer {
  handlers = new Map<string, (input: unknown) => Promise<any>>();
  schemas = new Map<string, Record<string, { safeParse: (input: unknown) => { success: boolean } }>>();

  tool(name: string, _description: string, schema: object, handler: (input: unknown) => Promise<any>) {
    this.handlers.set(name, handler);
    this.schemas.set(name, schema as Record<string, { safeParse: (input: unknown) => { success: boolean } }>);
  }
}

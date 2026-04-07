import { describe, it, expect, vi } from "vitest";
import { DisposableStack } from "../../../src/core/lifecycle.js";
import type { Disposable } from "../../../src/core/lifecycle.js";

describe("DisposableStack", () => {
  it("starts empty with size 0", () => {
    const stack = new DisposableStack();
    expect(stack.size).toBe(0);
  });

  it("use() registers a disposable and returns it", () => {
    const stack = new DisposableStack();
    const resource: Disposable = { dispose: vi.fn().mockResolvedValue(undefined) };
    const returned = stack.use(resource);
    expect(returned).toBe(resource);
    expect(stack.size).toBe(1);
  });

  it("dispose() calls dispose on all resources", async () => {
    const stack = new DisposableStack();
    const disposeFn1 = vi.fn().mockResolvedValue(undefined);
    const disposeFn2 = vi.fn().mockResolvedValue(undefined);
    stack.use({ dispose: disposeFn1 });
    stack.use({ dispose: disposeFn2 });
    await stack.dispose();
    expect(disposeFn1).toHaveBeenCalledOnce();
    expect(disposeFn2).toHaveBeenCalledOnce();
  });

  it("resources are disposed in LIFO order", async () => {
    const stack = new DisposableStack();
    const order: number[] = [];
    stack.use({ dispose: async () => { order.push(1); } });
    stack.use({ dispose: async () => { order.push(2); } });
    stack.use({ dispose: async () => { order.push(3); } });
    await stack.dispose();
    expect(order).toEqual([3, 2, 1]);
  });

  it("defer() registers a cleanup function", async () => {
    const stack = new DisposableStack();
    const fn = vi.fn().mockResolvedValue(undefined);
    stack.defer(fn);
    expect(stack.size).toBe(1);
    await stack.dispose();
    expect(fn).toHaveBeenCalledOnce();
  });

  it("defer() works with synchronous functions", async () => {
    const stack = new DisposableStack();
    const fn = vi.fn();
    stack.defer(fn);
    await stack.dispose();
    expect(fn).toHaveBeenCalledOnce();
  });

  it("after dispose(), size is 0", async () => {
    const stack = new DisposableStack();
    stack.use({ dispose: async () => {} });
    stack.use({ dispose: async () => {} });
    await stack.dispose();
    expect(stack.size).toBe(0);
  });

  it("errors during dispose are aggregated into AggregateError", async () => {
    const stack = new DisposableStack();
    stack.use({ dispose: async () => { throw new Error("error 1"); } });
    stack.use({ dispose: async () => { throw new Error("error 2"); } });
    stack.use({ dispose: async () => {} }); // this one succeeds

    await expect(stack.dispose()).rejects.toThrow(AggregateError);
    try {
      const stack2 = new DisposableStack();
      stack2.use({ dispose: async () => { throw new Error("error A"); } });
      stack2.use({ dispose: async () => { throw new Error("error B"); } });
      await stack2.dispose();
    } catch (e) {
      expect(e).toBeInstanceOf(AggregateError);
      expect((e as AggregateError).errors).toHaveLength(2);
      expect((e as AggregateError).message).toContain("2 resource(s)");
    }
  });

  it("successful dispose doesn't throw even with empty stack", async () => {
    const stack = new DisposableStack();
    await expect(stack.dispose()).resolves.toBeUndefined();
  });

  it("errors don't prevent other resources from being disposed", async () => {
    const stack = new DisposableStack();
    const lastDispose = vi.fn().mockResolvedValue(undefined);
    // First registered = last to run in LIFO
    stack.use({ dispose: async () => { throw new Error("oops"); } });
    stack.use({ dispose: lastDispose });
    try {
      await stack.dispose();
    } catch {
      // expected
    }
    expect(lastDispose).toHaveBeenCalledOnce();
  });
});

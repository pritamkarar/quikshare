import { describe, expect, it } from 'vitest';

describe('environment', () => {
  it('has Web Crypto subtle available', () => {
    expect(globalThis.crypto?.subtle).toBeDefined();
  });

  it('has File and Blob available', () => {
    expect(typeof Blob).toBe('function');
    expect(typeof File).toBe('function');
  });
});

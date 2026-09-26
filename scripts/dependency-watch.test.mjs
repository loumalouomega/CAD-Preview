import { describe, it, expect, vi } from 'vitest';
import { outdatedRows, issueBody, publishReport } from './dependency-watch.mjs';
const manifest = { dependencies: { three: '^0.185.0' } };
const rows = [{ name: 'three', declared: '^0.185.0', current: '0.185.0', latest: '0.186.0' }];
describe('dependency watch', () => {
  it('reports updates outside the declared range and ignores wanted', () => {
    expect(outdatedRows({ status: 1, stdout: JSON.stringify({ three: { current: '0.185.0', wanted: '0.185.0', latest: '0.186.0' } }) }, manifest)).toEqual(rows);
  });
  it('reports a major release beyond the declared caret range', () => {
    const manifest = { dependencies: { '@meshioplusplus/wasm': '^16.16.0' } };
    expect(outdatedRows({ status: 1, stdout: JSON.stringify({ '@meshioplusplus/wasm': { current: '16.16.0', wanted: '16.16.0', latest: '17.0.0' } }) }, manifest)[0].latest).toBe('17.0.0');
  });
  it('handles npm array results without duplicate or nested-dependency alerts', () => {
    const row = { current: '0.185.0', latest: '0.186.0', location: '/project/node_modules/three' };
    expect(outdatedRows({ status: 1, stdout: JSON.stringify({ three: [{ ...row, location: '/project/node_modules/other/node_modules/three' }, row, row] }) }, manifest, '/project')).toEqual(rows);
  });
  it('accepts no updates and ignores unrelated packages', () => {
    expect(outdatedRows({ status: 0, stdout: '{}' }, manifest)).toEqual([]);
    expect(outdatedRows({ status: 1, stdout: '{"other": {"latest": "2"}}' }, manifest)).toEqual([]);
  });
  it('rejects registry errors, missing installations and malformed output', () => {
    for (const result of [{ status: 1, stdout: '{"error":{"code":"EAI_AGAIN"}}' }, { status: 1, stdout: '' }, { status: 2 }, { status: 1, stdout: 'bad json' }, { status: 1, stdout: '{"three":{"latest":"1"}}' }]) {
      expect(() => outdatedRows(result, manifest)).toThrow();
    }
  });
  it('creates, updates, and deduplicates a single tracking issue', async () => {
    const api = { list: vi.fn().mockResolvedValue([]), create: vi.fn(), update: vi.fn() };
    expect(await publishReport(rows, api)).toBe('created');
    api.list.mockResolvedValue([{ number: 12, body: issueBody(rows) }]);
    expect(await publishReport(rows, api)).toBe('unchanged');
    expect(await publishReport([{ ...rows[0], latest: '0.187.0' }], api)).toBe('updated');
    expect(api.update).toHaveBeenCalledWith(12, expect.objectContaining({ body: expect.stringContaining('0.187.0') }));
    api.list.mockClear();
    expect(await publishReport([], api)).toBe('current');
    expect(api.list).not.toHaveBeenCalled();
  });
});

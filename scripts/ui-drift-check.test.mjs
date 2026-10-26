import { describe, it, expect } from 'vitest';
import { extractUiTokens, extractIconIds, diffTokens, diffIds, formatReport } from './ui-drift-check.mjs';

describe('ui drift check', () => {
  it('extracts --ui tokens, ignoring comments and other custom properties', () => {
    const css = ':root { --ui-r-sm: 5px; /* --ui-fake: 1px; */ --cad-accent: #fff; --ui-s-1:  4px ; }';
    expect(extractUiTokens(css)).toEqual({ '--ui-r-sm': '5px', '--ui-s-1': '4px' });
  });

  it('extracts the icon id union', () => {
    expect(extractIconIds('export type ToolbarIconId =\n  | "fit"\n  | "add";\nconst x = "no";')).toEqual(['add', 'fit']);
    expect(extractIconIds('nothing here')).toEqual([]);
  });

  it('reports only-here, only-there and changed tokens', () => {
    const d = diffTokens({ '--ui-a': '1', '--ui-b': '2', '--ui-c': '3' }, { '--ui-b': '9', '--ui-c': '3', '--ui-d': '4' });
    expect(d).toEqual({ onlyHere: ['--ui-a'], onlyThere: ['--ui-d'], changed: [{ name: '--ui-b', here: '2', there: '9' }] });
  });

  it('reports icon id differences and a clean report when in sync', () => {
    expect(diffIds(['a', 'b'], ['b', 'c'])).toEqual({ onlyHere: ['a'], onlyThere: ['c'] });
    expect(formatReport(diffTokens({}, {}), diffIds([], []))).toBe('Tokens: in sync\nIcons: in sync');
  });
});

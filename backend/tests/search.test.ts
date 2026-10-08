import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  extractSearchQueries,
  stripSearchQueries,
  formatSearchResults,
  normalizeProvider,
  webSearch,
  clearSearchCache,
} from '../src/engine/search.js';

const ddgResp = (topics: Array<{ Text?: string; FirstURL?: string }>) => ({
  ok: true,
  json: async () => ({ RelatedTopics: topics }),
});

const wikiResp = (search: Array<{ title: string; snippet?: string }>) => ({
  ok: true,
  json: async () => ({ query: { search } }),
});

afterEach(() => {
  vi.unstubAllGlobals();
  clearSearchCache();
});

describe('search sentinel parsing', () => {
  it('extracts one query per SEARCH line, tolerating brackets and quotes', () => {
    const text = 'Let me look that up.\nSEARCH: latest fedora release\n[SEARCH: "node 22 changelog"]\nthanks';
    expect(extractSearchQueries(text)).toEqual(['latest fedora release', 'node 22 changelog']);
  });

  it('ignores prose that merely mentions the word search', () => {
    expect(extractSearchQueries('I will search for an answer')).toEqual([]);
  });

  it('strips sentinel lines and collapses extra blank lines', () => {
    const text = 'Before.\nSEARCH: something\n\n\nAfter.';
    const stripped = stripSearchQueries(text);
    expect(stripped).not.toContain('SEARCH');
    expect(stripped).toBe('Before.\n\nAfter.');
  });

  it('formats a tool-result block with numbered results', () => {
    const block = formatSearchResults('q', [
      { title: 'T', url: 'https://x.example', snippet: 'S' },
    ]);
    expect(block).toContain('[KEYGATE TOOL RESULT — web search]');
    expect(block).toContain('1. T — https://x.example');
    expect(block).toContain('[/KEYGATE TOOL RESULT]');
  });

  it('normalizes unknown providers to duckduckgo', () => {
    expect(normalizeProvider('wikipedia')).toBe('wikipedia');
    expect(normalizeProvider('bing')).toBe('duckduckgo');
    expect(normalizeProvider(undefined)).toBe('duckduckgo');
  });
});

describe('webSearch', () => {
  it('uses DuckDuckGo and skips Wikipedia when enough results', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes('duckduckgo')) {
        return ddgResp([
          { Text: 'A - first', FirstURL: 'https://a.example' },
          { Text: 'B - second', FirstURL: 'https://b.example' },
        ]);
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const res = await webSearch('hello', { maxResults: 2 });
    expect(res).toHaveLength(2);
    expect(res[0]?.url).toBe('https://a.example');
    expect(res[0]?.title).toBe('A');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('falls back to Wikipedia when DuckDuckGo returns nothing', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes('duckduckgo')) return ddgResp([]);
      if (String(url).includes('wikipedia')) return wikiResp([{ title: 'Node.js', snippet: '<b>Node</b> runtime' }]);
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const res = await webSearch('node js', { maxResults: 3 });
    expect(res).toHaveLength(1);
    expect(res[0]?.title).toBe('Node.js');
    expect(res[0]?.snippet).toBe('Node runtime');
  });

  it('caches repeated identical queries', async () => {
    const fetchMock = vi.fn(async () =>
      ddgResp([{ Text: 'A - first', FirstURL: 'https://a.example' }])
    );
    vi.stubGlobal('fetch', fetchMock);

    await webSearch('cached query', { maxResults: 1 });
    await webSearch('cached query', { maxResults: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns an empty list when the backend fails, never throwing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('network down');
    }));
    await expect(webSearch('anything')).resolves.toEqual([]);
  });
});
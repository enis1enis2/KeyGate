import type { SearchProviderId } from '../types/index.js';

// DECISION: Online search uses only keyless, free backends (DuckDuckGo + Wikipedia) so an operator
// can enable it per pool without provisioning an API key. Every call is best-effort: a search
// failure degrades to "answer without results" and never fails the user's completion.

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface WebSearchOptions {
  provider?: string;
  maxResults?: number;
  timeoutMs?: number;
}

const SEARCH_TIMEOUT_MS = 8000;
const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, { at: number; results: SearchResult[] }>();

// The sentinel the model is instructed to emit when it needs fresh information. A line looks like
// `SEARCH: latest fedora release` (a wrapping [ ] is tolerated).
const SEARCH_SENTINEL_LINE = /^\s*\[?\s*SEARCH\s*:\s*(.+?)\s*\]?\s*$/i;

export function extractSearchQueries(text: string): string[] {
  const queries: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = SEARCH_SENTINEL_LINE.exec(line);
    if (!match || !match[1]) continue;
    const query = match[1].trim().replace(/^["'`]|["'`]$/g, '').trim();
    if (query) queries.push(query);
  }
  return queries;
}

// Remove sentinel lines from model text so the client (and the model's own history) never sees the
// control syntax. Keeps surrounding prose intact.
export function stripSearchQueries(text: string): string {
  const kept = text
    .split(/\r?\n/)
    .filter((line) => !SEARCH_SENTINEL_LINE.test(line))
    .join('\n');
  return kept.replace(/\n{3,}/g, '\n\n').trim();
}

export function buildSearchSystemPrompt(): string {
  return [
    'You have live web access through the KeyGate gateway.',
    'When (and only when) the answer depends on current, niche, or verifiable information, you may',
    'request a web search by writing a single line exactly like:',
    'SEARCH: your search query',
    'You will then receive the results inside a [KEYGATE TOOL RESULT — web search] block and must',
    'use them to answer. Rules:',
    '- Emit at most one SEARCH line per reply, and only the line itself — no prose next to it.',
    '- Never invent search results; wait for the tool result block.',
    '- If you already know the answer or the question is conversational, answer directly without searching.',
  ].join('\n');
}

export function buildSearchDisabledNotice(): string {
  return [
    'Online web access is currently disabled for this model.',
    'If the user asks you to search the web or look something up online, tell them online access is',
    'disabled and that they can enable it from the KeyGate UI.',
  ].join('\n');
}

export function formatSearchResults(query: string, results: SearchResult[]): string {
  const lines: string[] = ['[KEYGATE TOOL RESULT — web search]', `Query: "${query}"`];
  if (results.length === 0) {
    lines.push('No results were found for this query.');
  } else {
    results.forEach((r, i) => {
      lines.push(`${i + 1}. ${r.title} — ${r.url}`);
      if (r.snippet) lines.push(`   ${r.snippet}`);
    });
  }
  lines.push('[/KEYGATE TOOL RESULT]');
  return lines.join('\n');
}

function decodeEntities(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

function stripHtml(value: string): string {
  return decodeEntities(value.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
}

interface DdgTopic {
  Text?: string;
  FirstURL?: string;
  Topics?: DdgTopic[];
}

interface DdgResponse {
  Heading?: string;
  AbstractText?: string;
  AbstractURL?: string;
  Results?: DdgTopic[];
  RelatedTopics?: DdgTopic[];
}

function flattenTopics(topics: DdgTopic[] | undefined, out: SearchResult[]): void {
  if (!topics) return;
  for (const topic of topics) {
    if (topic.Topics && topic.Topics.length > 0) {
      flattenTopics(topic.Topics, out);
      continue;
    }
    if (topic.Text && topic.FirstURL) {
      out.push({ title: topic.Text.split(' - ')[0] || topic.Text, url: topic.FirstURL, snippet: topic.Text });
    }
  }
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function duckduckgoSearch(query: string, maxResults: number, timeoutMs: number): Promise<SearchResult[]> {
  const params = new URLSearchParams({ q: query, format: 'json', no_html: '1', skip_disambig: '1' });
  const res = await fetchWithTimeout(
    `https://api.duckduckgo.com/?${params.toString()}`,
    { method: 'GET', headers: { Accept: 'application/json' } },
    timeoutMs
  );
  if (!res.ok) return [];
  const data = (await res.json()) as DdgResponse;
  const results: SearchResult[] = [];
  if (data.AbstractText && data.AbstractURL) {
    results.push({ title: data.Heading || query, url: data.AbstractURL, snippet: data.AbstractText });
  }
  for (const r of data.Results ?? []) {
    if (r.Text && r.FirstURL) results.push({ title: r.Text, url: r.FirstURL, snippet: r.Text });
  }
  flattenTopics(data.RelatedTopics, results);
  return results.slice(0, maxResults);
}

interface WikiSearchResponse {
  query?: { search?: Array<{ title?: string; snippet?: string }> };
}

async function wikipediaSearch(query: string, maxResults: number, timeoutMs: number): Promise<SearchResult[]> {
  const params = new URLSearchParams({
    action: 'query',
    list: 'search',
    srsearch: query,
    format: 'json',
    origin: '*',
    srlimit: String(maxResults),
  });
  const res = await fetchWithTimeout(
    `https://en.wikipedia.org/w/api.php?${params.toString()}`,
    { method: 'GET', headers: { Accept: 'application/json' } },
    timeoutMs
  );
  if (!res.ok) return [];
  const data = (await res.json()) as WikiSearchResponse;
  const hits = data.query?.search ?? [];
  return hits
    .filter((h): h is { title: string; snippet?: string } => typeof h.title === 'string')
    .map((h) => ({
      title: h.title,
      url: `https://en.wikipedia.org/wiki/${encodeURIComponent(h.title.replace(/ /g, '_'))}`,
      snippet: h.snippet ? stripHtml(h.snippet) : '',
    }))
    .slice(0, maxResults);
}

function mergeResults(primary: SearchResult[], secondary: SearchResult[], maxResults: number): SearchResult[] {
  const seen = new Set<string>();
  const merged: SearchResult[] = [];
  for (const r of [...primary, ...secondary]) {
    const key = r.url.toLowerCase();
    if (!r.url || seen.has(key)) continue;
    seen.add(key);
    merged.push(r);
    if (merged.length >= maxResults) break;
  }
  return merged;
}

export function normalizeProvider(provider: string | undefined): SearchProviderId {
  return provider === 'wikipedia' ? 'wikipedia' : 'duckduckgo';
}

// Best-effort web search. No throw: an unavailable backend yields an empty result list.
export async function webSearch(query: string, opts: WebSearchOptions = {}): Promise<SearchResult[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];
  const provider = normalizeProvider(opts.provider);
  const maxResults = Math.max(1, Math.min(10, opts.maxResults ?? 3));
  const timeoutMs = opts.timeoutMs ?? SEARCH_TIMEOUT_MS;

  const cacheKey = `${provider}:${maxResults}:${trimmed.toLowerCase()}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.results;

  let results: SearchResult[] = [];
  try {
    if (provider === 'wikipedia') {
      results = await wikipediaSearch(trimmed, maxResults, timeoutMs);
    } else {
      results = await duckduckgoSearch(trimmed, maxResults, timeoutMs).catch(() => []);
      if (results.length < maxResults) {
        const wiki = await wikipediaSearch(trimmed, maxResults, timeoutMs).catch(() => []);
        results = mergeResults(results, wiki, maxResults);
      }
    }
  } catch {
    return [];
  }

  cache.set(cacheKey, { at: Date.now(), results });
  return results;
}

export function clearSearchCache(): void {
  cache.clear();
}
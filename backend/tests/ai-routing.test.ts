import { describe, it, expect } from 'vitest';
import {
  classifyComplexity,
  lastUserText,
  orderTargetsByPick,
  orderTargetsByTier,
  targetTierNames,
} from '../src/engine/targeting.js';
import type { OpenAIMessage, TargetConfig } from '../src/types/index.js';

const health = () => 1;

describe('classifyComplexity', () => {
  it('treats greetings and short factual questions as cheap', () => {
    expect(classifyComplexity('hello')).toBe('cheap');
    expect(classifyComplexity('what is the capital of France?')).toBe('cheap');
  });

  it('treats reasoning and code requests as strong', () => {
    expect(classifyComplexity('Prove that the halting problem is undecidable, step by step.')).toBe('strong');
    expect(classifyComplexity('Here is a stack trace:\n```\nTypeError at line 4\n```')).toBe('strong');
    expect(classifyComplexity('x'.repeat(3000))).toBe('strong');
  });

  it('treats mid-length prompts as medium', () => {
    const prompt = 'I am drafting an internal note about our quarterly planning process and would like a clearer structure. Could you suggest an outline for it?';
    expect(classifyComplexity(prompt)).toBe('medium');
  });
});

describe('lastUserText', () => {
  it('returns the most recent user message, ignoring assistant turns', () => {
    const messages: OpenAIMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'reply' },
      { role: 'user', content: 'second' },
      { role: 'assistant', content: 'answer' },
    ];
    expect(lastUserText(messages)).toBe('second');
  });

  it('handles array content parts', () => {
    const messages: OpenAIMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'part one' }, { text: 'two' }] as never },
    ];
    expect(lastUserText(messages)).toBe('part one two');
  });
});

describe('tier ordering', () => {
  const targets: TargetConfig[] = [
    { provider_id: 'p-strong', model: 'big', weight: 1, priority: 1, tier: 'strong' },
    { provider_id: 'p-cheap', model: 'small', weight: 1, priority: 2, tier: 'cheap' },
    { provider_id: 'p-untiered', model: 'misc', weight: 1, priority: 3 },
  ];

  it('lists distinct tier names in encounter order', () => {
    expect(targetTierNames(targets)).toEqual(['strong', 'cheap']);
  });

  it('places the chosen tier first and keeps the rest as failover', () => {
    const ordered = orderTargetsByTier(targets, 'cheap', health);
    expect(ordered[0]?.provider_id).toBe('p-cheap');
    expect(ordered).toHaveLength(3);
  });

  it('brings a classifier-chosen target to the front', () => {
    const chosen = targets[1]!;
    const ordered = orderTargetsByPick(targets, chosen, health);
    expect(ordered[0]?.provider_id).toBe('p-cheap');
    expect(ordered).toHaveLength(3);
  });
});
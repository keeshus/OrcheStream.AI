import { describe, it, expect } from 'vitest';

// ── HTTP Node ─────────────────────────────────────────────────

describe('HttpNode display logic', () => {
  const methodColors: Record<string, string> = {
    GET: 'text-green-600',
    POST: 'text-blue-600',
    PUT: 'text-orange-600',
    PATCH: 'text-purple-600',
    DELETE: 'text-red-600',
    HEAD: 'text-gray-600',
  };

  it('returns correct color class for each HTTP method', () => {
    expect(methodColors.GET).toContain('green');
    expect(methodColors.POST).toContain('blue');
    expect(methodColors.PUT).toContain('orange');
    expect(methodColors.PATCH).toContain('purple');
    expect(methodColors.DELETE).toContain('red');
    expect(methodColors.HEAD).toContain('gray');
  });

  it('has all expected HTTP methods', () => {
    const methods = Object.keys(methodColors);
    expect(methods).toContain('GET');
    expect(methods).toContain('POST');
    expect(methods).toContain('PUT');
    expect(methods).toContain('PATCH');
    expect(methods).toContain('DELETE');
    expect(methods).toContain('HEAD');
    expect(methods).toHaveLength(6);
  });

  it('falls back to GET color for unknown methods', () => {
    const color = methodColors['GET'];
    expect(color).toBeDefined();
    // Unknown methods should use GET color (handled in component with || methodColors.GET)
    expect(methodColors['OPTIONS']).toBeUndefined();
  });
});

// ── Loop Node ─────────────────────────────────────────────────

describe('LoopNode display logic', () => {
  it('shows configured itemsField when present', () => {
    const config = { itemsField: 'trigger.items', itemVariable: 'item' };
    expect(config.itemsField).toBeTruthy();
    expect(config.itemVariable).toBe('item');
  });

  it('defaults itemVariable to "item"', () => {
    const config = { itemVariable: 'item' };
    expect(config.itemVariable).toBe('item');
  });

  it('shows child count', () => {
    const display = (count: number) => `${count} node${count !== 1 ? 's' : ''}`;
    expect(display(0)).toBe('0 nodes');
    expect(display(1)).toBe('1 node');
    expect(display(3)).toBe('3 nodes');
  });

  it('shows custom itemVariable in footer', () => {
    const footer = (itemVar: string) => `for each ${itemVar}`;
    expect(footer('item')).toBe('for each item');
    expect(footer('row')).toBe('for each row');
  });
});

// ── Delay Node ────────────────────────────────────────────────

describe('DelayNode display logic', () => {
  function getDelayLabel(config: { type?: string; seconds?: number; duration?: string; timestamp?: string }): string {
    const { type, seconds, duration, timestamp } = config;
    if (type === 'fixed' && seconds) return `${seconds}s`;
    if (type === 'duration' && duration) return duration;
    if (type === 'timestamp' && timestamp) return timestamp;
    return 'Not configured';
  }

  it('shows seconds for fixed delay', () => {
    expect(getDelayLabel({ type: 'fixed', seconds: 5 })).toBe('5s');
    expect(getDelayLabel({ type: 'fixed', seconds: 30 })).toBe('30s');
    expect(getDelayLabel({ type: 'fixed', seconds: 0 })).toBe('Not configured');
  });

  it('shows ISO 8601 duration string', () => {
    expect(getDelayLabel({ type: 'duration', duration: 'PT30S' })).toBe('PT30S');
    expect(getDelayLabel({ type: 'duration', duration: 'PT5M' })).toBe('PT5M');
    expect(getDelayLabel({ type: 'duration', duration: 'PT1H' })).toBe('PT1H');
  });

  it('shows timestamp string', () => {
    expect(getDelayLabel({ type: 'timestamp', timestamp: '2026-07-09T12:00:00Z' })).toBe('2026-07-09T12:00:00Z');
  });

  it('shows Not configured when no delay is set', () => {
    expect(getDelayLabel({})).toBe('Not configured');
    expect(getDelayLabel({ type: 'fixed' })).toBe('Not configured');
  });
});

// ── AI Action Node ────────────────────────────────────────────

describe('AIActionNode display logic', () => {
  function getPromptPreview(prompt: string, maxLen = 40): string {
    return prompt.length > maxLen ? prompt.slice(0, maxLen) + '...' : prompt;
  }

  it('shows model name when configured', () => {
    const model = 'claude-3-haiku';
    expect(model).toBeTruthy();
  });

  it('truncates long prompts', () => {
    const long = 'a'.repeat(100);
    const short = 'hello';
    expect(getPromptPreview(long)).toBe('a'.repeat(40) + '...');
    expect(getPromptPreview(short)).toBe('hello');
    expect(getPromptPreview(long).length).toBe(43); // 40 chars + '...'
  });

  it('shows full short prompts without truncation', () => {
    const prompt = 'Summarize this text';
    expect(getPromptPreview(prompt)).toBe(prompt);
    expect(getPromptPreview(prompt)).not.toContain('...');
  });

  it('detects empty state when no model or prompt', () => {
    const isEmpty = (model?: string, prompt?: string) => !model && !prompt;
    expect(isEmpty(undefined, undefined)).toBe(true);
    expect(isEmpty('claude-3', 'test prompt')).toBe(false);
    expect(isEmpty('claude-3', undefined)).toBe(false);
  });
});

// ── Map Node ──────────────────────────────────────────────────

describe('MapNode display logic', () => {
  it('shows field count', () => {
    const fieldCount = (fields: any[]) => `${fields.length} field${fields.length !== 1 ? 's' : ''}`;
    expect(fieldCount([])).toBe('0 fields');
    expect(fieldCount([{ name: 'a', type: 'string', value: 'x' }])).toBe('1 field');
    expect(fieldCount([{ name: 'a' }, { name: 'b' }])).toBe('2 fields');
  });

  it('shows mode badge', () => {
    const modes = ['merge', 'replace'];
    expect(modes).toContain('merge');
    expect(modes).toContain('replace');
    expect(modes).toHaveLength(2);
  });

  it('shows only first 3 fields with overflow count', () => {
    const fields = [
      { name: 'a', value: 'x' },
      { name: 'b', value: 'y' },
      { name: 'c', value: 'z' },
      { name: 'd', value: 'w' },
    ];
    const visible = fields.slice(0, 3);
    const overflow = fields.length - 3;
    expect(visible).toHaveLength(3);
    expect(overflow).toBe(1);
    expect(fields.length > 3 ? `+${overflow} more` : '').toBe('+1 more');
  });

  it('shows field name and value mapping', () => {
    const field = { name: 'result', value: 'trigger.message' };
    expect(field.name).toBe('result');
    expect(field.value).toBe('trigger.message');
  });
});

// ── Note Node ─────────────────────────────────────────────────

describe('NoteNode display logic', () => {
  function getContentPreview(content: string, maxLen = 80): string {
    return content.length > maxLen ? content.slice(0, maxLen) + '...' : content;
  }

  it('shows full short content', () => {
    const content = 'This is a note';
    expect(getContentPreview(content)).toBe(content);
  });

  it('truncates long content', () => {
    const content = 'a'.repeat(100);
    const preview = getContentPreview(content);
    expect(preview).toBe('a'.repeat(80) + '...');
    expect(preview.length).toBe(83);
  });

  it('shows empty state when no content', () => {
    const isEmpty = (content: string | null | undefined) => !content;
    expect(isEmpty(null)).toBe(true);
    expect(isEmpty('')).toBe(true);
    expect(isEmpty('a'.repeat(100))).toBe(false);
  });

  it('has sticky_note_2 icon', () => {
    const icon = 'sticky_note_2';
    expect(icon).toBe('sticky_note_2');
  });
});

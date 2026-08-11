import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { getUpstreamNodeIds, getNodeFields, getNodeRawFallback, accumulateUpstream, fieldsToLines, InputPreview } from '@/components/flow/config/InputPreview';

describe('getUpstreamNodeIds', () => {
  it('returns empty array for node with no incoming edges', () => {
    const edges = [{ source: 'a', target: 'b' }];
    expect(getUpstreamNodeIds('a', edges)).toEqual([]);
  });

  it('returns direct upstream node', () => {
    const edges = [{ source: 'a', target: 'b' }];
    expect(getUpstreamNodeIds('b', edges)).toEqual(['a']);
  });

  it('returns chain of upstream nodes', () => {
    const edges = [
      { source: 'a', target: 'b' },
      { source: 'b', target: 'c' },
    ];
    const result = getUpstreamNodeIds('c', edges);
    expect(result).toContain('b');
    expect(result).toContain('a');
  });

  it('handles nodes with no edges', () => {
    expect(getUpstreamNodeIds('a', [])).toEqual([]);
  });

  it('handles null/undefined nodeId', () => {
    const edges = [{ source: 'a', target: 'b' }];
    expect(getUpstreamNodeIds('', edges)).toEqual([]);
    expect(getUpstreamNodeIds(undefined as any, edges)).toEqual([]);
  });

  it('skips tool-input edges', () => {
    const edges = [
      { source: 'a', target: 'b' },
      { source: 'tool', target: 'b', targetHandle: 'tool-input-0' },
    ];
    expect(getUpstreamNodeIds('b', edges)).toEqual(['a']);
  });
});

describe('getNodeFields', () => {
  it('returns chat trigger fields', () => {
    const node = { data: { type: 'trigger', config: { triggerType: 'chat' } } };
    const fields = getNodeFields(node);
    expect(fields).toHaveLength(2);
    expect(fields[0]).toEqual({ name: 'message', type: 'string', required: true });
  });

  it('returns webhook trigger fields from inputSchema', () => {
    const node = { data: { type: 'trigger', config: { triggerType: 'webhook', inputSchema: '{"name":"string","age":"number"}' } } };
    const fields = getNodeFields(node);
    expect(fields).toHaveLength(2);
    expect(fields[0]).toEqual({ name: 'name', type: 'string', required: true });
  });

  it('returns webhook trigger fields from parsed inputSchema object', () => {
    const node = { data: { type: 'trigger', config: { triggerType: 'webhook', inputSchema: { email: 'string' } } } };
    const fields = getNodeFields(node);
    expect(fields).toHaveLength(1);
    expect(fields[0]).toEqual({ name: 'email', type: 'string', required: true });
  });

  it('returns default trigger fields for unknown trigger type', () => {
    const node = { data: { type: 'trigger', config: { triggerType: 'manual' } } };
    const fields = getNodeFields(node);
    expect(fields).toEqual([{ name: 'message', type: 'any', required: true }]);
  });

  it('returns llm-agent fields with output schema', () => {
    const node = {
      data: {
        type: 'llm-agent',
        config: {
          responseFormat: 'json_object',
          outputSchema: '{"type":"object","properties":{"summary":{"type":"string"},"score":{"type":"number"}},"required":["summary"]}',
        },
      },
    };
    const fields = getNodeFields(node);
    expect(fields.length).toBeGreaterThan(1);
    expect(fields.find(f => f.name === 'summary')).toBeDefined();
    expect(fields.find(f => f.name === 'score')).toBeDefined();
  });

  it('returns llm-agent fields from parsed outputSchema object', () => {
    const node = {
      data: {
        type: 'llm-agent',
        config: {
          responseFormat: 'json_object',
          outputSchema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] },
        },
      },
    };
    const fields = getNodeFields(node);
    expect(fields).toHaveLength(2);
    expect(fields.find(f => f.name === 'title')?.required).toBe(true);
  });

  it('returns llm-agent fields without output schema', () => {
    const node = { data: { type: 'llm-agent', config: {} } };
    const fields = getNodeFields(node);
    expect(fields).toEqual([{ name: 'content', type: 'string', required: true }]);
  });

  it('returns mcp-tool fields', () => {
    const node = { data: { type: 'mcp-tool', config: {} } };
    const fields = getNodeFields(node);
    expect(fields).toHaveLength(3);
  });

  it('returns retriever fields', () => {
    const node = { data: { type: 'retriever', config: {} } };
    const fields = getNodeFields(node);
    expect(fields).toHaveLength(4);
  });

  it('returns condition fields', () => {
    const node = { data: { type: 'condition', config: {} } };
    const fields = getNodeFields(node);
    expect(fields).toHaveLength(2);
  });

  it('returns code fields from outputSchema', () => {
    const node = {
      data: {
        type: 'code',
        config: {
          outputSchema: '{"type":"object","properties":{"result":{"type":"string"}}}',
        },
      },
    };
    const fields = getNodeFields(node);
    expect(fields).toHaveLength(1);
    expect(fields[0].name).toBe('result');
  });

  it('returns code fields from parsed outputSchema object', () => {
    const node = {
      data: {
        type: 'code',
        config: {
          outputSchema: { type: 'object', properties: { output: { type: 'number' } } },
        },
      },
    };
    const fields = getNodeFields(node);
    expect(fields).toHaveLength(1);
    expect(fields[0]).toEqual({ name: 'output', type: 'number', required: true });
  });

  it('returns empty array for code without outputSchema', () => {
    const node = { data: { type: 'code', config: {} } };
    expect(getNodeFields(node)).toEqual([]);
  });

  it('returns parallel fields', () => {
    const node = { data: { type: 'parallel', config: {} } };
    const fields = getNodeFields(node);
    expect(fields).toHaveLength(2);
  });

  it('returns empty array for output node', () => {
    const node = { data: { type: 'output', config: {} } };
    expect(getNodeFields(node)).toEqual([]);
  });

  it('returns hitl fields', () => {
    const node = { data: { type: 'hitl', config: {} } };
    const fields = getNodeFields(node);
    expect(fields).toHaveLength(3);
  });

  it('returns empty array for unknown node type', () => {
    const node = { data: { type: 'unknown', config: {} } };
    expect(getNodeFields(node)).toEqual([]);
  });

  it('handles null/undefined node', () => {
    expect(getNodeFields(null)).toEqual([]);
    expect(getNodeFields(undefined as any)).toEqual([]);
  });

  it('handles invalid JSON in inputSchema gracefully', () => {
    const node = { data: { type: 'trigger', config: { triggerType: 'webhook', inputSchema: 'not-json{' } } };
    const fields = getNodeFields(node);
    expect(fields).toEqual([{ name: 'message', type: 'any', required: true }]);
  });

  it('handles invalid JSON in outputSchema gracefully', () => {
    const node = { data: { type: 'code', config: { outputSchema: 'not-json{' } } };
    expect(getNodeFields(node)).toEqual([]);
  });

  it('handles llm-agent with invalid outputSchema JSON gracefully', () => {
    const node = { data: { type: 'llm-agent', config: { responseFormat: 'json_object', outputSchema: 'bad{' } } };
    const fields = getNodeFields(node);
    expect(fields).toEqual([{ name: 'content', type: 'string', required: true }]);
  });

  it('handles llm-agent property without type', () => {
    const node = {
      data: {
        type: 'llm-agent',
        config: {
          responseFormat: 'json_object',
          outputSchema: { type: 'object', properties: { untagged: {} }, required: ['untagged'] },
        },
      },
    };
    const fields = getNodeFields(node);
    const untagged = fields.find(f => f.name === 'untagged');
    expect(untagged?.type).toBe('any');
  });

  it('handles llm-agent outputSchema without required array', () => {
    const node = {
      data: {
        type: 'llm-agent',
        config: {
          responseFormat: 'json_object',
          outputSchema: { type: 'object', properties: { opt: { type: 'string' } } },
        },
      },
    };
    const fields = getNodeFields(node);
    const opt = fields.find(f => f.name === 'opt');
    expect(opt?.required).toBe(true);
  });

  it('handles code property without type', () => {
    const node = {
      data: {
        type: 'code',
        config: {
          outputSchema: { type: 'object', properties: { raw: {} } },
        },
      },
    };
    const fields = getNodeFields(node);
    expect(fields).toHaveLength(1);
    expect(fields[0].type).toBe('any');
  });
});

describe('getNodeRawFallback', () => {
  it('returns fallback for code node without outputSchema', () => {
    const node = { data: { type: 'code', config: {} } };
    expect(getNodeRawFallback(node)).toBe('any (determined by return value)');
  });

  it('returns null for code node with outputSchema', () => {
    const node = { data: { type: 'code', config: { outputSchema: '{"type":"object"}' } } };
    expect(getNodeRawFallback(node)).toBeNull();
  });

  it('returns pass-through for output node', () => {
    const node = { data: { type: 'output', config: {} } };
    expect(getNodeRawFallback(node)).toBe('(pass-through — same as input)');
  });

  it('returns null for other node types', () => {
    const node = { data: { type: 'trigger', config: {} } };
    expect(getNodeRawFallback(node)).toBeNull();
  });

  it('handles null node', () => {
    expect(getNodeRawFallback(null)).toBeNull();
  });
});

describe('fieldsToLines', () => {
  it('formats required fields', () => {
    const fields = [
      { name: 'message', type: 'string', required: true },
      { name: 'count', type: 'number', required: true },
    ];
    const result = fieldsToLines(fields);
    expect(result).toContain('message');
    expect(result).toContain('count');
    expect(result).toContain(': string');
    expect(result).toContain(': number');
    expect(result).not.toContain('?');
  });

  it('formats optional fields with question mark', () => {
    const fields = [
      { name: 'name', type: 'string', required: false },
    ];
    const result = fieldsToLines(fields);
    expect(result).toContain('name?');
  });

  it('handles empty fields array', () => {
    expect(fieldsToLines([])).toBe('{\n}');
  });

  it('wraps fields in braces', () => {
    const result = fieldsToLines([{ name: 'x', type: 'string', required: true }]);
    expect(result).toMatch(/^\{[\s\S]*\}$/);
  });
});

describe('accumulateUpstream', () => {
  const edges = [
    { source: 'a', target: 'c' },
    { source: 'b', target: 'c' },
  ];
  const nodes = [
    { id: 'a', data: { label: 'Node A', type: 'trigger', config: { triggerType: 'chat' } } },
    { id: 'b', data: { label: 'Node B', type: 'code', config: {} } },
  ];

  it('returns shapes for upstream nodes', () => {
    const result = accumulateUpstream('c', edges, nodes);
    expect(result).toHaveLength(2);
    expect(result[0].label).toBe('Node A');
    expect(result[0].nodeId).toBe('a');
    expect(result[0].fields.length).toBeGreaterThan(0);
    expect(result[0].raw).toBeNull();
  });

  it('includes raw fallback for code node', () => {
    const result = accumulateUpstream('c', edges, nodes);
    const codeNode = result.find(r => r.nodeId === 'b');
    expect(codeNode?.raw).toBe('any (determined by return value)');
  });

  it('handles node not found gracefully', () => {
    const result = accumulateUpstream('c', [{ source: 'ghost', target: 'c' }], nodes);
    const ghost = result.find(r => r.nodeId === 'ghost');
    expect(ghost).toBeDefined();
    expect(ghost?.fields).toEqual([]);
    expect(ghost?.raw).toBeNull();
  });

  it('uses type as fallback label when label is missing', () => {
    const nodesNoLabel = [
      { id: 'x', data: { type: 'trigger', config: { triggerType: 'chat' } } },
    ];
    const result = accumulateUpstream('y', [{ source: 'x', target: 'y' }], nodesNoLabel);
    expect(result[0].label).toBe('trigger');
  });

  it('uses id as fallback label when both label and type are missing', () => {
    const nodesNoData = [{ id: 'orphan', data: {} }];
    const result = accumulateUpstream('y', [{ source: 'orphan', target: 'y' }], nodesNoData);
    expect(result[0].label).toBe('orphan');
  });
});

describe('InputPreview component', () => {
  it('renders nothing when there are no upstream nodes', () => {
    const { container } = render(
      <InputPreview edges={[]} nodes={[]} selectedNodeId="root" />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders upstream node label and id', () => {
    const nodes = [
      { id: 'a', data: { label: 'Trigger', type: 'trigger', config: { triggerType: 'chat' } } },
    ];
    const edges = [{ source: 'a', target: 'b' }];
    render(<InputPreview edges={edges} nodes={nodes} selectedNodeId="b" />);
    expect(screen.getByText('Trigger')).toBeInTheDocument();
    expect(screen.getByText('(a)')).toBeInTheDocument();
  });

  it('renders raw fallback for code node', () => {
    const nodes = [
      { id: 'a', data: { label: 'Code', type: 'code', config: {} } },
    ];
    const edges = [{ source: 'a', target: 'b' }];
    render(<InputPreview edges={edges} nodes={nodes} selectedNodeId="b" />);
    expect(screen.getByText(/any \(determined by return value\)/)).toBeInTheDocument();
  });

  it('renders structured fields as formatted code block', () => {
    const nodes = [
      { id: 'a', data: { label: 'Trigger', type: 'trigger', config: { triggerType: 'chat' } } },
    ];
    const edges = [{ source: 'a', target: 'b' }];
    render(<InputPreview edges={edges} nodes={nodes} selectedNodeId="b" />);
    const pre = document.querySelector('pre');
    expect(pre?.textContent).toContain('message');
    expect(pre?.textContent).toContain('history');
  });

  it('renders raw fallback text for output node', () => {
    const nodes = [
      { id: 'a', data: { label: 'Out', type: 'output', config: {} } },
    ];
    const edges = [{ source: 'a', target: 'b' }];
    render(<InputPreview edges={edges} nodes={nodes} selectedNodeId="b" />);
    expect(screen.getByText(/pass-through/)).toBeInTheDocument();
  });

  it('renders "no structured fields" for unknown node type', () => {
    const nodes = [
      { id: 'a', data: { label: 'Unknown', type: 'unknown', config: {} } },
    ];
    const edges = [{ source: 'a', target: 'b' }];
    render(<InputPreview edges={edges} nodes={nodes} selectedNodeId="b" />);
    expect(screen.getByText('(no structured fields)')).toBeInTheDocument();
  });

  it('renders accumulated input section', () => {
    const nodes = [
      { id: 'a', data: { label: 'Trigger', type: 'trigger', config: { triggerType: 'chat' } } },
    ];
    const edges = [{ source: 'a', target: 'b' }];
    render(<InputPreview edges={edges} nodes={nodes} selectedNodeId="b" />);
    expect(screen.getByText('Accumulated Input')).toBeInTheDocument();
  });

  it('renders "no structured fields from upstream" when accumulated fields are empty', () => {
    const nodes = [
      { id: 'a', data: { label: 'Out', type: 'output', config: {} } },
    ];
    const edges = [{ source: 'a', target: 'b' }];
    render(<InputPreview edges={edges} nodes={nodes} selectedNodeId="b" />);
    expect(screen.getByText('(no structured fields from upstream)')).toBeInTheDocument();
  });

  it('renders checkboxes when inputFields is provided', () => {
    const nodes = [
      { id: 'a', data: { label: 'Trigger', type: 'trigger', config: { triggerType: 'chat' } } },
    ];
    const edges = [{ source: 'a', target: 'b' }];
    render(
      <InputPreview
        edges={edges}
        nodes={nodes}
        selectedNodeId="b"
        inputFields={['message', 'history']}
        filteredFields={['history']}
      />,
    );
    const checkboxes = document.querySelectorAll('input[type="checkbox"]');
    expect(checkboxes.length).toBeGreaterThan(0);
  });

  it('renders accumulated field names and types', () => {
    const nodes = [
      { id: 'a', data: { label: 'Trigger', type: 'trigger', config: { triggerType: 'chat' } } },
    ];
    const edges = [{ source: 'a', target: 'b' }];
    render(<InputPreview edges={edges} nodes={nodes} selectedNodeId="b" />);
    expect(screen.getByText('Accumulated Input')).toBeInTheDocument();
    const heading = screen.getByText('Accumulated Input');
    const section = heading.parentElement;
    expect(section?.textContent).toMatch(/message/);
    expect(section?.textContent).toMatch(/:string/);
  });

  it('deduplicates fields with same name from multiple upstream nodes', () => {
    const nodes = [
      { id: 'a', data: { label: 'A', type: 'trigger', config: { triggerType: 'chat' } } },
      { id: 'b', data: { label: 'B', type: 'trigger', config: { triggerType: 'chat' } } },
    ];
    const edges = [
      { source: 'a', target: 'c' },
      { source: 'b', target: 'c' },
    ];
    render(<InputPreview edges={edges} nodes={nodes} selectedNodeId="c" />);
    const heading = screen.getByText('Accumulated Input');
    const fieldContainer = heading.nextElementSibling;
    const fieldItems = fieldContainer?.children;
    expect(fieldItems?.length).toBe(2);
  });
});
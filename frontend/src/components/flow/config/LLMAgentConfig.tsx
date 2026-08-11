import { useEffect, useState } from 'react';
import { api } from '@/lib/api-client';
import { TextField } from '@/components/ui/TextField';
import { SelectField } from '@/components/ui/SelectField';
import { TemplateAutocomplete } from './TemplateAutocomplete';
import { JsonSchemaBuilder } from './JsonSchemaBuilder';
import { ThinkingModeSelect } from './ThinkingModeSelect';
import type { ThinkingMode } from 'orchestream-ai-shared/thinking';

const PROVIDER_LABELS: Record<string, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  litellm: 'LiteLLM',
};

interface LLMAgentConfigProps {
  config: {
    endpointId: string;
    model: string;
    systemPrompt: string;
    responseFormat: 'text' | 'json_object';
    outputSchema?: string;
    contextIds?: string[];
    thinkingMode?: ThinkingMode;
  };
  onChange: (config: any) => void;
  suggestions?: { upstreamLabels: string[]; nodes: any[]; edges: any[]; nodeId: string };
  flow?: { group_id?: string };
}

export function LLMAgentConfig({ config, onChange, suggestions, flow }: LLMAgentConfigProps) {
  const [endpoints, setEndpoints] = useState<any[]>([]);
  const [selectedEndpoint, setSelectedEndpoint] = useState<any>(null);
  const [agentContexts, setAgentContexts] = useState<any[]>([]);

  useEffect(() => {
    api.llmEndpoints.list().then(setEndpoints).catch(() => {});
  }, []);

  useEffect(() => {
    fetch('/api/agent-contexts', { credentials: 'include' })
      .then(r => r.ok ? r.json() : [])
      .then(setAgentContexts)
      .catch(() => {});
  }, []);

  useEffect(() => {
    const ep = endpoints.find((e: any) => e.id === config.endpointId);
    setSelectedEndpoint(ep || null);
  }, [config.endpointId, endpoints]);

  const filteredEndpoints = flow?.group_id
    ? endpoints.filter((ep: any) => !ep.group_id || ep.group_id === flow.group_id)
    : endpoints;

  const handleEndpointChange = (endpointId: string) => {
    const ep = endpoints.find((e: any) => e.id === endpointId);
    onChange({ ...config, endpointId, endpointName: ep?.name || '', model: ep?.default_model || '' });
  };

  const toggleContextId = (id: string) => {
    const current = config.contextIds || [];
    if (current.includes(id)) {
      onChange({ ...config, contextIds: current.filter(c => c !== id) });
    } else {
      onChange({ ...config, contextIds: [...current, id] });
    }
  };

  return (
    <div className="space-y-3">
      <div>
        <SelectField
          label="LLM Endpoint"
          value={config.endpointId}
          onChange={(v) => handleEndpointChange(v)}
          options={[
            { value: '', label: 'Select endpoint...' },
            ...filteredEndpoints.map((ep: any) => ({ value: ep.id, label: `${ep.name} (${PROVIDER_LABELS[ep.provider_type] || ep.provider_type})` })),
          ]}
        />
        {selectedEndpoint && (
          <span className="inline-block mt-1 text-[10px] px-1.5 py-0.5 rounded bg-primary-container text-primary">
            {PROVIDER_LABELS[selectedEndpoint.provider_type]}
          </span>
        )}
      </div>

      {selectedEndpoint && (
        <div>
          {selectedEndpoint.models?.length > 0 ? (
            <SelectField
              label="Model"
              value={config.model}
              onChange={(v) => onChange({ ...config, model: v })}
              options={[
                { value: '', label: 'Select model...' },
                ...selectedEndpoint.models.map((m: string) => ({ value: m, label: m })),
              ]}
            />
          ) : (
            <TextField
              label="Model"
              value={config.model}
              onChange={(v) => onChange({ ...config, model: v })}
              placeholder="e.g. claude-sonnet-4-20250514"
            />
          )}
        </div>
      )}

      {/* ── Agent Contexts selector (above System Prompt) ── */}
      {agentContexts.length > 0 && (
        <div>
          <span className="text-xs font-medium text-on-surface-variant block mb-1">Agent Contexts</span>
          <div className="bg-surface border border-outline-variant rounded-lg p-2 space-y-1 max-h-40 overflow-y-auto">
            {agentContexts.map(ctx => {
              const checked = (config.contextIds || []).includes(ctx.id);
              return (
                <label key={ctx.id} className="flex items-start gap-2 cursor-pointer hover:bg-surface-container rounded px-1 py-0.5">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggleContextId(ctx.id)}
                    className="mt-0.5 w-3 h-3 accent-primary shrink-0"
                  />
                  <div className="min-w-0">
                    <span className="text-xs font-medium text-on-surface block leading-tight">{ctx.title}</span>
                    {ctx.description && (
                      <span className="text-[10px] text-on-surface-variant block truncate">{ctx.description}</span>
                    )}
                  </div>
                </label>
              );
            })}
          </div>
          <p className="mt-1 text-[10px] text-on-surface-variant">Contexts are layered: global → group → flow → selected contexts → system prompt.</p>
        </div>
      )}

      <label className="block">
        <span className="text-xs font-medium text-on-surface-variant">System Prompt</span>
        <TemplateAutocomplete
          value={config.systemPrompt}
          onChange={(v) => onChange({ ...config, systemPrompt: v })}
          placeholder="You are a helpful assistant... Type {{ for field suggestions"
          rows={4}
          nodeId={suggestions?.nodeId}
          nodes={suggestions?.nodes || []}
          edges={suggestions?.edges || []}
          selectedFields={(config as any).inputFields}
        />
        <p className="mt-1 text-[10px] text-on-surface-variant">
          Only this prompt is sent to the model. Reference inputs with {'{{'}input.Label.field{'}}'} — nothing is added automatically. Chat flows: use {'{{'}input.message{'}}'} and {'{{'}input.history{'}}'}.
        </p>
      </label>

      <SelectField
        label="Response Format"
        value={config.responseFormat || 'text'}
        onChange={(v) => onChange({ ...config, responseFormat: v })}
        options={[
          { value: 'text', label: 'Plain Text' },
          { value: 'json_object', label: 'JSON' },
        ]}
      />

      <ThinkingModeSelect
        endpoint={selectedEndpoint}
        value={config.thinkingMode || 'default'}
        onChange={(mode) => onChange({ ...config, thinkingMode: mode })}
      />

      {config.responseFormat === 'json_object' && (
        <JsonSchemaBuilder
          value={config.outputSchema || ''}
          onChange={(v) => onChange({ ...config, outputSchema: v })}
          label="JSON Schema (optional)"
          helpText="Describes the expected JSON structure. Used as guidance in the system prompt — tool-calling ensures the output matches the schema across all providers."
        />
      )}
    </div>
  );
}

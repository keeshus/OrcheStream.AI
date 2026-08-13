import { useEffect, useState } from 'react';
import { api } from '@/lib/api-client';
import { TextField } from '@/components/ui/TextField';
import { SelectField } from '@/components/ui/SelectField';
import { TemplateAutocomplete } from './TemplateAutocomplete';
import { ThinkingModeSelect } from './ThinkingModeSelect';
import type { ThinkingMode } from 'orchestream-ai-shared/thinking';

const PROVIDER_LABELS: Record<string, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  litellm: 'LiteLLM',
};

interface AIActionConfigProps {
  config: {
    endpointId?: string;
    model?: string;
    prompt?: string;
    temperature?: number;
    thinkingMode?: ThinkingMode;
  };
  onChange: (config: any) => void;
  suggestions?: { upstreamLabels: string[]; nodes: any[]; edges: any[]; nodeId: string };
  flow?: { group_id?: string };
}

export function AIActionConfig({ config, onChange, suggestions, flow }: AIActionConfigProps) {
  const [endpoints, setEndpoints] = useState<any[]>([]);
  const [selectedEndpoint, setSelectedEndpoint] = useState<any>(null);

  useEffect(() => {
    api.llmEndpoints.list().then(setEndpoints).catch(() => {});
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

  return (
    <div className="space-y-3">
      <p className="text-xs text-on-surface-variant">
        Single LLM call — no tool loop, no context layering. Configure a prompt to transform upstream data.
      </p>

      <div>
        <SelectField
          label="LLM Endpoint"
          value={config.endpointId || ''}
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
              value={config.model || ''}
              onChange={(v) => onChange({ ...config, model: v })}
              options={[
                { value: '', label: 'Select model...' },
                ...selectedEndpoint.models.map((m: string) => ({ value: m, label: m })),
              ]}
            />
          ) : (
            <TextField
              label="Model"
              value={config.model || ''}
              onChange={(v) => onChange({ ...config, model: v })}
              placeholder="e.g. claude-sonnet-4-20250514"
            />
          )}
        </div>
      )}

      <label className="block">
        <span className="text-xs font-medium text-on-surface-variant">Prompt</span>
        <TemplateAutocomplete
          value={config.prompt || ''}
          onChange={(v) => onChange({ ...config, prompt: v })}
          placeholder="E.g. Summarize: {{input.Trigger.message}}"
          rows={4}
          nodeId={suggestions?.nodeId}
          nodes={suggestions?.nodes || []}
          edges={suggestions?.edges || []}
          selectedFields={(config as any).inputFields}
        />
        <p className="mt-1 text-[10px] text-on-surface-variant">
          Sent as the user message. Reference upstream data with {'{{'}input.Label.field{'}}'}.
        </p>
      </label>

      <TextField
        label="Temperature"
        value={String(config.temperature ?? 0.7)}
        onChange={(v) => onChange({ ...config, temperature: parseFloat(v) || 0 })}
        type="number"
        helpText="Sampling temperature (0.0 – 2.0). Default 0.7."
      />

      <ThinkingModeSelect
        endpoint={selectedEndpoint}
        value={config.thinkingMode || 'default'}
        onChange={(mode) => onChange({ ...config, thinkingMode: mode })}
      />
    </div>
  );
}

import {
  endpointThinkingKind,
  THINKING_MODE_LABELS,
  THINKING_MODE_OPTIONS,
  type ThinkingMode,
} from 'orchestream-ai-shared/thinking';
import { SelectField } from '@/components/ui/SelectField';

interface ThinkingModeSelectProps {
  /** The selected LLM endpoint — determines which modes the provider supports. */
  endpoint?: {
    provider_type?: string;
    base_url?: string | null;
    models?: string[];
  } | null;
  value: ThinkingMode;
  onChange: (mode: ThinkingMode) => void;
}

export function ThinkingModeSelect({ endpoint, value, onChange }: ThinkingModeSelectProps) {
  const kind = endpoint
    ? endpointThinkingKind({ providerType: endpoint.provider_type, baseUrl: endpoint.base_url, models: endpoint.models })
    : 'generic';
  const options = THINKING_MODE_OPTIONS[kind];
  return (
    <div className="space-y-1">
      <SelectField
        label="Thinking Mode"
        value={value}
        onChange={(v) => onChange(v as ThinkingMode)}
        options={options.map((m) => ({ value: m, label: THINKING_MODE_LABELS[m] }))}
      />
      <p className="text-[10px] text-on-surface-variant">
        Controls chain-of-thought reasoning. Disabling speeds up responses; higher effort improves accuracy at the cost of latency. Options vary by provider.
      </p>
    </div>
  );
}

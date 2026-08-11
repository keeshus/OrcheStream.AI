import { useEffect, useState } from 'react';
import { api } from '@/lib/api-client';
import { Icon } from '@/components/ui/Icon';
import { ThinkingModeSelect } from './ThinkingModeSelect';
import type { ThinkingMode } from 'orchestream-ai-shared/thinking';

interface AIActionConfigProps {
  config: {
    endpointId?: string;
    thinkingMode?: ThinkingMode;
  };
  onChange: (config: any) => void;
}

export function AIActionConfig({ config, onChange }: AIActionConfigProps) {
  const [endpoints, setEndpoints] = useState<any[]>([]);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  useEffect(() => {
    api.llmEndpoints.list().then(setEndpoints).catch(() => {});
  }, []);

  const endpoint = endpoints.find((e: any) => e.id === config.endpointId) || null;

  return (
    <div className="space-y-3">
      <p className="text-xs text-on-surface-variant">
        Single LLM call — no tool loop, no context layering. Configure a prompt to transform upstream data.
      </p>

      <div>
        <button
          type="button"
          onClick={() => setAdvancedOpen(!advancedOpen)}
          className="flex items-center gap-1 text-xs font-medium text-on-surface-variant hover:text-on-surface rounded px-1 py-0.5"
        >
          <Icon name={advancedOpen ? 'expand_less' : 'expand_more'} className="text-sm" />
          Advanced Settings
        </button>

        {advancedOpen && (
          <div className="mt-2 space-y-3">
            <ThinkingModeSelect
              endpoint={endpoint}
              value={config.thinkingMode || 'default'}
              onChange={(mode) => onChange({ ...config, thinkingMode: mode })}
            />
          </div>
        )}
      </div>
    </div>
  );
}

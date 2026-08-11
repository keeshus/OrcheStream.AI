import { Icon } from '@/components/ui/Icon';

const NODE_ICONS: Record<string, string> = {
  trigger: 'arrow_forward',
  'llm-agent': 'smart_toy',
  'mcp-tool': 'build',
  retriever: 'search',
  condition: 'call_split',
  code: 'code',
  parallel: 'view_column',
  hitl: 'schedule',
  output: 'output',
  subflow: 'account_tree',
};

const NODE_LABELS: Record<string, string> = {
  trigger: 'Trigger',
  'llm-agent': 'LLM Agent',
  'mcp-tool': 'MCP Tool',
  retriever: 'Retriever',
  condition: 'Condition',
  code: 'Code',
  output: 'Output',
  parallel: 'Parallel Agents',
  hitl: 'Human in the Loop',
  subflow: 'Subflow',
};

interface StepData {
  nodeId?: string;
  nodeType: string;
  nodeLabel?: string;
  status: string;
  input: any;
  output: any;
  error: string | null;
  startedAt?: string;
  completedAt?: string | null;
  tokens?: string[];
  children?: Array<{ nodeId: string; type: string; output?: any; error?: string; status: string }>;
  selectedField?: string;
}

interface StepCardProps {
  step: StepData;
  expanded: boolean;
  onToggle: () => void;
}

export function StepCard({ step, expanded, onToggle }: StepCardProps) {
  const isLLM = step.nodeType === 'llm-agent';
  const hasSystemPrompt = step.input?.systemPrompt;
  const hasTokens = step.tokens && step.tokens.length > 0;
  const stepLabel = step.nodeLabel || step.input?._nodeLabel || NODE_LABELS[step.nodeType] || step.nodeType;
  const iconName = NODE_ICONS[step.nodeType] || 'schedule';
  const hasExpandable = step.input || step.output || hasTokens || hasSystemPrompt || step.error || step.selectedField;

  const fmtTime = (t: string) => new Date(t).toLocaleTimeString('nl-NL');
  const dur = (s: string | null | undefined, e: string | null | undefined) => {
    if (!s || !e) return null;
    const ms = new Date(e).getTime() - new Date(s).getTime();
    return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
  };
  const duration = dur(step.startedAt, step.completedAt);

  return (
    <div className="bg-surface rounded-lg border overflow-hidden">
      <button
        onClick={onToggle}
        className="w-full p-3 flex items-center gap-3 text-left hover:bg-surface-container transition-colors cursor-pointer"
      >
        {step.status === 'running' && <Icon name="sync" className="text-base text-primary animate-spin shrink-0" />}
        {step.status === 'completed' && <Icon name="check_circle" className="text-base text-success shrink-0" />}
        {step.status === 'failed' && <Icon name="cancel" className="text-base text-error shrink-0" />}
        {step.status === 'pending' && <Icon name="schedule" className="text-base text-on-surface-variant shrink-0" />}
        {step.status === 'skipped' && <Icon name="skip_next" className="text-base text-on-surface-variant shrink-0" />}

        <div className="flex items-center gap-2 shrink-0 w-4 mr-2">
          <Icon name={iconName} className="text-base text-on-surface-variant" />
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-sm font-medium text-on-surface shrink-0">{stepLabel}</span>
            {isLLM && step.input?.model && <span className="text-[10px] text-on-surface-variant font-mono truncate">{step.input.model}</span>}
            {step.output?.toolCalls?.length > 0 && (
              <span className="text-[10px] text-on-surface-variant font-mono truncate">
                {step.output.toolCalls.map((t: any, i: number) => (
                  <span key={i}>{i > 0 && ', '}{t.name}({typeof t.input === 'object' ? Object.keys(t.input || {}).join(',') : '…'})</span>
                ))}
              </span>
            )}
            {step.output?.decision && (
              <span className="text-[10px] px-1.5 py-0.5 rounded font-medium bg-surface-container-high text-on-surface-variant shrink-0 capitalize">{step.output.decision}</span>
            )}
          </div>
          <div className="flex items-center gap-2 mt-0.5">
            <span className={`text-[10px] capitalize ${
              step.status === 'completed' ? 'text-success' :
              step.status === 'failed' ? 'text-error' :
              step.status === 'running' ? 'text-primary' :
              step.status === 'skipped' ? 'text-on-surface-variant' : 'text-on-surface-variant'
            }`}>
              {step.status.replace('_', ' ')}
            </span>
            {duration && <span className="text-[10px] text-on-surface-variant">{duration}</span>}
            {step.startedAt && <span className="text-[10px] text-on-surface-variant">{fmtTime(step.startedAt)}</span>}
          </div>
        </div>

        {isLLM && step.status === 'running' && hasTokens && (
          <div className="hidden sm:block text-xs text-on-surface-variant italic truncate max-w-[200px]">{step.tokens!.join('').slice(-60)}</div>
        )}
        {isLLM && step.status === 'completed' && step.output?.content && (
          <div className="hidden sm:block text-xs text-on-surface-variant truncate max-w-[200px]">{String(step.output.content).slice(0, 60)}</div>
        )}
        {step.error && <Icon name="warning" className="text-base text-error shrink-0" />}

        {hasExpandable && (
          expanded ? <Icon name="expand_less" className="text-base text-on-surface-variant shrink-0" /> : <Icon name="expand_more" className="text-base text-on-surface-variant shrink-0" />
        )}
      </button>

      {expanded && hasExpandable && (
        <div className="border-t bg-surface-container/50 p-4 space-y-3">
          {step.error && (
            <div className="flex items-start gap-2 bg-error-container border border-error rounded p-2">
              <Icon name="warning" className="text-xs text-error mt-0.5 shrink-0" />
              <span className="text-xs text-error font-mono break-all">{step.error}</span>
            </div>
          )}

          {hasSystemPrompt && (
            <div>
              <h4 className="text-[10px] font-semibold text-on-surface-variant uppercase tracking-wider mb-1">Injected Prompt</h4>
              <pre className="text-xs bg-surface border rounded p-2 whitespace-pre-wrap break-all max-h-24 overflow-y-auto">{step.input.systemPrompt}</pre>
            </div>
          )}

          {step.nodeType === 'condition' && step.input?.condition && (
            <div>
              <h4 className="text-[10px] font-semibold text-on-surface-variant uppercase tracking-wider mb-1">Condition</h4>
              <code className="text-xs bg-surface border rounded p-2 block font-mono">{step.input.condition}</code>
            </div>
          )}

          {step.input && (
            <div>
              <h4 className="text-[10px] font-semibold text-on-surface-variant uppercase tracking-wider mb-1">Input</h4>
              <pre className="text-xs bg-surface border rounded p-2 whitespace-pre-wrap break-all max-h-48 overflow-y-auto font-mono">{JSON.stringify(step.input, null, 2)}</pre>
            </div>
          )}

          {step.nodeType === 'output' && (
            <div>
              {step.selectedField && (
                <div className="text-xs text-on-surface-variant mb-2">
                  Selected field: <code className="font-mono bg-surface-container px-1 rounded">{step.selectedField}</code>
                </div>
              )}
              <h4 className="text-[10px] font-semibold text-on-surface-variant uppercase tracking-wider mb-1">Returned value</h4>
              <pre className="text-xs bg-surface border rounded p-2 whitespace-pre-wrap break-all max-h-48 overflow-y-auto font-mono">{(() => {
                // For output nodes, try to extract the selected field value
                if (step.selectedField && step.output && typeof step.output === 'object') {
                  const parts = step.selectedField.split('.');
                  if (parts.length === 2) {
                    const fieldName = parts[1];
                    // Search all values in the output for a string matching the field
                    for (const val of Object.values(step.output)) {
                      if (typeof val === 'string') return val;
                      if (val && typeof val === 'object' && typeof (val as any)[fieldName] === 'string') {
                        return (val as any)[fieldName];
                      }
                    }
                  }
                }
                return step.output !== undefined && step.output !== null
                  ? (typeof step.output === 'string' ? step.output : JSON.stringify(step.output, null, 2))
                  : '(no output)';
              })()}</pre>
            </div>
          )}

          {isLLM && hasTokens && (
            <div>
              <h4 className="text-[10px] font-semibold text-on-surface-variant uppercase tracking-wider mb-1">
                {step.status === 'running' ? 'Streaming Tokens' : 'LLM Response'}
              </h4>
              <div className="text-xs bg-surface border rounded p-2 whitespace-pre-wrap break-all max-h-48 overflow-y-auto text-on-surface">
                {step.tokens!.join('')}
                {step.status === 'running' && <span className="inline-block w-2 h-4 bg-primary animate-pulse ml-0.5 align-middle" />}
              </div>
            </div>
          )}

          {step.nodeType === 'parallel' && step.children && step.children.length > 0 && (
            <div>
              <h4 className="text-[10px] font-semibold text-on-surface-variant uppercase tracking-wider mb-2">Sub-nodes ({step.children.length})</h4>
              <div className="space-y-1.5">
                {step.children.map(child => (
                  <div key={child.nodeId} className={`p-2 rounded border text-xs ${
                    child.status === 'completed' ? 'bg-success-container border-success' :
                    child.status === 'failed' ? 'bg-error-container border-error' : 'bg-surface-container border-outline-variant'
                  }`}>
                    <div className="flex items-center gap-2">
                      {child.status === 'completed' && <Icon name="check_circle" className="text-xs text-success" />}
                      {child.status === 'failed' && <Icon name="cancel" className="text-xs text-error" />}
                      {child.status === 'skipped' && <Icon name="skip_next" className="text-xs text-on-surface-variant" />}
                      <span className="font-medium text-on-surface-variant">{NODE_LABELS[child.type] || child.type}</span>
                      <span className="text-[10px] text-on-surface-variant">{child.nodeId?.slice(0, 8)}</span>
                    </div>
                    {child.error && <p className="text-error mt-1 font-mono">{child.error}</p>}
                    {child.output && (
                      <pre className="mt-1 text-[10px] bg-surface rounded p-1.5 max-h-24 overflow-y-auto font-mono whitespace-pre-wrap break-all">{JSON.stringify(child.output, null, 2)}</pre>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {step.output && (
            <div>
              <h4 className="text-[10px] font-semibold text-on-surface-variant uppercase tracking-wider mb-1">{isLLM ? 'LLM Response' : 'Output'}</h4>
              {isLLM && typeof step.output.content === 'string' && (
                <div className="text-xs text-on-surface whitespace-pre-wrap break-all bg-success-container/50 rounded p-2 border border-success mb-2">{step.output.content}</div>
              )}
              {step.output.toolCalls && step.output.toolCalls.length > 0 && (
                <div className="mb-2">
                  <h5 className="text-[10px] font-semibold text-on-surface-variant uppercase tracking-wider mb-1">Tool Calls ({step.output.toolCalls.length})</h5>
                  <pre className="text-xs bg-surface border rounded p-2 whitespace-pre-wrap break-all max-h-48 overflow-y-auto font-mono">{JSON.stringify(step.output.toolCalls, null, 2)}</pre>
                </div>
              )}
              {step.output.decision && (
                <div className="mb-2">
                  <h5 className="text-[10px] font-semibold text-on-surface-variant uppercase tracking-wider mb-1">Decision</h5>
                  <div className="text-xs bg-secondary-container border border-secondary rounded p-2">
                    <span className="font-medium capitalize">{step.output.decision}</span>
                    {step.output.feedback && <p className="text-on-surface-variant mt-1">{step.output.feedback}</p>}
                  </div>
                </div>
              )}
              {step.output.reviewedContent && (
                <div className="mb-2">
                  <h5 className="text-[10px] font-semibold text-on-surface-variant uppercase tracking-wider mb-1">Reviewed Content</h5>
                  <pre className="text-xs bg-surface border rounded p-2 whitespace-pre-wrap break-all max-h-48 overflow-y-auto font-mono">{JSON.stringify(step.output.reviewedContent, null, 2)}</pre>
                </div>
              )}
              <div className="mt-2">
                <h5 className="text-[10px] font-semibold text-on-surface-variant uppercase tracking-wider mb-1">Full Output</h5>
                <pre className="text-xs bg-surface border rounded p-2 whitespace-pre-wrap break-all max-h-48 overflow-y-auto font-mono">{JSON.stringify(step.output, null, 2)}</pre>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

import { useState } from 'react';
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

interface StepInfo {
  nodeId: string;
  nodeType: string;
  nodeLabel?: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
  input: any;
  output: any;
  error: string | null;
  startedAt: string;
  completedAt: string | null;
  tokens: string[];
  iteration?: number;
  children?: Array<{ nodeId: string; type: string; output?: any; error?: string; status: string }>;
  hierarchy?: { path: string; depth: number };
}

interface StepTreeProps {
  steps: StepInfo[];
  hierarchy?: Record<string, { path: string; depth: number }>;
  onStepClick?: (stepId: string) => void;
  showInputs?: boolean;
  showOutputs?: boolean;
  compact?: boolean;
  onViewSubExecution?: (executionId: string) => void;
  subExecutionLinks?: Record<string, string>;
}

function fmtTime(t: string) {
  return new Date(t).toLocaleTimeString('nl-NL');
}

function dur(s: string | null | undefined, e: string | null | undefined) {
  if (!s || !e) return null;
  const ms = new Date(e).getTime() - new Date(s).getTime();
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function StepCardInner({ step, expanded, onToggle, compact, showInputs, showOutputs, onViewSubExecution, subExecutionLinks }: {
  step: StepInfo;
  expanded: boolean;
  onToggle: () => void;
  compact?: boolean;
  showInputs?: boolean;
  showOutputs?: boolean;
  onViewSubExecution?: (executionId: string) => void;
  subExecutionLinks?: Record<string, string>;
}) {
  const isLLM = step.nodeType === 'llm-agent';
  const isSubflow = step.nodeType === 'subflow';
  const hasSystemPrompt = step.input?.systemPrompt;
  const hasTokens = step.tokens && step.tokens.length > 0;
  const stepLabel = step.nodeLabel || step.input?._nodeLabel || NODE_LABELS[step.nodeType] || step.nodeType;
  const iconName = NODE_ICONS[step.nodeType] || 'schedule';
  const hasExpandable = !compact && (step.input || step.output || hasTokens || hasSystemPrompt || step.error);
  const duration = dur(step.startedAt, step.completedAt);
  const subExecutionId = subExecutionLinks?.[step.nodeId];

  return (
    <div data-testid={`step-card-${step.nodeId}`} className="bg-surface rounded-lg border overflow-hidden">
      <button
        data-testid={`step-toggle-${step.nodeId}`}
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
            {isSubflow && (
              <span data-testid="subflow-badge" className="text-[9px] font-medium px-1.5 py-0.5 rounded bg-secondary-container text-secondary uppercase tracking-wider shrink-0">Subflow</span>
            )}
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

        {subExecutionId && onViewSubExecution && (
          <button
            onClick={(e) => { e.stopPropagation(); onViewSubExecution(subExecutionId); }}
            className="flex items-center gap-1 px-2 py-1 text-[10px] text-primary hover:bg-secondary-container rounded transition-colors"
          >
            <Icon name="open_in_new" className="text-xs" /> View
          </button>
        )}

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

          {showInputs && hasSystemPrompt && (
            <div>
              <h4 className="text-[10px] font-semibold text-on-surface-variant uppercase tracking-wider mb-1">Injected Prompt</h4>
              <pre className="text-xs bg-surface border rounded p-2 whitespace-pre-wrap break-all max-h-24 overflow-y-auto">{step.input.systemPrompt}</pre>
            </div>
          )}

          {showInputs && step.nodeType === 'condition' && step.input?.condition && (
            <div>
              <h4 className="text-[10px] font-semibold text-on-surface-variant uppercase tracking-wider mb-1">Condition</h4>
              <code className="text-xs bg-surface border rounded p-2 block font-mono">{step.input.condition}</code>
            </div>
          )}

          {showInputs && step.input && (
            <div>
              <h4 className="text-[10px] font-semibold text-on-surface-variant uppercase tracking-wider mb-1">Input</h4>
              <pre className="text-xs bg-surface border rounded p-2 whitespace-pre-wrap break-all max-h-48 overflow-y-auto font-mono">{JSON.stringify(step.input, null, 2)}</pre>
            </div>
          )}

          {showOutputs && step.output && (
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
              <div className="mt-2">
                <h5 className="text-[10px] font-semibold text-on-surface-variant uppercase tracking-wider mb-1">Full Output</h5>
                <pre className="text-xs bg-surface border rounded p-2 whitespace-pre-wrap break-all max-h-48 overflow-y-auto font-mono">{JSON.stringify(step.output, null, 2)}</pre>
              </div>
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
        </div>
      )}
    </div>
  );
}

export function StepTree({ steps, hierarchy, onStepClick, showInputs, showOutputs, compact, onViewSubExecution, subExecutionLinks }: StepTreeProps) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});

  const toggle = (id: string) => setExpanded(p => ({ ...p, [id]: !p[id] }));
  const toggleGroup = (path: string) => setExpandedGroups(p => ({ ...p, [path]: !p[path] }));

  const hierarchyMap = hierarchy || {};
  const stepsWithHierarchy = steps.map(s => ({
    ...s,
    hierarchy: s.hierarchy || hierarchyMap[s.nodeId],
  }));

  const subflowGroups = stepsWithHierarchy.filter(s => s.nodeType === 'subflow');
  const subflowNodeIds = new Set(subflowGroups.map(s => s.nodeId));
  const nonSubflowSteps = stepsWithHierarchy.filter(s => !subflowNodeIds.has(s.nodeId) || s.nodeType === 'subflow');

  return (
    <div className="space-y-1.5">
      {nonSubflowSteps.map((step, i) => {
        const depth = step.hierarchy?.depth ?? 0;
        const key = step.nodeId + (step.iteration ?? 0) + i;

        return (
          <div key={key} style={{ marginLeft: depth ? `${depth * 1}em` : undefined }}>
            <StepCardInner
              step={step}
              expanded={expanded[key] || false}
              onToggle={() => toggle(key)}
              compact={compact}
              showInputs={showInputs}
              showOutputs={showOutputs}
              onViewSubExecution={onViewSubExecution}
              subExecutionLinks={subExecutionLinks}
            />

            {step.nodeType === 'subflow' && (
              <div className="ml-6 mt-1 space-y-1 border-l-2 border-outline-variant pl-3">
                {step.children && step.children.length > 0 && step.children.map((child, ci) => (
                  <div key={child.nodeId + ci} className="flex items-center gap-2 p-2 rounded text-xs bg-surface-container/50 border">
                    {child.status === 'completed' && <Icon name="check_circle" className="text-xs text-success shrink-0" />}
                    {child.status === 'failed' && <Icon name="cancel" className="text-xs text-error shrink-0" />}
                    {child.status === 'running' && <Icon name="sync" className="text-xs text-primary animate-spin shrink-0" />}
                    {child.status === 'skipped' && <Icon name="skip_next" className="text-xs text-on-surface-variant shrink-0" />}
                    <span className="font-medium text-on-surface-variant">{NODE_LABELS[child.type] || child.type}</span>
                    <span className="text-[10px] text-on-surface-variant">{child.nodeId?.slice(0, 8)}</span>
                    {child.error && <span className="text-error ml-auto">{child.error}</span>}
                    {child.output && (
                      <pre className="text-[10px] bg-surface rounded p-1 max-h-16 overflow-y-auto font-mono whitespace-pre-wrap break-all ml-auto max-w-[200px]">{JSON.stringify(child.output, null, 2)}</pre>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

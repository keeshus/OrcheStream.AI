import { Handle, Position, type NodeProps } from '@xyflow/react';
import { BaseNode } from './BaseNode';

export function SwitchNode(props: NodeProps) {
  const config = props.data?.config as Record<string, any> | undefined;
  const cases: Array<{ value: string; label: string }> = config?.cases || [];
  const fieldPath = config?.fieldPath || '';
  const hasDefault = !!config?.defaultPath;
  const totalOutputs = cases.length + (hasDefault ? 1 : 0);
  // Only case labels get BaseNode handles — the default path is rendered as
  // its own warning-coloured handle below (same output-<n> id, otherwise the
  // default label would produce a duplicate handle id).
  const allLabels = cases.map(c => c.label || c.value);

  return (
    <BaseNode label={(props.data?.label as string) || 'Switch'} nodeType="Switch" category="processing" selected={props.selected || false} inputs={1} outputs={totalOutputs} outputLabels={allLabels} warnings={props.data?._warnings as string[] | undefined}>
      <div className="space-y-1">
        <p className="text-on-surface-variant">Field:</p>
        <code className="block bg-surface-container p-1.5 rounded text-[11px] font-mono mt-1 overflow-auto max-h-16">
          {fieldPath || 'No field selected'}
        </code>
      </div>
      {cases.length > 0 && (
        <div className="mt-2 pt-2 border-t border-outline-variant">
          <div className="flex flex-wrap gap-1">
            {cases.map((c: any, i: number) => (
              <span key={i} className="text-[9px] px-1.5 py-0.5 rounded font-medium bg-secondary-container text-on-secondary-container">
                {c.label || c.value}
              </span>
            ))}
          </div>
        </div>
      )}
      {hasDefault && (
        <Handle
          type="source"
          position={Position.Right}
          id={`output-${cases.length}`}
          style={{ top: '100%' }}
          className="!w-3 !h-3 !border-2 !border-surface !bg-warning"
        />
      )}
    </BaseNode>
  );
}

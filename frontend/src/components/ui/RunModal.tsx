import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Icon } from '@/components/ui/Icon';

interface RunModalProps {
  /** The flow to run; null closes the modal. */
  flow: { id: string; name: string; nodes?: any[] } | null;
  onClose: () => void;
  onRun: (input: Record<string, unknown>) => void;
}

/**
 * Modal for running a flow with a trigger input, prefilled with the default
 * input configured on the trigger node in the flow editor.
 */
export function RunModal({ flow, onClose, onRun }: RunModalProps) {
  const [inputText, setInputText] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (!flow) return;
    const triggerNode = flow.nodes?.find((n: any) => n.data?.type === 'trigger');
    const inputMessage = triggerNode?.data?.config?.inputMessage || '';
    let parsed: unknown = { message: inputMessage || 'Hello!' };
    if (inputMessage) {
      try { parsed = JSON.parse(inputMessage); } catch { parsed = { message: inputMessage }; }
    }
    setInputText(JSON.stringify(parsed, null, 2));
    setError('');
  }, [flow]);

  const handleRun = () => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(inputText);
    } catch {
      setError('Input must be valid JSON.');
      return;
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      setError('Input must be a JSON object.');
      return;
    }
    setError('');
    if (flow) onRun(parsed as Record<string, unknown>);
    onClose();
  };

  return (
    <Dialog.Root open={!!flow} onOpenChange={(open) => { if (!open) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/30 data-[state=open]:animate-in" />
        <Dialog.Content data-testid="run-modal" className="fixed z-50 top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-surface rounded-xl shadow-m3-4 max-w-md w-full mx-4 p-6">
          <div className="flex items-center justify-between mb-4">
            <Dialog.Title className="text-lg font-semibold text-on-surface m-0">Run {flow?.name}</Dialog.Title>
            <Dialog.Close className="p-1.5 text-on-surface-variant hover:text-error hover:bg-error-container rounded transition-colors">
              <span className="flex items-center gap-1 text-xs"><Icon name="close" className="text-base" /> Close</span>
            </Dialog.Close>
          </div>
          <Dialog.Description className="text-sm text-on-surface-variant mb-2">
            Trigger input for this run — prefilled with the default from the trigger node.
          </Dialog.Description>
          <textarea
            data-testid="run-input"
            value={inputText}
            onChange={(e) => { setInputText(e.target.value); setError(''); }}
            rows={8}
            spellCheck={false}
            className="m3-input w-full font-mono text-xs resize-y"
            placeholder='{ "message": "Hello!" }'
          />
          {error && (
            <p className="mt-1 text-xs text-error">{error}</p>
          )}
          <div className="flex items-center justify-end gap-3 mt-4">
            <Dialog.Close className="m3-button-outlined text-sm">Cancel</Dialog.Close>
            <button onClick={handleRun} className="m3-button text-sm bg-primary">Run</button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

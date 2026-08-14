import { useState, useEffect, useCallback } from 'react';
import { Icon } from '@/components/ui/Icon';
import { useConfirm } from '@/lib/useConfirm';

interface ChatApiDeployment {
  flow_id: string;
  enabled: boolean;
  model_name: string;
  rate_limit: number;
}

interface ChatApiKey {
  id: string;
  flow_id: string;
  label: string;
  key_prefix: string;
  enabled: boolean;
  last_used_at: string | null;
  created_at: string;
  expires_at: string | null;
}

interface NewKeyResponse extends ChatApiKey {
  raw_key: string;
}

interface Props {
  flowId: string;
  isChatFlow: boolean;
}

export function ChatApiSettings({ flowId, isChatFlow }: Props) {
  const [deployment, setDeployment] = useState<ChatApiDeployment | null>(null);
  const [keys, setKeys] = useState<ChatApiKey[]>([]);
  const [newKeyLabel, setNewKeyLabel] = useState('');
  const [newlyCreatedKey, setNewlyCreatedKey] = useState<NewKeyResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const confirm = useConfirm();

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const [dep, keyList] = await Promise.all([
        fetch(`/api/flows/${flowId}/chat-api/deployment`, { credentials: 'include' }).then(r => r.json()),
        fetch(`/api/flows/${flowId}/chat-api/keys`, { credentials: 'include' }).then(r => r.json()),
      ]);
      setDeployment(dep);
      setKeys(keyList);
    } catch {
      // Ignore fetch errors
    }
    setLoading(false);
  }, [flowId]);

  useEffect(() => {
    if (flowId && isChatFlow) fetchData();
  }, [flowId, isChatFlow, fetchData]);

  const updateDeployment = async (updates: Partial<ChatApiDeployment>) => {
    setSaving(true);
    // Optimistic update — the toggle must flip immediately instead of after
    // the PUT roundtrip. Revert if the server rejects the change.
    const previous = deployment;
    setDeployment(prev => ({ ...(prev || { flow_id: flowId, enabled: false, model_name: '', rate_limit: 0 }), ...updates }));
    try {
      const res = await fetch(`/api/flows/${flowId}/chat-api/deployment`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ ...deployment, ...updates }),
      });
      if (res.ok) {
        const updated = await res.json();
        setDeployment(updated);
      } else {
        setDeployment(previous);
      }
    } catch {
      setDeployment(previous);
    }
    setSaving(false);
  };

  const createKey = async () => {
    const res = await fetch(`/api/flows/${flowId}/chat-api/keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ label: newKeyLabel || 'Default' }),
    });
    if (res.ok) {
      const newKey: NewKeyResponse = await res.json();
      setNewlyCreatedKey(newKey);
      setNewKeyLabel('');
      fetchData();
    }
  };

  const deleteKey = async (keyId: string) => {
    const confirmed = await confirm.confirm({
      title: 'Delete API Key',
      message: 'Any clients using this key will lose access immediately. This cannot be undone.',
      confirmLabel: 'Delete',
      variant: 'danger',
    });
    if (!confirmed) return;

    await fetch(`/api/flows/${flowId}/chat-api/keys/${keyId}`, {
      method: 'DELETE',
      credentials: 'include',
    });
    setKeys(prev => prev.filter(k => k.id !== keyId));
  };

  if (!isChatFlow) return null;

  return (
    <div className="border-t border-outline-variant pt-4 mt-4">
      {confirm.dialog}

      {/* ── Header ── */}
      <div className="flex items-center justify-between mb-3">
        <span className="text-xs font-medium text-on-surface-variant">Chat API (OpenAI-compatible)</span>
        <label className="flex items-center gap-2 cursor-pointer">
          <span className="text-[10px] text-on-surface-variant">
            {deployment?.enabled ? 'Enabled' : 'Disabled'}
          </span>
          <input
            type="checkbox"
            checked={deployment?.enabled || false}
            onChange={e => updateDeployment({ enabled: e.target.checked })}
            disabled={loading || saving}
            className="toggle"
          />
        </label>
      </div>

      {loading ? (
        <p className="text-[10px] text-on-surface-variant">Loading...</p>
      ) : deployment ? (
        <div className="space-y-3">
          {/* ── Model name ── */}
          <div>
            <label className="text-[10px] text-on-surface-variant block mb-1">Model Name</label>
            <input
              value={deployment.model_name}
              onChange={e => setDeployment(prev => prev ? { ...prev, model_name: e.target.value } : prev)}
              onBlur={e => updateDeployment({ model_name: e.target.value })}
              placeholder="e.g. gpt-4o"
              disabled={saving}
              className="w-full text-xs border border-outline rounded px-2 py-1.5 bg-surface"
            />
            <p className="text-[10px] text-on-surface-variant mt-0.5">
              This is the model identifier clients must send in the <code className="text-primary">model</code> field.
            </p>
          </div>

          {/* ── Rate limit ── */}
          <div>
            <label className="text-[10px] text-on-surface-variant block mb-1">Rate Limit (requests per minute, 0 = unlimited)</label>
            <input
              type="number"
              min={0}
              value={deployment.rate_limit}
              onChange={e => setDeployment(prev => prev ? { ...prev, rate_limit: parseInt(e.target.value) || 0 } : prev)}
              onBlur={e => updateDeployment({ rate_limit: parseInt(e.target.value) || 0 })}
              disabled={saving}
              className="w-full text-xs border border-outline rounded px-2 py-1.5 bg-surface"
            />
          </div>

          {/* ── API Keys ── */}
          <div className="border-t border-outline-variant pt-3 mt-3">
            <span className="text-[10px] font-medium text-on-surface-variant block mb-2">API Keys</span>

            {keys.length > 0 && (
              <div className="space-y-1 mb-3">
                {keys.map(key => (
                  <div key={key.id} className="flex items-center justify-between bg-surface-container rounded px-2 py-1.5">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-mono text-on-surface">{key.key_prefix}...</span>
                      <span className="text-[10px] text-on-surface-variant">{key.label}</span>
                      {key.last_used_at && (
                        <span className="text-[10px] text-on-surface-variant">
                          Last used: {new Date(key.last_used_at).toLocaleDateString()}
                        </span>
                      )}
                    </div>
                    <button
                      onClick={() => deleteKey(key.id)}
                      className="p-1 text-on-surface-variant hover:text-error rounded text-xs"
                    ><Icon name="delete" className="text-sm" /></button>
                  </div>
                ))}
              </div>
            )}

            {/* ── New key form ── */}
            <div className="flex gap-2 items-center">
              <input
                placeholder="Key label (optional)"
                value={newKeyLabel}
                onChange={e => setNewKeyLabel(e.target.value)}
                className="flex-1 text-xs border border-outline rounded px-2 py-1.5 bg-surface"
              />
              <button onClick={createKey} className="m3-button text-xs shrink-0">
                <Icon name="add" className="text-xs" />
                Generate
              </button>
            </div>

            {/* ── Newly created key (shown once) ── */}
            {newlyCreatedKey && (
              <div className="mt-2 p-2 rounded bg-primary-container border border-primary">
                <p className="text-[10px] text-primary font-medium mb-1">New API Key Generated</p>
                <div className="flex items-center gap-2">
                  <code className="text-xs font-mono text-on-surface bg-surface px-1.5 py-0.5 rounded flex-1 break-all">
                    {newlyCreatedKey.raw_key}
                  </code>
                  <button
                    onClick={() => {
                      navigator.clipboard.writeText(newlyCreatedKey.raw_key);
                    }}
                    className="p-1 text-primary hover:text-on-surface rounded text-xs"
                  ><Icon name="content_copy" className="text-sm" /></button>
                </div>
                <p className="text-[10px] text-primary mt-1">
                  Make sure to copy this key now. You won&apos;t be able to see it again.
                </p>
                <button
                  onClick={() => setNewlyCreatedKey(null)}
                  className="text-[10px] text-primary underline mt-1"
                >Dismiss</button>
              </div>
            )}
          </div>

          {/* ── Usage guide ── */}
          <div className="border-t border-outline-variant pt-3 mt-3">
            <span className="text-[10px] font-medium text-on-surface-variant block mb-1">Usage</span>
            <div className="bg-surface-container rounded p-2">
              <pre className="text-[10px] text-on-surface-variant overflow-x-auto">
{`curl https://your-domain.com/v1/chat/completions \\
  -H "Authorization: Bearer ca_..." \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "${deployment.model_name || '<model_name>'}",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'`}
              </pre>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

import { TextField } from '@/components/ui/TextField';
import { SelectField } from '@/components/ui/SelectField';
import { Icon } from '@/components/ui/Icon';
import { JsonSchemaBuilder } from './JsonSchemaBuilder';
import { useAuth } from '@/lib/auth-context';
import { API_URL } from '@/lib/api-client';
import { useState, useCallback, useEffect } from 'react';

interface TriggerConfigProps {
  config: any;
  onChange: (updates: Record<string, any>) => void;
  flowId: string;
}

export function TriggerConfig({ config, onChange, flowId }: TriggerConfigProps) {
  const { user } = useAuth();
  const isAdmin = user?.permissions?.includes('admin') ?? false;
  const triggerType = config.triggerType || 'manual';
  const [personalKey, setPersonalKey] = useState<string | null>(null);
  const [personalKeyPrefix, setPersonalKeyPrefix] = useState<string>(
    config.personalApiKeyPrefix || ''
  );
  const [keyCreatedAt, setKeyCreatedAt] = useState<string>(
    config.personalApiKeyCreatedAt || ''
  );
  const [loading, setLoading] = useState(false);

  const handleRenew = useCallback(async () => {
    if (!flowId) return;
    setLoading(true);
    try {
      const res = await fetch(`${API_URL}/flows/${flowId}/keys/renew`, {
        method: 'POST',
        credentials: 'include',
      });
      if (!res.ok) throw new Error('Failed to renew key');
      const data = await res.json();
      setPersonalKey(data.rawKey);
      setPersonalKeyPrefix(data.prefix);
      setKeyCreatedAt(data.createdAt);
    } catch (err) {
      console.error('Failed to renew API key:', err);
    } finally {
      setLoading(false);
    }
  }, [flowId]);

  const handleRevoke = useCallback(async () => {
    if (!flowId) return;
    setLoading(true);
    try {
      const res = await fetch(`${API_URL}/flows/${flowId}/keys/revoke`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (!res.ok) throw new Error('Failed to revoke key');
      setPersonalKey(null);
      setPersonalKeyPrefix('');
      setKeyCreatedAt('');
    } catch (err) {
      console.error('Failed to revoke API key:', err);
    } finally {
      setLoading(false);
    }
  }, [flowId]);

  // ── Webhook deployment config (path slug / rate limit / summary) ──
  const [deployment, setDeployment] = useState<{ pathSlug: string; rateLimit: number; summary: string } | null>(null);
  const [deployDraft, setDeployDraft] = useState<{ pathSlug: string; rateLimit: string; summary: string }>({ pathSlug: '', rateLimit: '', summary: '' });
  const [deploySaving, setDeploySaving] = useState(false);
  const [deployError, setDeployError] = useState('');
  const [deploySaved, setDeploySaved] = useState(false);

  useEffect(() => {
    if (triggerType !== 'webhook' || !flowId) return;
    // Fresh flows live at /flows/new/edit until the server-side draft is
    // created — a placeholder id ('new') must not be queried. Retry 404s
    // with backoff so a slow draft creation cannot leave the section stale.
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    let cancelled = false;
    let attempt = 0;
    const load = async () => {
      if (!UUID_RE.test(flowId)) {
        // Placeholder id ('new') — keep polling until the server-side draft
        // resolves, so the section never shows stale empty values.
        if (!cancelled && attempt < 10) {
          attempt += 1;
          setTimeout(load, 500);
        }
        return;
      }
      try {
        const res = await fetch(`${API_URL}/flows/${flowId}/deployment`, { credentials: 'include' });
        if (!res.ok) {
          if (!cancelled && attempt < 5) {
            attempt += 1;
            setTimeout(load, 500 * attempt);
          }
          return;
        }
        const data = await res.json();
        if (cancelled || !data) return;
        setDeployment({ pathSlug: data.pathSlug || '', rateLimit: data.rateLimit || 0, summary: data.summary || '' });
        setDeployDraft({ pathSlug: data.pathSlug || '', rateLimit: String(data.rateLimit ?? 0), summary: data.summary || '' });
      } catch {
        if (!cancelled && attempt < 5) {
          attempt += 1;
          setTimeout(load, 500 * attempt);
        }
      }
    };
    load();
    return () => { cancelled = true; };
  }, [triggerType, flowId]);

  const handleSaveDeployment = useCallback(async () => {
    if (!flowId) return;
    setDeploySaving(true);
    setDeployError('');
    setDeploySaved(false);
    try {
      const res = await fetch(`${API_URL}/flows/${flowId}/deployment`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pathSlug: deployDraft.pathSlug,
          rateLimit: parseInt(deployDraft.rateLimit, 10) || 0,
          summary: deployDraft.summary,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Failed to save deployment' }));
        throw new Error(err.error || 'Failed to save deployment');
      }
      const data = await res.json();
      setDeployment({ pathSlug: data.pathSlug, rateLimit: data.rateLimit, summary: data.summary });
      setDeploySaved(true);
    } catch (err) {
      setDeployError(err instanceof Error ? err.message : 'Failed to save deployment');
    } finally {
      setDeploySaving(false);
    }
  }, [flowId, deployDraft]);

  if (triggerType === 'subflow') {
    return (
      <div className="space-y-3">
        <p className="text-xs text-on-surface-variant bg-secondary-container rounded border p-2">
          This flow is a subflow — it will be executed as a sub-routine within other flows.
          Define the input contract below.
        </p>
        <JsonSchemaBuilder
          value={config.inputSchema || ''}
          onChange={(v) => onChange({ inputSchema: v })}
          label="Input Schema"
          helpText="Define the expected input fields. The parent flow must map these fields."
          rows={8}
        />
        <TextField
          label="Description"
          value={config.inputMessage || ''}
          onChange={(v) => onChange({ inputMessage: v })}
          multiline
          rows={2}
          helpText="Help text shown when selecting this subflow"
        />
      </div>
    );
  }

  const pathSlug = config.pathSlug || '';
  const baseUrl = process.env.NEXT_PUBLIC_API_URL || '/api';

  return (
    <div className="space-y-3">
      <SelectField
        label="Trigger Type"
        value={triggerType}
        onChange={(v) => onChange({ triggerType: v })}
        options={[
          { value: 'manual', label: 'Manual' },
          { value: 'chat', label: 'Chat' },
          { value: 'webhook', label: 'Webhook' },
          { value: 'schedule', label: 'Schedule' },
        ]}
      />

      {triggerType === 'webhook' && (
        <>
          {isAdmin && (
            <TextField
              label="Webhook Secret"
              value={config.webhookSecret || ''}
              onChange={(v) => onChange({ webhookSecret: v })}
              helpText="Pass as ?secret=... in the webhook URL. Only admins can set this."
            />
          )}

          <div className="bg-surface-container rounded-lg p-3 space-y-2">
            <p className="text-xs font-medium text-on-surface-variant">Your Personal API Key</p>

            {personalKey ? (
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <code className="flex-1 text-xs bg-surface rounded px-2 py-1.5 border border-outline font-mono break-all">
                    {personalKey}
                  </code>
                  <button
                    onClick={() => navigator.clipboard.writeText(personalKey)}
                    className="p-1.5 rounded hover:bg-surface-container-high text-on-surface-variant"
                    title="Copy key"
                  >
                    <Icon name="content_copy" className="text-sm" />
                  </button>
                </div>
                <p className="text-[10px] text-warning">
                  This key is shown once. Copy it now. If you lose it, renew to generate a new one.
                </p>
              </div>
            ) : personalKeyPrefix ? (
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <code className="text-xs bg-surface rounded px-2 py-1.5 border border-outline font-mono">
                    {personalKeyPrefix}...
                  </code>
                  <span className="text-[10px] text-on-surface-variant">
                    Created {keyCreatedAt ? new Date(keyCreatedAt).toLocaleDateString() : ''}
                  </span>
                </div>
              </div>
            ) : (
              <p className="text-xs text-on-surface-variant">
                No personal API key yet. Save the flow to auto-generate one.
              </p>
            )}

            <div className="flex gap-2">
              <button
                onClick={handleRenew}
                disabled={loading}
                className="text-xs px-2 py-1 rounded bg-primary-container text-primary hover:bg-primary-container/80 disabled:opacity-50"
              >
                {loading ? '...' : 'Renew Key'}
              </button>
              {personalKeyPrefix && (
                <button
                  onClick={handleRevoke}
                  disabled={loading}
                  className="text-xs px-2 py-1 rounded bg-error-container text-error hover:bg-error-container/80 disabled:opacity-50"
                >
                  Revoke Key
                </button>
              )}
            </div>

            <p className="text-[10px] text-on-surface-variant">
              Personal to you. Used with <code className="text-[10px] font-mono">Authorization: Bearer wh_...</code>.
              Sharing it allows others to act on your behalf.
            </p>
          </div>

          <div className="bg-surface-container rounded-lg p-3 space-y-3" data-testid="webhook-deployment-settings">
            <p className="text-xs font-medium text-on-surface-variant">Deployment</p>
            <TextField
              label="Path Slug"
              value={deployDraft.pathSlug}
              onChange={(v) => { setDeployDraft(p => ({ ...p, pathSlug: v })); setDeploySaved(false); }}
              helpText="Public URL path: /api/webhook/&lt;slug&gt;. Leave empty to auto-generate from the flow name."
              data-testid="webhook-path-slug"
            />
            <TextField
              label="Rate Limit (requests/min)"
              value={deployDraft.rateLimit}
              onChange={(v) => { setDeployDraft(p => ({ ...p, rateLimit: v.replace(/[^0-9]/g, '') })); setDeploySaved(false); }}
              helpText="0 = no rate limit."
              data-testid="webhook-rate-limit"
            />
            <TextField
              label="Summary"
              value={deployDraft.summary}
              onChange={(v) => { setDeployDraft(p => ({ ...p, summary: v })); setDeploySaved(false); }}
              helpText="Shown in the OpenAPI docs for this webhook."
              data-testid="webhook-summary"
            />
            {deployError && <p className="text-xs text-error">{deployError}</p>}
            {deploySaved && <p className="text-xs text-success" data-testid="webhook-deploy-saved">Deployment saved.</p>}
            <button
              onClick={handleSaveDeployment}
              disabled={deploySaving}
              data-testid="webhook-save-deployment"
              className="text-xs px-2 py-1 rounded bg-primary text-on-primary hover:bg-primary/80 disabled:opacity-50"
            >
              {deploySaving ? 'Saving...' : 'Save Deployment'}
            </button>
          </div>

          <div className="bg-surface-container rounded p-2">
            <p className="text-[10px] font-medium text-on-surface-variant mb-1">Webhook URL</p>
            <code className="text-[10px] text-on-surface-variant break-all">
              {baseUrl}/webhook/
              {deployment?.pathSlug || pathSlug || flowId}
              {config.webhookSecret ? '?secret=••••••••' : ''}
            </code>
            {(deployment?.pathSlug || pathSlug) && (
              <p className="text-[10px] text-on-surface-variant mt-1">
                OpenAPI spec: <a href={`${baseUrl}/openapi.json`} target="_blank" rel="noopener noreferrer" className="text-primary underline">{baseUrl}/openapi.json</a>
                {' · '}
                <a href={`${baseUrl}/docs`} target="_blank" rel="noopener noreferrer" className="text-primary underline">Swagger UI</a>
              </p>
            )}
          </div>
        </>
      )}

      {triggerType === 'schedule' && (
        <TextField
          label="Cron Expression"
          value={config.cronExpression || ''}
          onChange={(v) => onChange({ cronExpression: v })}
          helpText="minute hour day-of-month month day-of-week. E.g. &quot;0 9 * * *&quot; = daily at 9am, &quot;*/15 * * * *&quot; = every 15 min"
        />
      )}

      {(triggerType === 'schedule' || triggerType === 'manual') && (
        <TextField
          label="Input Message"
          value={config.inputMessage || ''}
          onChange={(v) => onChange({ inputMessage: v })}
          multiline
          rows={2}
          helpText="Sent to the next node each trigger. Plain text becomes the message, JSON objects are passed as structured input."
        />
      )}

      {triggerType === 'webhook' && (
        <JsonSchemaBuilder
          value={config.inputSchema || ''}
          onChange={(v) => onChange({ inputSchema: v })}
          label="Expected Input Schema"
          helpText="Define required fields and types. Incoming POSTs are validated — invalid requests get 400."
        />
      )}
    </div>
  );
}

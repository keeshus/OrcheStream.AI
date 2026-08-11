import { useAssistantContext } from '@/hooks/useAssistantContext';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Icon } from '@/components/ui/Icon';
import { TextField } from '@/components/ui/TextField';
import { Tooltip } from '@/components/ui/Tooltip';
import { useRouter } from 'next/router';
import { API_URL } from '@/lib/api-client';
import { BrandLogo } from '@/components/BrandLogo';
import * as Separator from '@radix-ui/react-separator';

interface SSOConfig {
  provider: string;
  clientId: string;
  clientSecret: string;
  issuer: string;
  redirectUri: string;
  groupClaim: string;
  adminGroupMapping: string[];
  editorGroupMapping: string[];
  enabled: boolean;
}

export default function SSOSettingsPage() {
  const router = useRouter();
  const [config, setConfig] = useState<SSOConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [adminMappingInput, setAdminMappingInput] = useState('');
  const [editorMappingInput, setEditorMappingInput] = useState('');
  useAssistantContext({ pageKey: 'settings:sso', description: 'SSO configuration' });

  useEffect(() => {
    fetch(`${API_URL}/admin/sso-config`, { credentials: 'include' })
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (data) {
          setConfig(data);
          setAdminMappingInput((data.adminGroupMapping || []).join(', '));
          setEditorMappingInput((data.editorGroupMapping || []).join(', '));
        }
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  const handleSave = async () => {
    if (!config) return;
    setSaving(true); setError(''); setSuccess('');
    try {
      const body = {
        ...config,
        adminGroupMapping: adminMappingInput.split(',').map(s => s.trim()).filter(Boolean),
        editorGroupMapping: editorMappingInput.split(',').map(s => s.trim()).filter(Boolean),
      };
      const res = await fetch(`${API_URL}/admin/sso-config`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error('Failed to save');
      const updated = await res.json();
      setConfig(updated);
      setSuccess('SSO configuration saved');
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-surface-container flex items-center justify-center">
        <Icon name="sync" className="text-2xl text-on-surface-variant animate-spin" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-surface-container">
            <div className="max-w-4xl mx-auto p-6">
        <div className="flex items-center gap-3 mb-6">
          <div className="flex items-center gap-3">
            <Link href="/" className="flex items-center gap-1.5 shrink-0 leading-none text-on-surface-variant hover:text-on-surface-variant" title="Home">
              <BrandLogo size="sm" />
              <span>Home</span>
            </Link>
            <Separator.Root orientation="vertical" className="w-px h-6 bg-outline-variant mx-0.5" />
            <Link href="/settings" className="flex items-center gap-1 leading-none text-on-surface-variant hover:text-on-surface-variant">
              <Icon name="arrow_back" className="text-base" /> <span>Back</span>
            </Link>
          </div>
          <Separator.Root orientation="vertical" className="w-px h-6 bg-outline-variant" />
          <div className="flex-1">
            <h1 className="text-2xl font-bold text-on-surface">SSO / OIDC Configuration</h1>
            <p className="text-sm text-on-surface-variant mt-1">Configure single sign-on with your identity provider</p>
          </div>
        </div>

        {error && (
          <div className="bg-error-container border border-red-200 text-error text-sm rounded p-3 mb-4 flex items-center gap-2">
            <Icon name="warning" className="text-base shrink-0" /> {error}
          </div>
        )}
        {success && (
          <div className="bg-success-container border border-green-200 text-success text-sm rounded p-3 mb-4 flex items-center gap-2">
            <Icon name="check_circle" className="text-base shrink-0" /> {success}
          </div>
        )}

        {config && (
          <div className="bg-surface rounded-xl border border-outline-variant p-6 space-y-4">
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input
                type="checkbox"
                checked={config.enabled}
                onChange={(e) => setConfig({ ...config, enabled: e.target.checked })}
                className="rounded accent-primary"
              />
              <span className="text-sm text-on-surface">Enable SSO</span>
            </label>

            <div className="grid grid-cols-2 gap-4">
              <TextField label="Provider name" value={config.provider} onChange={(v) => setConfig({ ...config, provider: v })} helpText="e.g. keycloak, azure, google" />
              <TextField label="Client ID" value={config.clientId} onChange={(v) => setConfig({ ...config, clientId: v })} />
              <TextField label="Client Secret" value={config.clientSecret} onChange={(v) => setConfig({ ...config, clientSecret: v })} type="password" helpText="Leave as-is to keep current value" />
              <TextField label="Issuer URL" value={config.issuer} onChange={(v) => setConfig({ ...config, issuer: v })} helpText="OIDC discovery URL" />
              <TextField label="Redirect URI" value={config.redirectUri} onChange={(v) => setConfig({ ...config, redirectUri: v })} />
              <TextField label="Group claim name" value={config.groupClaim} onChange={(v) => setConfig({ ...config, groupClaim: v })} helpText="JWT claim containing group list (default: groups)" />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <TextField label="Admin group mapping" value={adminMappingInput} onChange={setAdminMappingInput} helpText="Comma-separated group names that map to admin role" />
              <TextField label="Editor group mapping" value={editorMappingInput} onChange={setEditorMappingInput} helpText="Comma-separated group names that map to editor role" />
            </div>

            <div className="flex justify-end pt-2">
              <Tooltip content={!saving && config && (!config.provider || !config.clientId || !config.issuer || !config.redirectUri) ? 'Fill in all required fields' : ''}>
                <span>
                  <button onClick={handleSave} disabled={saving || !config?.provider || !config?.clientId || !config?.issuer} className="m3-button disabled:opacity-50 disabled:cursor-not-allowed">
                    {saving ? <><Icon name="sync" className="text-sm animate-spin" /> Saving...</> : 'Save Configuration'}
                  </button>
                </span>
              </Tooltip>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

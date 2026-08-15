import { useEffect, useState, useRef, useCallback } from 'react';
import { Icon } from '@/components/ui/Icon';
import { SelectField } from '@/components/ui/SelectField';
import { TextField } from '@/components/ui/TextField';
import { API_URL } from '@/lib/api-client';

export type EnvOverrideRowType = 'plaintext' | 'core_secret' | 'cyberark';
export type EnvOverridesPayload = Record<string, string | { type: 'core_secret' | 'cyberark'; value: string }>;

interface EnvOverridesSectionProps {
  flowId: string;
  /** Emits the effective per-run overrides; called on every change. */
  onChange: (overrides: EnvOverridesPayload) => void;
}

interface EnvVarConfig {
  name: string;
  type: 'static' | 'core_secret' | 'cyberark';
  value: string;
}

interface OverrideRow {
  type: EnvOverrideRowType;
  value: string;
}

const TYPE_OPTIONS: { value: EnvOverrideRowType; label: string }[] = [
  { value: 'plaintext', label: 'Plaintext' },
  { value: 'core_secret', label: 'Core Secret' },
  { value: 'cyberark', label: 'CyberArk' },
];

/**
 * Collapsible "Environment overrides" section used by the quick-run dialog
 * (RunModal) and the editor's debug overlay. One row per flow-configured env
 * var; only rows whose value differs from the configured one are emitted as
 * overrides, so an empty field keeps the flow's configured value.
 */
export function EnvOverridesSection({ flowId, onChange }: EnvOverridesSectionProps) {
  const [open, setOpen] = useState(false);
  const [configured, setConfigured] = useState<EnvVarConfig[]>([]);
  const [rows, setRows] = useState<Record<string, OverrideRow>>({});
  const [secretNames, setSecretNames] = useState<string[]>([]);
  const [cyberarkAvailable, setCyberarkAvailable] = useState(false);
  const [loading, setLoading] = useState(true);
  const rowsRef = useRef<Record<string, OverrideRow>>({});

  const rowFor = (v: EnvVarConfig): OverrideRow => ({
    type: v.type === 'core_secret' ? 'core_secret' : v.type === 'cyberark' ? 'cyberark' : 'plaintext',
    value: v.value ?? '',
  });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const flowRes = await fetch(`${API_URL}/flows/${flowId}`, { credentials: 'include' });
        const flow = flowRes.ok ? await flowRes.json() : null;
        const envVars: EnvVarConfig[] = Array.isArray(flow?.env_vars) ? flow.env_vars : [];
        const groupId = flow?.group_id || null;

        // Secrets in the flow's scope: app-wide + group + flow-scoped. The API
        // 403s when the user lacks read access — treat as empty.
        const scopeQueries: string[] = ['scope=app'];
        if (groupId) scopeQueries.push(`scope=group&scopeId=${encodeURIComponent(groupId)}`);
        scopeQueries.push(`scope=flow&scopeId=${encodeURIComponent(flowId)}`);
        const secretResults = await Promise.all(
          scopeQueries.map(q =>
            fetch(`${API_URL}/secrets?${q}`, { credentials: 'include' })
              .then(r => r.ok ? r.json() : [])
              .catch(() => [])
          )
        );
        const names = [...new Set(secretResults.flat().map((s: any) => s?.name).filter(Boolean))];

        // CyberArk is offered when the flow's group has a bound vault, or for
        // global flows when a connected vault exists.
        let vaultOk = false;
        if (groupId) {
          const vcRes = await fetch(`${API_URL}/group-vault-config/${groupId}`, { credentials: 'include' });
          const vc = vcRes.ok ? await vcRes.json() : null;
          vaultOk = !!(vc?.enabled && vc?.vaultId);
        } else {
          const vRes = await fetch(`${API_URL}/secret-vaults`, { credentials: 'include' });
          const vaults = vRes.ok ? await vRes.json() : [];
          vaultOk = Array.isArray(vaults) && vaults.some((v: any) => v?.connected);
        }

        if (cancelled) return;
        setConfigured(envVars);
        setSecretNames(names);
        setCyberarkAvailable(vaultOk);
        const initial = Object.fromEntries(envVars.map(v => [v.name, rowFor(v)]));
        rowsRef.current = initial;
        setRows(initial);
      } catch {
        // Flow/env-vars not readable — hide the section.
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [flowId]);

  const emitOverrides = useCallback((next: Record<string, OverrideRow>) => {
    const payload: EnvOverridesPayload = {};
    for (const entry of configured) {
      const row = next[entry.name];
      if (!row || row.value.trim() === '') continue;
      const sameAsConfigured =
        (entry.type === 'core_secret' && row.type === 'core_secret')
        || (entry.type === 'cyberark' && row.type === 'cyberark')
        || ((entry.type === 'static' || !entry.type) && row.type === 'plaintext');
      if (sameAsConfigured && row.value === entry.value) continue;
      payload[entry.name] = row.type === 'plaintext'
        ? row.value
        : { type: row.type, value: row.value };
    }
    onChange(payload);
  }, [configured, onChange]);

  const updateRow = useCallback((name: string, patch: Partial<OverrideRow>) => {
    const next = { ...rowsRef.current, [name]: { ...(rowsRef.current[name] || { type: 'plaintext' as const, value: '' }), ...patch } };
    rowsRef.current = next;
    setRows(next);
    emitOverrides(next);
  }, [emitOverrides]);

  const resetRows = useCallback(() => {
    const next = Object.fromEntries(configured.map(v => [v.name, rowFor(v)]));
    rowsRef.current = next;
    setRows(next);
    emitOverrides(next);
  }, [configured, emitOverrides]);

  if (loading) return null;
  if (configured.length === 0) return null;

  const cyberarkVisible = cyberarkAvailable || configured.some(v => v.type === 'cyberark');
  const typeOptions = TYPE_OPTIONS.filter(o => o.value !== 'cyberark' || cyberarkVisible);
  const secretOptions = [
    { value: '', label: '— Select a secret —' },
    ...secretNames.map(n => ({ value: n, label: n })),
  ];

  return (
    <div data-testid="env-overrides-section" className="border border-outline-variant rounded-lg">
      <button
        type="button"
        data-testid="env-overrides-toggle"
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between px-3 py-2 text-sm font-medium text-on-surface hover:bg-surface-container-high rounded-lg transition-colors"
      >
        <span className="flex items-center gap-1.5">
          <Icon name="tune" className="text-sm text-on-surface-variant" />
          Environment overrides
        </span>
        <Icon name={open ? 'expand_less' : 'expand_more'} className="text-base text-on-surface-variant" />
      </button>

      {open && (
        <div className="px-3 pb-3 space-y-2 border-t border-outline-variant pt-2">
          {configured.map(entry => {
            const row = rows[entry.name] || { type: 'plaintext' as const, value: '' };
            return (
              <div key={entry.name} data-testid={`env-override-row-${entry.name}`} className="grid grid-cols-[minmax(0,1fr)_140px_minmax(0,1.6fr)] gap-2 items-end">
                <span className="text-xs font-medium text-on-surface font-mono truncate self-center pb-1.5" title={entry.name}>{entry.name}</span>
                <SelectField
                  label="Type"
                  value={row.type}
                  onChange={(v) => updateRow(entry.name, { type: v as EnvOverrideRowType })}
                  options={typeOptions}
                />
                {row.type === 'core_secret' ? (
                  <SelectField
                    label="Secret"
                    value={row.value}
                    onChange={(v) => updateRow(entry.name, { value: v })}
                    options={secretOptions}
                  />
                ) : (
                  <TextField
                    label="Value"
                    value={row.value}
                    onChange={(v) => updateRow(entry.name, { value: v })}
                    placeholder={row.type === 'cyberark' ? 'path/to/variable' : ''}
                  />
                )}
              </div>
            );
          })}
          <div className="flex items-center justify-between pt-1">
            <p className="text-[11px] text-on-surface-variant">Overrides apply to this run only. Empty fields keep the flow&apos;s configured value.</p>
            <button
              type="button"
              data-testid="env-overrides-reset"
              onClick={resetRows}
              className="flex items-center gap-1 text-xs text-on-surface-variant hover:text-primary px-2 py-1 rounded transition-colors"
            >
              <Icon name="restart_alt" className="text-sm" /> Reset
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

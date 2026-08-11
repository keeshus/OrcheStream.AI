import { useState, useEffect } from 'react';
import { useRouter } from 'next/router';
import { useAuth } from '@/lib/auth-context';
import { Icon } from '@/components/ui/Icon';
import { BrandLogo } from '@/components/BrandLogo';
import { BetaBadge } from '@/components/BetaBadge';
import { PasswordStrengthMeter } from '@/components/PasswordStrength';
import { TextField } from '@/components/ui/TextField';

const API_URL = process.env.NEXT_PUBLIC_API_URL || '/api';

export default function SetupPage() {
  const router = useRouter();
  const { user, loading: authLoading } = useAuth();
  const [checking, setChecking] = useState(true);
  const [setupRequired, setSetupRequired] = useState(false);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (authLoading) return;
    if (user) { router.replace('/'); return; }
    fetch(`${API_URL}/auth/setup-status`)
      .then(r => r.json())
      .then(data => {
        if (!data.required) { router.replace('/login'); return; }
        setSetupRequired(true);
      })
      .catch(() => setError('Could not check setup status'))
      .finally(() => setChecking(false));
  }, [authLoading, user, router]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (password.length < 8) { setError('Password must be at least 8 characters'); return; }
    setLoading(true);
    try {
      const res = await fetch(`${API_URL}/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ email, password, name }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Registration failed' }));
        throw new Error(err.error);
      }
      router.push('/');
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  if (checking || authLoading) {
    return (
      <div className="min-h-screen bg-surface-container flex items-center justify-center">
        <Icon name="sync" className="text-2xl text-on-surface-variant animate-spin" />
      </div>
    );
  }

  if (!setupRequired) return null;

  return (
    <div className="min-h-screen bg-surface-container flex items-center justify-center">
      <div className="max-w-md w-full mx-4">
        <div className="bg-surface rounded-xl shadow-sm border p-8">
          <div className="flex items-center gap-3 mb-4">
            <BrandLogo size="sm" />
            <h1 className="text-2xl font-bold text-on-surface">Welcome to OrcheStream.AI <BetaBadge /></h1>
          </div>
          <p className="text-sm text-on-surface-variant mb-6">Create the first admin account to get started.</p>
          {error && <div className="bg-error-container border border-red-200 text-red-700 text-sm rounded p-3 mb-4">{error}</div>}
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <TextField label="Name" value={name} onChange={setName} />
            </div>
            <div>
              <TextField label="Email" value={email} onChange={setEmail} />
            </div>
            <div>
              <TextField label="Password" type="password" value={password} onChange={setPassword} helpText="Minimum 8 characters required" />
              {password.length > 0 && <PasswordStrengthMeter password={password} />}
            </div>
            <div>
              <TextField label="Confirm Password" type="password" value={confirmPassword} onChange={setConfirmPassword} />
            </div>
            <button type="submit" disabled={loading} className="w-full m3-button disabled:opacity-50">
              {loading ? 'Creating admin account...' : 'Create Admin Account'}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}

import { useState, useEffect } from 'react';
import { useRouter } from 'next/router';
import { useAuth, useAuthConfig } from '@/lib/auth-context';
import { API_URL } from '@/lib/api-client';
import Link from 'next/link';
import { Icon } from '@/components/ui/Icon';
import { TextField } from '@/components/ui/TextField';
import { BrandLogo } from '@/components/BrandLogo';
import { BetaBadge } from '@/components/BetaBadge';

export default function LoginPage() {
  const router = useRouter();
  const { login } = useAuth();
  const authConfig = useAuthConfig();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const hasSso = authConfig?.sso != null;
  const ssoName = authConfig?.sso?.name || 'SSO';

  // Read error from URL params (SSO callback errors)
  useEffect(() => {
    const errParam = router.query.error as string;
    if (errParam === 'sso_failed') setError('SSO login failed. Please try again.');
    else if (errParam === 'missing_sso_state') setError('SSO session expired. Please try again.');
    else if (errParam === 'no_user_info') setError('Could not retrieve user info from SSO provider.');
  }, [router.query]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await login(email, password);
      router.push('/');
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-surface-container flex items-center justify-center">
      <div className="max-w-md w-full mx-4">
        <div className="flex items-center justify-center gap-4 mb-8">
          <BrandLogo size="lg" />
          <div className="text-3xl font-bold text-on-surface">OrcheStream.AI <BetaBadge /></div>
        </div>
        <div className="bg-surface rounded-xl shadow-sm border p-8">
          <h2 className="text-xl font-semibold text-on-surface mb-4">Sign In</h2>
          {error && <div className="bg-error-container border border-red-200 text-red-700 text-sm rounded p-3 mb-4">{error}</div>}

          {hasSso && (
            <>
              <a
                href={`${API_URL}/auth/sso/login`}
                className="flex items-center justify-center gap-2 w-full border-2 border-outline text-on-surface-variant rounded p-2.5 text-sm font-medium hover:bg-surface-container-high hover:border-outline transition-colors mb-4"
              >
                <Icon name="login" className="text-xl" />
                Sign in with {ssoName}
              </a>
            </>
          )}

          {hasSso && (
            <div className="flex items-center gap-3 mb-4">
              <div className="flex-1 border-t border-outline-variant" />
              <span className="text-xs text-on-surface-variant">or</span>
              <div className="flex-1 border-t border-outline-variant" />
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <TextField label="Email" type="email" value={email} onChange={setEmail} />
            </div>
            <div>
              <TextField label="Password" type="password" value={password} onChange={setPassword} />
            </div>
            <button type="submit" disabled={loading} className="w-full m3-button disabled:opacity-50">
              {loading ? 'Signing in...' : 'Sign In'}
            </button>
          </form>
          <p className="text-xs text-on-surface-variant mt-4 text-center">
            Don&apos;t have an account? <Link href="/register" className="text-primary hover:underline">Register</Link>
          </p>
        </div>
      </div>
    </div>
  );
}

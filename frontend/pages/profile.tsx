import { useEffect, useState } from 'react';
import { useAssistantContext } from '@/hooks/useAssistantContext';
import { useRouter } from 'next/router';
import { useAuth } from '@/lib/auth-context';
import { api } from '@/lib/api-client';
import Link from 'next/link';
import { Icon } from '@/components/ui/Icon';
import { TextField } from '@/components/ui/TextField';
import { BrandLogo } from '@/components/BrandLogo';

export default function ProfilePage() {
  const router = useRouter();
  const { user, loading: authLoading } = useAuth();
  const can = (perm: string) => user?.permissions?.includes(perm) ?? false;
  const backHref = user && !can('flow:create') ? '/approvals' : '/';
  useAssistantContext({ pageKey: 'profile', description: 'Editing profile' });
  const [profile, setProfile] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [saveStatus, setSaveStatus] = useState<'idle' | 'success' | 'error'>('idle');
  const [saveMessage, setSaveMessage] = useState('');

  useEffect(() => {
    if (authLoading) return;
    if (!user) { router.push('/login'); return; }
    api.auth.profile()
      .then(p => {
        setProfile(p);
        setName(p.name || '');
        setEmail(p.email || '');
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [user, authLoading, router]);

  const handleSave = async () => {
    setSaving(true);
    setSaveStatus('idle');
    try {
      const updated = await api.auth.updateProfile({ name, email });
      setProfile(updated);
      setSaveStatus('success');
      setSaveMessage('Profile updated');
      setTimeout(() => setSaveStatus('idle'), 3000);
    } catch (err: any) {
      setSaveStatus('error');
      setSaveMessage(err.message);
    } finally {
      setSaving(false);
    }
  };

  if (authLoading || loading) {
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
          <Link href="/" className="flex items-center gap-1.5 shrink-0 leading-none text-on-surface-variant hover:text-on-surface-variant" title="Home">
            <BrandLogo size="sm" />
            <span>Home</span>
          </Link>
          <Link href={backHref} className="text-on-surface-variant hover:text-on-surface-variant">
            <Icon name="arrow_back" className="text-base" />
          </Link>
          <h1 className="text-2xl font-bold text-on-surface">Profile</h1>
        </div>

        {/* Profile info */}
        <div className="bg-surface rounded-xl border p-6 mb-6">
          <div className="flex items-center gap-4 mb-6">
            <div className="w-14 h-14 rounded-full bg-blue-100 flex items-center justify-center">
              <Icon name="person" className="text-2xl text-primary" />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-on-surface">{profile?.name || 'User'}</h2>
              <p className="text-sm text-on-surface-variant">{profile?.email}</p>
            </div>
          </div>

          <div className="space-y-4">
            <div>
              <TextField label="Name" value={name} onChange={setName} />
            </div>
            <div>
              <TextField label="Email" value={email} onChange={setEmail} />
            </div>

            {saveStatus !== 'idle' && (
              <div className={`flex items-center gap-2 text-sm ${saveStatus === 'success' ? 'text-green-600' : 'text-red-600'}`}>
                {saveStatus === 'success' ? <Icon name="check_circle" className="text-base" /> : <Icon name="cancel" className="text-base" />}
                {saveMessage}
              </div>
            )}

            <button
              onClick={handleSave}
              disabled={saving}
              className="m3-button gap-2 disabled:opacity-50"
            >
              <Icon name="save" className="text-base" /> {saving ? 'Saving...' : 'Save Changes'}
            </button>
          </div>
        </div>

        {/* Role & Permissions */}
        <div className="bg-surface rounded-xl border p-6 mb-6">
          <h3 className="text-sm font-semibold text-on-surface mb-4 flex items-center gap-2">
            <Icon name="shield" className="text-base" /> Role &amp; Permissions
          </h3>
          {profile?.role ? (
            <div>
              <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-blue-100 text-blue-700 mb-3">
                {profile.role.name}
              </div>
              {profile.role.permissions && profile.role.permissions.length > 0 && (
                <div className="space-y-1">
                  <p className="text-[10px] text-on-surface-variant uppercase tracking-wider font-medium">Permissions</p>
                  <div className="flex flex-wrap gap-1.5">
                    {profile.role.permissions.map((p: string) => (
                      <span key={p} className="px-2 py-0.5 rounded text-[10px] bg-surface-container-high text-on-surface-variant font-mono">
                        {p}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <p className="text-sm text-on-surface-variant">No role assigned</p>
          )}
        </div>

        {/* Change password (local accounts only) */}
        {profile?.provider === 'local' && (
          <PasswordSection />
        )}

        {/* Account info */}
        <div className="bg-surface rounded-xl border p-6">
          <h3 className="text-sm font-semibold text-on-surface mb-4 flex items-center gap-2">
            <Icon name="schedule" className="text-base" /> Account Details
          </h3>
          <div className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-on-surface-variant">Provider</span>
              <span className="text-on-surface capitalize">{profile?.provider || 'local'}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-on-surface-variant">Member since</span>
              <span className="text-on-surface">{profile?.createdAt ? new Date(profile.createdAt).toLocaleDateString('nl-NL') : '—'}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-on-surface-variant">Last login</span>
              <span className="text-on-surface">{profile?.lastLoginAt ? new Date(profile.lastLoginAt).toLocaleString('nl-NL') : '—'}</span>
            </div>
          </div>
        </div>

      </div>
    </div>
  );
}

function PasswordSection() {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<'idle' | 'success' | 'error'>('idle');
  const [message, setMessage] = useState('');

  const handleChangePassword = async () => {
    if (!currentPassword || !newPassword || !confirmPassword) {
      setStatus('error');
      setMessage('All fields are required');
      return;
    }
    if (newPassword.length < 8) {
      setStatus('error');
      setMessage('New password must be at least 8 characters');
      return;
    }
    if (newPassword !== confirmPassword) {
      setStatus('error');
      setMessage('New passwords do not match');
      return;
    }
    setSaving(true);
    setStatus('idle');
    try {
      await api.auth.changePassword({ currentPassword, newPassword });
      setStatus('success');
      setMessage('Password updated');
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setTimeout(() => setStatus('idle'), 3000);
    } catch (err: any) {
      setStatus('error');
      setMessage(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="bg-surface rounded-xl border p-6 mb-6">
      <h3 className="text-sm font-semibold text-on-surface mb-4 flex items-center gap-2">
        <Icon name="lock" className="text-base" /> Change Password
      </h3>
      <div className="space-y-4">
        <div>
          <TextField label="Current Password" type="password" value={currentPassword} onChange={setCurrentPassword} />
        </div>
        <div>
          <TextField label="New Password" type="password" value={newPassword} onChange={setNewPassword} />
        </div>
        <div>
          <TextField label="Confirm New Password" type="password" value={confirmPassword} onChange={setConfirmPassword} />
        </div>
        {status !== 'idle' && (
          <div className={`flex items-center gap-2 text-sm ${status === 'success' ? 'text-success' : 'text-error'}`}>
            {status === 'success' ? <Icon name="check_circle" className="text-base" /> : <Icon name="cancel" className="text-base" />}
            {message}
          </div>
        )}
        <button onClick={handleChangePassword} disabled={saving} className="m3-button gap-2 disabled:opacity-50">
          <Icon name="lock_reset" className="text-base" /> {saving ? 'Updating...' : 'Update Password'}
        </button>
      </div>
    </div>
  );
}

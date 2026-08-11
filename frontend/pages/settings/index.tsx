import { useAssistantContext } from '@/hooks/useAssistantContext';
import Link from 'next/link';
import { Icon } from '@/components/ui/Icon';
import { useAuth } from '@/lib/auth-context';
import { BrandLogo } from '@/components/BrandLogo';
import * as Separator from '@radix-ui/react-separator';

export default function SettingsIndex() {
  const { user } = useAuth();
  const can = (perm: string) => user?.permissions?.includes(perm) ?? false;
  const backHref = user && !can('flow:create') ? '/approvals' : '/';
  useAssistantContext({ pageKey: 'settings', description: 'Settings overview' });
  const sections: { href: string; icon: string; title: string; description: string }[] = [
    {
      href: '/settings/secrets',
      icon: 'key',
      title: 'Secrets',
      description: 'Manage app-wide, group, and flow-scoped secrets for secure credential storage',
    },
    {
      href: '/settings/env-vars',
      icon: 'settings_applications',
      title: 'Environment Variables',
      description: 'Manage environment variables for app-wide and group-level configuration',
    },
    {
      href: '/settings/endpoints',
      icon: 'memory',
      title: 'LLM Endpoints',
      description: 'Manage your LLM provider connections — Anthropic, OpenAI, and LiteLLM',
    },
    {
      href: '/settings/mcp-servers',
      icon: 'dns',
      title: 'MCP Servers',
      description: 'Configure Model Context Protocol servers and their available tools',
    },
    {
      href: '/settings/knowledge',
      icon: 'book',
      title: 'Knowledge Bases',
      description: 'Upload documents, manage collections, and configure RAG retrieval',
    },
    ...(can('admin') ? [{
      href: '/settings/secret-vaults',
      icon: 'lock',
      title: 'Secret Vaults',
      description: 'Manage external secret vault connections for credential lookup',
    }] : []),
    ...(can('admin') ? [{
      href: '/settings/users',
      icon: 'shield',
      title: 'Users',
      description: 'Manage user accounts and roles',
    }] : []),
    {
      href: '/settings/groups',
      icon: 'group',
      title: 'Groups',
      description: 'Manage user groups for flow visibility and HITL assignment',
    },
    ...((can('admin') || (user as any)?.groups?.some((g: any) => g.role === 'admin')) ? [{
      href: '/settings/global-context',
      icon: 'language',
      title: 'Global Context',
      description: 'Set the global system context or per-group context for LLM agents',
    }] : []),
    ...(can('admin') ? [{
      href: '/settings/executions',
      icon: 'pause_circle',
      title: 'Pending Approvals',
      description: 'View and manage executions awaiting human approval',
    }] : []),
    ...(can('admin') ? [{
      href: '/settings/sso',
      icon: 'key',
      title: 'SSO / OIDC',
      description: 'Configure single sign-on with your identity provider',
    }] : []),
  ];

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
            <Link href={backHref} className="flex items-center gap-1 leading-none text-on-surface-variant hover:text-on-surface-variant">
              <Icon name="arrow_back" className="text-base" /> <span>Back</span>
            </Link>
          </div>
          <Separator.Root orientation="vertical" className="w-px h-6 bg-outline-variant" />
          <div>
            <h1 className="text-2xl font-bold text-on-surface">Settings</h1>
            <p className="text-sm text-on-surface-variant mt-1">Manage your central resources</p>
          </div>
        </div>
        <div className="space-y-3">
          {sections.map((s) => (
            <Link
              key={s.href}
              href={s.href}
              className="block bg-surface rounded-lg border border-outline-variant p-4 hover:shadow-sm hover:border-primary transition-all"
            >
              <div className="flex items-center gap-3">
                <Icon name={s.icon} className="text-xl text-primary" />
                <div>
                  <p className="font-medium text-on-surface">{s.title}</p>
                  <p className="text-sm text-on-surface-variant">{s.description}</p>
                </div>
              </div>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}

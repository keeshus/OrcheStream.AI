import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const cyberark = await import('orchestream-ai-shared');

const CONFIG = {
  baseUrl: 'https://conjur.example.com',
  account: 'myorg',
  login: 'host%2Fmyapp',
  apiKey: 'myapp-api-key-456',
};

describe('CyberArk Conjur service', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    cyberark.clearTokenCache();
  });

  // ─── authenticate ────────────────────────────────────────────────

  describe('authenticate', () => {
    it('returns token on successful auth', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: async () => 'dG9rZW5fYmFzZTY0X2VuY29kZWQ', // base64 token
      });

      const token = await cyberark.authenticate(CONFIG);
      expect(token).toBe('dG9rZW5fYmFzZTY0X2VuY29kZWQ');
      expect(mockFetch).toHaveBeenCalledTimes(1);

      const callUrl = mockFetch.mock.calls[0][0];
      expect(callUrl).toContain('/api/authn/myorg/host%252Fmyapp/authenticate');
    });

    it('sends apiKey as raw text body', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: async () => 'tok123',
      });

      await cyberark.authenticate(CONFIG);
      const options = mockFetch.mock.calls[0][1];
      expect(options.method).toBe('POST');
      expect(options.headers['Content-Type']).toBe('text/plain');
      expect(options.headers['Accept-Encoding']).toBe('base64');
      expect(options.body).toBe('myapp-api-key-456');
    });

    it('uses self-hosted path without /api prefix', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: async () => 'tok_sh',
      });

      await cyberark.authenticate({ ...CONFIG, selfHosted: true });
      const callUrl = mockFetch.mock.calls[0][0];
      expect(callUrl).toContain('/authn/myorg/host%252Fmyapp/authenticate');
      expect(callUrl).not.toContain('/api/authn');
    });

    it('throws on auth failure', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: async () => 'Unauthorized',
      });

      await expect(cyberark.authenticate(CONFIG)).rejects.toThrow('Conjur auth failed: 401 Unauthorized');
    });

    it('uses AbortController signal for timeout', async () => {
      mockFetch.mockImplementationOnce(async (_url: string, opts: any) => {
        expect(opts.signal).toBeDefined();
        expect(opts.signal instanceof AbortSignal).toBe(true);
        return { ok: true, text: async () => 'tok_signal' };
      });
      const token = await cyberark.authenticate(CONFIG);
      expect(token).toBe('tok_signal');
    });

    // ── Token caching ──────────────────────────────────────────

    it('caches token and reuses within 8-min TTL', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: async () => 'tok_cached',
      });

      const t1 = await cyberark.authenticate(CONFIG);
      const t2 = await cyberark.authenticate(CONFIG);

      expect(t1).toBe('tok_cached');
      expect(t2).toBe('tok_cached');
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('caches per account+login combination', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        text: async () => 'tok_x',
      });

      await cyberark.authenticate(CONFIG);
      await cyberark.authenticate({ ...CONFIG, login: 'host%2Fother' });
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });

  // ─── getSecret ───────────────────────────────────────────────────

  describe('getSecret', () => {
    it('returns secret value on success', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, text: async () => 'tok_s' });
      mockFetch.mockResolvedValueOnce({ ok: true, text: async () => 'my-db-password!' });

      const value = await cyberark.getSecret(CONFIG, 'prod/db/password');
      expect(value).toBe('my-db-password!');
    });

    it('sends Token token header', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, text: async () => 'tok_secret' });
      mockFetch.mockResolvedValueOnce({ ok: true, text: async () => 'x' });

      await cyberark.getSecret(CONFIG, 'some/path');
      const secretCall = mockFetch.mock.calls[1];
      expect(secretCall[0]).toContain('/api/secrets/myorg/variable/some%2Fpath');
      expect(secretCall[1].headers.Authorization).toBe('Token token="tok_secret"');
    });

    it('uses self-hosted path for secret retrieval', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, text: async () => 'tok_sh' });
      mockFetch.mockResolvedValueOnce({ ok: true, text: async () => 'val' });

      await cyberark.getSecret({ ...CONFIG, selfHosted: true }, 'prod/db/password');
      const callUrl = mockFetch.mock.calls[1][0];
      expect(callUrl).toContain('/secrets/myorg/variable/prod%2Fdb%2Fpassword');
      expect(callUrl).not.toContain('/api/');
    });

    it('throws on 404', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, text: async () => 'tok' });
      mockFetch.mockResolvedValueOnce({ ok: false, status: 404, text: async () => 'Not Found' });

      await expect(cyberark.getSecret(CONFIG, 'nonexistent')).rejects.toThrow("Secret 'nonexistent' not found in Conjur");
    });

    it('throws on 403', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, text: async () => 'tok' });
      mockFetch.mockResolvedValueOnce({ ok: false, status: 403, text: async () => 'Forbidden' });

      await expect(cyberark.getSecret(CONFIG, 'restricted')).rejects.toThrow("Access denied to secret 'restricted' in Conjur");
    });

    it('retries once on 401 (stale token)', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, text: async () => 'tok_stale' });
      mockFetch.mockResolvedValueOnce({ ok: false, status: 401, text: async () => 'Unauthorized' });
      mockFetch.mockResolvedValueOnce({ ok: true, text: async () => 'tok_fresh' });
      mockFetch.mockResolvedValueOnce({ ok: true, text: async () => 'retried-value' });

      const value = await cyberark.getSecret(CONFIG, 'db/pass');
      expect(value).toBe('retried-value');
      expect(mockFetch).toHaveBeenCalledTimes(4);
    });
  });

  // ─── testConnection ──────────────────────────────────────────────

  describe('testConnection', () => {
    it('returns success on valid credentials', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, text: async () => 'tok_test' });

      const result = await cyberark.testConnection(CONFIG);
      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('returns error on failure', async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 401, text: async () => 'Bad' });

      const result = await cyberark.testConnection(CONFIG);
      expect(result.success).toBe(false);
      expect(result.error).toContain('Conjur auth failed');
    });

    it('handles network errors', async () => {
      mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));

      const result = await cyberark.testConnection(CONFIG);
      expect(result.success).toBe(false);
      expect(result.error).toBeTruthy();
    });
  });

  // ─── CA cert support ─────────────────────────────────────────────

  describe('CA certificate support', () => {
    it('passes caCert as https agent when provided', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, text: async () => 'tok_ca' });

      await cyberark.authenticate({
        ...CONFIG,
        caCert: '-----BEGIN CERTIFICATE-----\nFAKE\n-----END CERTIFICATE-----',
      });

      const options = mockFetch.mock.calls[0][1];
      expect(options.agent).toBeDefined();
      expect(options.agent.options.ca).toContain('FAKE');
    });

    it('does not set https agent when caCert is omitted', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, text: async () => 'tok' });
      await cyberark.authenticate(CONFIG);
      expect(mockFetch.mock.calls[0][1].agent).toBeUndefined();
    });
  });

  // ─── clearTokenCache ─────────────────────────────────────────────

  describe('clearTokenCache', () => {
    it('forces fresh auth on next call', async () => {
      mockFetch.mockResolvedValue({ ok: true, text: async () => 'tok_clr' });
      await cyberark.authenticate(CONFIG);
      cyberark.clearTokenCache();
      await cyberark.authenticate(CONFIG);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });
});

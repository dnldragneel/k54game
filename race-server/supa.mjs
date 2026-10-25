// Dependency-free Supabase REST/Auth helpers (service-role calls and token checks).
export function makeSupa({ url, anonKey, serviceKey, fetchImpl = fetch }) {
  const base = String(url || '').replace(/\/+$/, '');
  return {
    async getUser(token) {
      if (!token || typeof token !== 'string' || token.length > 4096) return null;
      const res = await fetchImpl(`${base}/auth/v1/user`, { headers: { apikey: anonKey, authorization: `Bearer ${token}` } });
      if (res.status === 401 || res.status === 403) return null;
      if (!res.ok) throw new Error('auth_unavailable_' + res.status);
      const u = await res.json();
      return u?.id ? { id: u.id, email: u.email || null, anonymous: !!u.is_anonymous } : null;
    },
    async rpc(fn, args) {
      const res = await fetchImpl(`${base}/rest/v1/rpc/${fn}`, {
        method: 'POST', headers: { apikey: serviceKey, authorization: `Bearer ${serviceKey}`, 'content-type': 'application/json' }, body: JSON.stringify(args),
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`rpc_${fn}_${res.status}: ${text.slice(0, 200)}`);
      return text ? JSON.parse(text) : null;
    },
  };
}

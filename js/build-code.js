export function encodeBuildCode(paramsText) {
  const binary = btoa(unescape(encodeURIComponent(paramsText)));
  return `DCB1-${binary.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')}`;
}

export function decodeBuildCode(code) {
  const normalized = String(code || '').trim().replace(/\s+/g, '');
  if (!normalized.toUpperCase().startsWith('DCB1-')) return null;
  const payload = normalized.slice(5).replace(/-/g, '+').replace(/_/g, '/');
  if (!payload) return null;
  const padded = payload.padEnd(Math.ceil(payload.length / 4) * 4, '=');
  try {
    const decoded = decodeURIComponent(escape(atob(padded)));
    return decoded || null;
  } catch {
    return null;
  }
}

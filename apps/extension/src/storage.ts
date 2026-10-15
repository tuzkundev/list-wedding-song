const STORAGE_PREFIX = 'wedding-music:';

function isWebEnvironment(): boolean {
  return typeof window !== 'undefined' && (window.location.protocol === 'http:' || window.location.protocol === 'https:');
}

export async function readStorage<T>(key: string): Promise<T | undefined> {
  if (typeof chrome !== 'undefined' && chrome.storage?.local !== undefined) {
    const values = await chrome.storage.local.get(key);
    return Object.prototype.hasOwnProperty.call(values, key) ? (values[key] as T) : undefined;
  }

  if (isWebEnvironment() && (key === 'playlistState' || key === 'rightsAccepted')) {
    try {
      const response = await fetch('/api/state', { signal: AbortSignal.timeout(8_000) });
      if (response.ok) {
        const data = (await response.json()) as { text?: string; playlist?: unknown; rightsAccepted?: boolean; updatedAt?: number };
        if (data.updatedAt && data.updatedAt > 0) {
          localStorage.setItem(`${STORAGE_PREFIX}playlistState`, JSON.stringify({ text: data.text ?? '', playlist: data.playlist ?? null }));
          localStorage.setItem(`${STORAGE_PREFIX}rightsAccepted`, JSON.stringify(data.rightsAccepted ?? true));
          return (key === 'playlistState' ? { text: data.text ?? '', playlist: data.playlist ?? null } : (data.rightsAccepted ?? true)) as T;
        }
      }
    } catch {
      // Fall back to localStorage cache if offline
    }
  }

  const raw = localStorage.getItem(`${STORAGE_PREFIX}${key}`);
  return raw === null ? undefined : (JSON.parse(raw) as T);
}

export async function writeStorage<T>(key: string, value: T): Promise<void> {
  if (typeof chrome !== 'undefined' && chrome.storage?.local !== undefined) {
    await chrome.storage.local.set({ [key]: value });
    return;
  }

  const serialized = JSON.stringify(value);
  if (serialized !== undefined) {
    localStorage.setItem(`${STORAGE_PREFIX}${key}`, serialized);
  }

  if (isWebEnvironment() && (key === 'playlistState' || key === 'rightsAccepted')) {
    try {
      const stateRaw = localStorage.getItem(`${STORAGE_PREFIX}playlistState`);
      const rightsRaw = localStorage.getItem(`${STORAGE_PREFIX}rightsAccepted`);
      const state = stateRaw ? (JSON.parse(stateRaw) as { text?: string; playlist?: unknown }) : { text: '', playlist: null };
      const rightsAccepted = rightsRaw ? (JSON.parse(rightsRaw) as boolean) : true;
      await fetch('/api/state', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: state.text ?? '',
          playlist: state.playlist ?? null,
          rightsAccepted,
        }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      // Keep localStorage copy if network temporarily unavailable
    }
  }
}

const STORAGE_PREFIX = 'wedding-music:';
const CLOUD_KEY_STORAGE = `${STORAGE_PREFIX}cloudKey`;
const WORKSPACE_ID_STORAGE = `${STORAGE_PREFIX}workspaceId`;

let pendingKeyPromise: Promise<string | null> | null = null;

function isWebEnvironment(): boolean {
  return typeof window !== 'undefined' && (window.location.protocol === 'http:' || window.location.protocol === 'https:');
}

export function getWorkspaceId(): string {
  if (typeof window === 'undefined') return 'default';
  let id = localStorage.getItem(WORKSPACE_ID_STORAGE);
  if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
    id = crypto.randomUUID();
    localStorage.setItem(WORKSPACE_ID_STORAGE, id);
  }
  return id;
}
let memoryCachedKey: string | null = null;

export async function resolveCloudKey(): Promise<string | null> {
  if (typeof window === 'undefined') return null;
  const hashMatch = /(?:^|[#&?])key=([a-f0-9]{16,64})(?:&|$)/i.exec(window.location.hash || window.location.search);
  if (hashMatch) {
    const key = hashMatch[1];
    memoryCachedKey = key;
    localStorage.setItem(CLOUD_KEY_STORAGE, key);
    window.history.replaceState(null, '', window.location.pathname);
    return key;
  }
  if (memoryCachedKey) return memoryCachedKey;
  const saved = localStorage.getItem(CLOUD_KEY_STORAGE);
  if (saved && /^[a-f0-9]{16,64}$/i.test(saved)) {
    memoryCachedKey = saved;
    return saved;
  }

  if (pendingKeyPromise) return pendingKeyPromise;
  pendingKeyPromise = (async () => {
    try {
      const resp = await fetch('http://127.0.0.1:43127/api/cloud-key', { signal: AbortSignal.timeout(1_200) });
      if (resp.ok) {
        const data = (await resp.json()) as { cloudKey?: string | null; shareKey?: string | null };
        const key = data.cloudKey ?? data.shareKey ?? null;
        if (key && /^[a-f0-9]{16,64}$/i.test(key)) {
          memoryCachedKey = key;
          localStorage.setItem(CLOUD_KEY_STORAGE, key);
          return key;
        }
      }
    } catch {
      // Not on owner Mac
    }
    if (isWebEnvironment()) {
      try {
        const infoResp = await fetch('/api/share-info', { signal: AbortSignal.timeout(4_000) });
        if (infoResp.ok) {
          const info = (await infoResp.json()) as { shareKey?: string | null };
          if (info.shareKey && /^[a-f0-9]{16,64}$/i.test(info.shareKey)) {
            memoryCachedKey = info.shareKey;
            localStorage.setItem(CLOUD_KEY_STORAGE, info.shareKey);
            return info.shareKey;
          }
        }
      } catch {
        // Ignore
      }
    }
    return null;
  })().finally(() => {
    pendingKeyPromise = null;
  });
  return pendingKeyPromise;
}

export async function readStorage<T>(key: string): Promise<T | undefined> {
  if (typeof chrome !== 'undefined' && chrome.storage?.local !== undefined) {
    const values = await chrome.storage.local.get(key);
    return Object.prototype.hasOwnProperty.call(values, key) ? (values[key] as T) : undefined;
  }

  if (isWebEnvironment() && (key === 'playlistState' || key === 'rightsAccepted')) {
    try {
      const cloudKey = await resolveCloudKey();
      const headers: Record<string, string> = { 'X-Workspace-Id': getWorkspaceId() };
      if (cloudKey) headers.Authorization = `Bearer ${cloudKey}`;
      const response = await fetch('/api/state', {
        headers,
        signal: AbortSignal.timeout(8_000),
      });
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
      const cloudKey = await resolveCloudKey();
      const stateRaw = localStorage.getItem(`${STORAGE_PREFIX}playlistState`);
      const rightsRaw = localStorage.getItem(`${STORAGE_PREFIX}rightsAccepted`);
      const state = stateRaw ? (JSON.parse(stateRaw) as { text?: string; playlist?: unknown }) : { text: '', playlist: null };
      const rightsAccepted = rightsRaw ? (JSON.parse(rightsRaw) as boolean) : true;
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'X-Workspace-Id': getWorkspaceId(),
      };
      if (cloudKey) headers.Authorization = `Bearer ${cloudKey}`;
      await fetch('/api/state', {
        method: 'PUT',
        headers,
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

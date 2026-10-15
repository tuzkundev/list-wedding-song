const DEV_STORAGE_PREFIX = "wedding-music:";


export async function readStorage<T>(key: string): Promise<T | undefined> {
  if (typeof chrome !== "undefined" && chrome.storage?.local !== undefined) {
    const values = await chrome.storage.local.get(key);
    return Object.prototype.hasOwnProperty.call(values, key)
      ? (values[key] as T)
      : undefined;
  }

  if (import.meta.env.DEV) {
    const value = localStorage.getItem(`${DEV_STORAGE_PREFIX}${key}`);
    return value === null ? undefined : (JSON.parse(value) as T);
  }

  throw new Error("Không thể truy cập bộ nhớ của tiện ích.");
}

export async function writeStorage<T>(key: string, value: T): Promise<void> {
  if (typeof chrome !== "undefined" && chrome.storage?.local !== undefined) {
    await chrome.storage.local.set({ [key]: value });
    return;
  }

  if (import.meta.env.DEV) {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) {
      throw new TypeError("Giá trị không thể lưu trong bộ nhớ trình duyệt.");
    }
    localStorage.setItem(`${DEV_STORAGE_PREFIX}${key}`, serialized);
    return;
  }

  throw new Error("Không thể truy cập bộ nhớ của tiện ích.");
}

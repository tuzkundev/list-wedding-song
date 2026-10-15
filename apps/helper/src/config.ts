import { chmod, lstat, mkdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export const HELPER_HOST = '127.0.0.1';
export const HELPER_PORT = 43127;
export const HELPER_VERSION = '1.0.0';
export const DEVELOPMENT_ORIGIN = 'http://localhost:5173';

export interface HelperConfig {
  host: typeof HELPER_HOST;
  port: typeof HELPER_PORT;
  dataDir: string;
  assetsDir: string;
  exportsDir: string;
  devOrigin: typeof DEVELOPMENT_ORIGIN | null;
  cloudKey: string | null;
}

export interface LoadConfigOptions {
  dataDir?: string;
  env?: NodeJS.ProcessEnv;
}

export async function loadConfig(options: LoadConfigOptions = {}): Promise<HelperConfig> {
  const dataDir = resolve(options.dataDir ?? join(homedir(), '.wedding-music'));
  const assetsDir = join(dataDir, 'assets');
  const exportsDir = join(dataDir, 'exports');

  await ensurePrivateDirectory(dataDir);
  await ensurePrivateDirectory(assetsDir);
  await ensurePrivateDirectory(exportsDir);

  const cloudKey = await readFile(join(dataDir, 'cloud-key'), 'utf8').then(s => s.trim() || null).catch(() => null);
  const env = options.env ?? process.env;
  return {
    host: HELPER_HOST,
    port: HELPER_PORT,
    dataDir,
    assetsDir,
    exportsDir,
    devOrigin: env.WEDDING_DEV_ORIGIN === '0' ? null : DEVELOPMENT_ORIGIN,
    cloudKey,
  };
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stats = await lstat(directory);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(`Expected a real directory: ${directory}`);
  }
  await chmod(directory, 0o700);
}

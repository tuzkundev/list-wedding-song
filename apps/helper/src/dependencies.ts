import type { Health } from '@wedding/shared/api';
import { runProcess } from './process.js';

type DependencyStatus = Health['dependencies'][keyof Health['dependencies']];
type DependencyStatuses = Health['dependencies'];

export interface DependencyCheck {
  dependencies: DependencyStatuses;
  ytDlpRuntimeArgs: string[];
}

interface JavaScriptRuntime {
  available: boolean;
  args: string[];
  error: string | null;
}

export async function checkDependencies(): Promise<DependencyCheck> {
  const [ytDlpProbe, ffmpeg, ffprobe, runtime] = await Promise.all([
    probe('yt-dlp', ['--version']),
    probe('ffmpeg', ['-version']),
    probe('ffprobe', ['-version']),
    findJavaScriptRuntime(),
  ]);

  const ytDlpErrors = [ytDlpProbe.error, runtime.error].filter((error): error is string => error !== null);
  return {
    dependencies: {
      ytDlp: {
        available: ytDlpProbe.available && runtime.available,
        version: ytDlpProbe.version,
        error: ytDlpErrors.length ? ytDlpErrors.join(' ') : null,
      },
      ffmpeg,
      ffprobe,
    },
    ytDlpRuntimeArgs: runtime.args,
  };
}

async function probe(binary: string, args: string[]): Promise<DependencyStatus> {
  try {
    const result = await runProcess(binary, args, { timeoutMs: 10_000, maxBytes: 64 * 1024 });
    const output = result.stdout.toString('utf8').trim();
    const version = readVersion(binary, output);
    if (!version) {
      return {
        available: false,
        version: null,
        error: `${binary} returned no recognizable version information.`,
      };
    }
    return { available: true, version, error: null };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      available: false,
      version: null,
      error: `${binary} is unavailable: ${detail}`,
    };
  }
}

async function findJavaScriptRuntime(): Promise<JavaScriptRuntime> {
  const deno = await probe('deno', ['--version']);
  if (deno.available) {
    return { available: true, args: ['--js-runtimes', 'deno'], error: null };
  }

  const node = await probe('node', ['--version']);
  const majorVersion = node.version ? Number(/^v?(\d+)/.exec(node.version)?.[1]) : Number.NaN;
  if (node.available && Number.isFinite(majorVersion) && majorVersion >= 22) {
    return { available: true, args: ['--js-runtimes', 'node'], error: null };
  }

  const detectedVersion = node.version ? ` Detected Node.js ${node.version}.` : '';
  const runtimeError = `yt-dlp needs Deno or Node.js 22+ as its JavaScript runtime.${detectedVersion} Install Deno or Node.js 22+.`;
  return {
    available: false,
    args: [],
    error: `${runtimeError} ${deno.error ?? ''} ${node.error ?? ''}`.trim(),
  };
}

function readVersion(binary: string, output: string): string | null {
  if (!output) return null;
  if (binary === 'ffmpeg' || binary === 'ffprobe') {
    return /\bversion\s+([^\s]+)/.exec(output)?.[1] ?? output.split(/\r?\n/, 1)[0] ?? null;
  }
  return output.split(/\r?\n/, 1)[0] ?? null;
}


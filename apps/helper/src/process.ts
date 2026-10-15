import { spawn, type ChildProcess } from 'node:child_process';

const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const FORCE_KILL_DELAY_MS = 1_000;

export interface RunProcessOptions {
  timeoutMs: number;
  signal?: AbortSignal;
  cwd?: string;
  maxBytes?: number;
}

export interface ProcessResult {
  stdout: Buffer;
  stderr: string;
}

export type ProcessFailureReason = 'spawn' | 'exit' | 'timeout' | 'aborted' | 'output-limit';

export class ProcessExecutionError extends Error {
  constructor(
    message: string,
    readonly reason: ProcessFailureReason,
    readonly stdout: Buffer,
    readonly stderr: string,
    readonly exitCode: number | null = null,
    readonly signal: NodeJS.Signals | null = null,
  ) {
    super(message);
    this.name = 'ProcessExecutionError';
  }
}

export async function runProcess(
  binary: string,
  args: readonly string[],
  options: RunProcessOptions,
): Promise<ProcessResult> {
  if (!binary) throw new TypeError('A process binary is required.');
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new RangeError('timeoutMs must be a positive finite number.');
  }

  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError('maxBytes must be a non-negative safe integer.');
  }
  if (options.signal?.aborted) {
    throw new ProcessExecutionError('Process was aborted before it started.', 'aborted', Buffer.alloc(0), '');
  }

  let child: ChildProcess;
  try {
    child = spawn(binary, args, {
      cwd: options.cwd,
      detached: process.platform !== 'win32',
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    throw new ProcessExecutionError(error instanceof Error ? error.message : String(error), 'spawn', Buffer.alloc(0), '');
  }

  const { promise, resolve, reject } = Promise.withResolvers<ProcessResult>();
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let failure: { reason: ProcessFailureReason; message: string } | undefined;
  let forceKillTimer: NodeJS.Timeout | undefined;

  const terminateProcessGroup = (): void => {
    const pid = child.pid;
    if (pid === undefined) return;
    if (process.platform !== 'win32') {
      try {
        process.kill(-pid, 'SIGTERM');
      } catch (error) {
        if (errorCode(error) !== 'ESRCH') child.kill('SIGTERM');
      }
    } else {
      child.kill('SIGTERM');
    }
    forceKillTimer = setTimeout(() => killProcessGroup(child), FORCE_KILL_DELAY_MS);
  };

  const failAndTerminate = (reason: ProcessFailureReason, message: string): void => {
    if (failure) return;
    failure = { reason, message };
    terminateProcessGroup();
  };

  const capture = (chunk: Buffer, chunks: Buffer[], currentBytes: number): number => {
    const available = maxBytes - currentBytes;
    const acceptedBytes = Math.max(0, Math.min(chunk.length, available));
    if (acceptedBytes > 0) chunks.push(chunk.subarray(0, acceptedBytes));
    if (acceptedBytes < chunk.length) {
      failAndTerminate('output-limit', `Process output exceeded the ${maxBytes}-byte limit.`);
    }
    return currentBytes + acceptedBytes;
  };

  const stdout = child.stdout;
  const stderr = child.stderr;
  if (!stdout || !stderr) {
    failAndTerminate('spawn', 'Process output streams were unavailable.');
  } else {
    stdout.on('data', (chunk: Buffer) => {
      stdoutBytes = capture(chunk, stdoutChunks, stdoutBytes);
    });
    stderr.on('data', (chunk: Buffer) => {
      stderrBytes = capture(chunk, stderrChunks, stderrBytes);
    });
  }

  const timeout = setTimeout(() => {
    failAndTerminate('timeout', `Process exceeded its ${options.timeoutMs} ms timeout.`);
  }, options.timeoutMs);
  const onAbort = (): void => failAndTerminate('aborted', 'Process was aborted.');
  options.signal?.addEventListener('abort', onAbort, { once: true });
  if (options.signal?.aborted) onAbort();

  child.once('error', error => {
    failAndTerminate('spawn', `Unable to start process: ${error.message}`);
  });
  child.once('close', (exitCode, signal) => {
    clearTimeout(timeout);
    if (!failure) {
      clearTimeout(forceKillTimer);
      forceKillTimer = undefined;
    }
    options.signal?.removeEventListener('abort', onAbort);

    const stdoutBuffer = Buffer.concat(stdoutChunks, stdoutBytes);
    const stderrText = Buffer.concat(stderrChunks, stderrBytes).toString('utf8');
    if (failure) {
      reject(new ProcessExecutionError(failure.message, failure.reason, stdoutBuffer, stderrText, exitCode, signal));
      return;
    }
    if (exitCode !== 0) {
      const detail = stderrText.trim();
      const reason = signal ? `signal ${signal}` : `code ${String(exitCode)}`;
      reject(new ProcessExecutionError(`Process exited with ${reason}${detail ? `: ${detail}` : ''}.`, 'exit', stdoutBuffer, stderrText, exitCode, signal));
      return;
    }
    resolve({ stdout: stdoutBuffer, stderr: stderrText });
  });
  return promise;
}

function killProcessGroup(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) return;
  if (process.platform !== 'win32') {
    try {
      process.kill(-pid, 'SIGKILL');
      return;
    } catch (error) {
      if (errorCode(error) === 'ESRCH') return;
    }
  }
  child.kill('SIGKILL');
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;
}


import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { checkDependencies } from './dependencies.js';
import { loadConfig } from './config.js';
import { createApp } from './server.js';
import { createRoutes } from './routes.js';

export async function startHelper(): Promise<Server> {
  const config = await loadConfig();
  const dependencyCheck = await checkDependencies();
  const server = createServer(createApp(config, dependencyCheck.dependencies, createRoutes(config, dependencyCheck)));
  const startup = Promise.withResolvers<void>();
  const onError = (error: Error): void => startup.reject(error);
  const onListening = (): void => {
    server.off('error', onError);
    startup.resolve();
  };

  server.once('error', onError);
  server.once('listening', onListening);
  server.listen(config.port, config.host);
  await startup.promise;

  console.log(`Wedding music helper listening at http://${config.host}:${config.port} (auto-connect enabled)`);
  for (const [name, dependency] of Object.entries(dependencyCheck.dependencies)) {
    if (!dependency.available) console.error(`${name}: ${dependency.error ?? 'Unavailable.'}`);
  }
  if (config.cloudKey) startCloudflaredBridge(config.port, config.cloudKey);
  return server;
}
function startCloudflaredBridge(port: number, cloudKey: string): void {
  try {
    const child = spawn(
      'cloudflared',
      ['tunnel', '--no-autoupdate', '--http-host-header', `127.0.0.1:${port}`, '--url', `http://127.0.0.1:${port}`],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const onChunk = (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      const match = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i.exec(text);
      if (match) {
        const tunnelUrl = match[0];
        void fetch('https://list-wedding-song.nguyenqq611.workers.dev/api/tunnel', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cloudKey}` },
          body: JSON.stringify({ tunnelUrl }),
        }).catch(() => undefined);
      }
    };
    child.stdout?.on('data', onChunk);
    child.stderr?.on('data', onChunk);
    child.on('error', () => undefined);
    const cleanup = () => { try { child.kill('SIGTERM'); } catch {} };
    process.once('exit', cleanup);
    process.once('SIGTERM', cleanup);
    process.once('SIGINT', cleanup);
  } catch {
    // Optional cloudflared bridge
  }
}

const entrypoint = process.argv[1] ? resolve(process.argv[1]) : '';
if (entrypoint && fileURLToPath(import.meta.url) === entrypoint) {
  startHelper().catch(error => {
    console.error('Unable to start wedding music helper:', error);
    process.exitCode = 1;
  });
}

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
  return server;
}

const entrypoint = process.argv[1] ? resolve(process.argv[1]) : '';
if (entrypoint && fileURLToPath(import.meta.url) === entrypoint) {
  startHelper().catch(error => {
    console.error('Unable to start wedding music helper:', error);
    process.exitCode = 1;
  });
}

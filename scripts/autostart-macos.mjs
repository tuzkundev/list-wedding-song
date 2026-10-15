import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const label = 'com.weddingmusic.helper';
const launchAgentsDir = join(homedir(), 'Library', 'LaunchAgents');
const plistPath = join(launchAgentsDir, `${label}.plist`);
const logDir = join(homedir(), '.wedding-music');
const nodeBin = process.execPath;
const tsxCli = join(rootDir, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const helperEntry = join(rootDir, 'apps', 'helper', 'src', 'index.ts');
const mode = process.argv[2] ?? 'install';

if (mode === 'uninstall') {
  try { execFileSync('launchctl', ['unload', plistPath], { stdio: 'ignore' }); } catch {}
  rmSync(plistPath, { force: true });
  console.log(`Đã gỡ tự khởi động nền (${plistPath}).`);
  process.exit(0);
}

mkdirSync(launchAgentsDir, { recursive: true });
mkdirSync(logDir, { recursive: true, mode: 0o700 });

const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodeBin}</string>
    <string>${tsxCli}</string>
    <string>${helperEntry}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${rootDir}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${dirname(nodeBin)}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${join(logDir, 'helper.log')}</string>
  <key>StandardErrorPath</key>
  <string>${join(logDir, 'helper.err.log')}</string>
</dict>
</plist>
`;

writeFileSync(plistPath, plist, 'utf8');
try { execFileSync('launchctl', ['unload', plistPath], { stdio: 'ignore' }); } catch {}
try {
  execFileSync('pkill', ['-f', 'cloudflared tunnel --no-autoupdate --http-host-header 127.0.0.1:43127'], { stdio: 'ignore' });
} catch {}
try {
  const pids = execFileSync('lsof', ['-ti', 'tcp:43127'], { encoding: 'utf8' }).trim().split(/\s+/).filter(Boolean);
  for (const pid of pids) { try { process.kill(Number(pid), 'SIGKILL'); } catch {} }
} catch {}
execFileSync('launchctl', ['load', '-w', plistPath], { stdio: 'inherit' });
console.log(`Đã bật dịch vụ chạy nền tự động khi mở máy: ${plistPath}`);

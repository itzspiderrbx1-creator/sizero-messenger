const { spawn } = require('child_process');
const path = require('path');

function run(cmd, args, opts = {}) {
  const p = spawn(cmd, args, {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    ...opts,
  });
  return p;
}

const root = path.join(__dirname, '..');

// 1) сервер
const server = run('npm', ['--prefix', path.join(root, 'server'), 'run', 'dev'], {
  env: { ...process.env, PORT: process.env.PORT || '4000' },
});

// 2) клиент (Vite)
const client = run('npm', ['--prefix', path.join(root, 'client'), 'run', 'dev', '--', '--host', '127.0.0.1', '--port', '5173']);

// 3) Electron
const electron = run('npx', ['electron', path.join(__dirname, 'main.cjs')], {
  env: { ...process.env, SIZERO_DEV_URL: 'http://localhost:5173' },
});

function shutdown() {
  for (const p of [electron, client, server]) {
    if (!p || p.killed) continue;
    try { p.kill(); } catch {}
  }
}

process.on('SIGINT', () => { shutdown(); process.exit(0); });
process.on('SIGTERM', () => { shutdown(); process.exit(0); });

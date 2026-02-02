const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, {
    cwd,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (r.status !== 0) {
    process.exit(r.status ?? 1);
  }
}

const root = path.join(__dirname, '..');
const appDir = path.join(__dirname, 'app');

fs.rmSync(appDir, { recursive: true, force: true });
fs.mkdirSync(appDir, { recursive: true });

// 1) Собираем клиент
run('npm', ['--prefix', path.join(root, 'client'), 'install'], root);
run('npm', ['--prefix', path.join(root, 'client'), 'run', 'build'], root);

// 2) Устанавливаем зависимости сервера (prod)
run('npm', ['--prefix', path.join(root, 'server'), 'install', '--omit=dev'], root);

// 3) Копируем артефакты
// Важно для Windows: в node_modules иногда бывают symlink'и (например, workspace/local deps).
// Обычный cpSync попытается создать symlink и упадёт с EPERM без прав администратора.
// dereference=true заставляет копировать содержимое, а не создавать symlink.
const cp = (src, dst) => fs.cpSync(src, dst, { recursive: true, dereference: true });

cp(path.join(root, 'client', 'dist'), path.join(appDir, 'client'));
cp(path.join(root, 'server'), path.join(appDir, 'server'));

console.log('[desktop] Prepared app/ with client build and server.');

const { app, BrowserWindow } = require('electron');
const path = require('path');
const { spawn } = require('child_process');

let serverProc = null;

const isDev = !app.isPackaged;

function startServer() {
  const serverEntry = isDev
    ? path.join(__dirname, '..', 'server', 'index.js')
    : path.join(process.resourcesPath, 'app', 'server', 'index.js');

  // В упакованном Electron нет отдельного node.exe, поэтому запускаем Electron как Node.
  const env = {
    ...process.env,
    PORT: process.env.PORT || '4000',
    ELECTRON_RUN_AS_NODE: '1',
  };

  serverProc = spawn(process.execPath, [serverEntry], {
    env,
    stdio: 'inherit',
  });

  serverProc.on('exit', (code) => {
    serverProc = null;
    if (code && code !== 0) {
      console.error(`[Sizero server] exited with code ${code}`);
    }
  });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1100,
    height: 760,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });

  if (isDev) {
    // Vite dev server
    win.loadURL(process.env.SIZERO_DEV_URL || 'http://localhost:5173');
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    // Статическая сборка клиента
    const indexHtml = path.join(process.resourcesPath, 'app', 'client', 'index.html');
    win.loadFile(indexHtml);
  }
}

app.whenReady().then(() => {
  startServer();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  if (serverProc) {
    serverProc.kill();
    serverProc = null;
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

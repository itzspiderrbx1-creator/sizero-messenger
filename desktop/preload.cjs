// Пока ничего не прокидываем в renderer.
// Файл оставлен для будущих интеграций (уведомления, автозапуск, файловая система и т.п.).

const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('sizero', {
  version: '0.1.0',
});

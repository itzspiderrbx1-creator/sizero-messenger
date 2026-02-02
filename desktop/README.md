# Sizero Messenger Desktop (Electron)

Эта папка добавляет Electron‑оболочку вокруг проекта и позволяет запускать **клиент + сервер** как обычное приложение на ПК.

## Требования

- Node.js LTS 18+ (лучше 20+)
- npm (идёт вместе с Node)

## Установка зависимостей

В корне проекта:

```bash
npm install
```

## Запуск в режиме разработки

```bash
npm run desktop:dev
```

Что происходит:
- Electron запускает сервер (Express + Socket.IO)
- Electron собирает/запускает Vite dev‑сервер и открывает его в окне приложения

## Сборка

### Windows (x64)

```bash
npm run desktop:build:win
```

### Linux

```bash
npm run desktop:build:linux
```

### macOS

```bash
npm run desktop:build:mac
```

Результат будет в `desktop/dist/`.

## Настройки

Порт сервера по умолчанию: `5179` (можно менять через `SIZERO_SERVER_PORT`).

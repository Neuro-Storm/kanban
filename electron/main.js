/*
 * Главный процесс Electron: окно, файловое хранилище доски, режим смоук-теста.
 *
 * Доски лежат в одном JSON-файле рабочего пространства (схема v2)
 * в каталоге userData. Запись атомарная
 * (временный файл + переименование), чтение — синхронное: рендерер
 * спрашивает хранилище в момент старта, когда показывать ещё нечего.
 */
'use strict';

const { app, BrowserWindow, ipcMain, nativeTheme } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');

const SMOKE = process.argv.includes('--smoke');
const SHOT_EDITOR = process.argv.includes('--shot-editor');
const THEME_ARG = process.argv.find((arg) => arg.startsWith('--theme='));
const THEME = THEME_ARG ? THEME_ARG.slice('--theme='.length) : null;
const SHOT = process.argv.includes('--shot') || SHOT_EDITOR;
const MAX_BOARD_BYTES = 5 * 1024 * 1024;
const SMOKE_TIMEOUT_MS = 90 * 1000;
const SHOT_TIMEOUT_MS = 60 * 1000;

let mainWindow = null;
let boardFile = null;
let smokeFinished = false;
let smokeTimer = null;

function resolveBoardFile() {
  if (SMOKE || SHOT) {
    return path.join(os.tmpdir(), `kanban-smoke-${process.pid}.json`);
  }
  return path.join(app.getPath('userData'), 'kanban-board.json');
}

function readBoard() {
  try {
    const raw = fs.readFileSync(boardFile, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed;
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.error('[kanban] не удалось прочитать доску:', error.message);
    }
    return null;
  }
}

function validateBoardPayload(payload) {
  if (payload === null || typeof payload !== 'object') {
    throw new Error('payload должен быть объектом');
  }
  // Пространство v2: несколько досок в одном файле.
  if (Array.isArray(payload.boards)) {
    for (const entry of payload.boards) {
      if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string') {
        throw new Error('payload.boards повреждён');
      }
      const board = entry.board;
      if (!board || typeof board !== 'object' || !Array.isArray(board.tasks) || !Array.isArray(board.columns)) {
        throw new Error('payload.boards повреждён');
      }
    }
    const text = JSON.stringify(payload);
    if (text.length > MAX_BOARD_BYTES) {
      throw new Error('доски слишком большие для сохранения');
    }
    return text;
  }
  // Одиночная доска v1 (обратная совместимость).
  if (!payload.board || typeof payload.board !== 'object') {
    throw new Error('payload.board отсутствует');
  }
  if (!Array.isArray(payload.board.tasks) || !Array.isArray(payload.board.columns)) {
    throw new Error('payload.board повреждён');
  }
  const text = JSON.stringify(payload);
  if (text.length > MAX_BOARD_BYTES) {
    throw new Error('доска слишком большая для сохранения');
  }
  return text;
}

// Ротация бэкапов: текущий файл → .bak, прошлый .bak → .bak.1.
function rotateBackup() {
  try {
    if (!fs.existsSync(boardFile)) return;
    const bak = `${boardFile}.bak`;
    const bak1 = `${boardFile}.bak.1`;
    if (fs.existsSync(bak)) {
      fs.copyFileSync(bak, bak1);
    }
    fs.copyFileSync(boardFile, bak);
  } catch (error) {
    console.error('[kanban] не удалось сделать бэкап:', error.message);
  }
}

function writeBoard(payload) {
  const text = validateBoardPayload(payload);
  rotateBackup();
  const tempFile = `${boardFile}.tmp`;
  fs.writeFileSync(tempFile, text, 'utf8');
  fs.renameSync(tempFile, boardFile);
}

// Очередь асинхронных записей: рендерер не ждёт диск (invoke),
// порядок соблюдается цепочкой промисов.
let saveQueue = Promise.resolve();

function writeBoardAsync(payload) {
  const text = validateBoardPayload(payload);
  saveQueue = saveQueue.then(() => {
    rotateBackup();
    const tempFile = `${boardFile}.tmp`;
    fs.writeFileSync(tempFile, text, 'utf8');
    fs.renameSync(tempFile, boardFile);
  });
  return saveQueue;
}

function registerIpc() {
  ipcMain.on('board:load-sync', (event) => {
    event.returnValue = readBoard();
  });

  // Синхронный путь оставлен для выгрузки (beforeunload) и смоук-проверок.
  ipcMain.on('board:save-sync', (event, payload) => {
    try {
      writeBoard(payload);
      event.returnValue = { ok: true };
    } catch (error) {
      console.error('[kanban] ошибка сохранения:', error.message);
      event.returnValue = { ok: false, error: error.message };
    }
  });

  // Основной путь: асинхронный, рендерер продолжает жить без фриза.
  ipcMain.handle('board:save', async (event, payload) => {
    try {
      await writeBoardAsync(payload);
      return { ok: true };
    } catch (error) {
      console.error('[kanban] ошибка сохранения:', error.message);
      return { ok: false, error: error.message };
    }
  });

  ipcMain.handle('board:export', async () => {
    const { dialog } = require('electron');
    const target = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
    const { canceled, filePath } = await dialog.showSaveDialog(target || undefined, {
      title: 'Экспорт доски',
      defaultPath: 'kanban-board.json',
      filters: [{ name: 'Канбан-доска (JSON)', extensions: ['json'] }],
    });
    if (canceled || !filePath) return { ok: false, reason: 'cancelled' };
    try {
      const raw = fs.readFileSync(boardFile, 'utf8');
      fs.writeFileSync(filePath, raw, 'utf8');
      return { ok: true, filePath };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });

  ipcMain.handle('board:import', async () => {
    const { dialog } = require('electron');
    const target = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
    const { canceled, filePaths } = await dialog.showOpenDialog(target || undefined, {
      title: 'Импорт доски',
      filters: [{ name: 'Канбан-доска (JSON)', extensions: ['json'] }],
      properties: ['openFile'],
    });
    if (canceled || !filePaths.length) return { ok: false, reason: 'cancelled' };
    try {
      const raw = fs.readFileSync(filePaths[0], 'utf8');
      const parsed = JSON.parse(raw);
      // Экспорт всего пространства (v2) импортируется целиком,
      // одиночная доска (v1) — заменяет активную.
      if (parsed && typeof parsed === 'object' && Array.isArray(parsed.boards)) {
        return { ok: true, payload: parsed };
      }
      const board = parsed && typeof parsed === 'object' && 'board' in parsed ? parsed.board : parsed;
      if (!board || !Array.isArray(board.tasks) || !Array.isArray(board.columns)) {
        return { ok: false, error: 'файл не похож на доску' };
      }
      return { ok: true, payload: { version: 1, savedAt: Date.now(), board } };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });

  ipcMain.on('smoke:log', (event, message) => {
    console.log(`[smoke] ${message}`);
  });

  ipcMain.on('smoke:done', async (event, passed) => {
    if (smokeFinished) return;
    smokeFinished = true;
    clearTimeout(smokeTimer);

    // Пауза, чтобы последние правки отрисовались, затем снимок — доказательство
    // живого интерфейса и картинка для README.
    await new Promise((resolve) => setTimeout(resolve, 500));
    try {
      if (mainWindow && !mainWindow.isDestroyed()) {
        const image = await mainWindow.webContents.capturePage();
        const shotPath = process.env.KANBAN_SHOT || path.join(os.tmpdir(), 'kanban-screenshot.png');
        fs.writeFileSync(shotPath, image.toPNG());
        console.log(`[smoke] screenshot: ${shotPath}`);
      }
    } catch (error) {
      console.error('[smoke] не удалось снять скриншот:', error.message);
    }

    console.log(`SMOKE RESULT: ${passed ? 'PASS' : 'FAIL'}`);
    app.exit(passed ? 0 : 1);
  });
}

function createWindow() {
  const iconPath = path.join(__dirname, '..', 'build', 'icon.png');
  // Кадр для README: окно 1720px + зум контента 1.25 = компоновка шире 1280,
  // стикеры и шрифт крупнее в пикселях, всё влезает без прокрутки.
  mainWindow = new BrowserWindow({
    width: SHOT ? 1720 : 1280,
    height: SHOT ? 1080 : 820,
    minWidth: 860,
    minHeight: 560,
    show: false,
    backgroundColor: '#ece5d8',
    title: 'Канбан',
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      backgroundThrottling: false,
      // Зум только для кадров: масштабирует контент, а не окно.
      ...(SHOT ? { zoomFactor: 1.25 } : {}),
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());

  // Никакой навигации наружу: приложение полностью локальное.
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());

  const query = Object.assign(
    {},
    SMOKE ? { smoke: '1' } : {},
    SHOT ? { shot: '1', ...(SHOT_EDITOR ? { editor: '1' } : {}) } : {},
    THEME ? { theme: THEME } : {}
  );
  mainWindow.loadFile(path.join(__dirname, '..', 'src', 'ui', 'index.html'), {
    query: Object.keys(query).length ? query : undefined,
  });

  if (SMOKE) {
    mainWindow.webContents.on('did-finish-load', () => {
      smokeTimer = setTimeout(() => {
        console.log('SMOKE RESULT: FAIL (таймаут — тест не завершился)');
        app.exit(2);
      }, SMOKE_TIMEOUT_MS);
    });
  }

  if (SHOT) {
    mainWindow.webContents.on('did-finish-load', async () => {
      // Даём странице отрисоваться и шрифтам — загрузиться.
      await new Promise((resolve) => setTimeout(resolve, 1200));
      try {
        const image = await mainWindow.webContents.capturePage();
        const shotPath = process.env.KANBAN_SHOT || path.join(os.tmpdir(), 'kanban-preview.png');
        fs.writeFileSync(shotPath, image.toPNG());
        console.log(`[shot] кадр снят: ${shotPath}`);
        app.exit(0);
      } catch (error) {
        console.error('[shot] ошибка:', error.message);
        app.exit(1);
      }
    });
    smokeTimer = setTimeout(() => {
      console.log('[shot] таймаут');
      app.exit(2);
    }, SHOT_TIMEOUT_MS);
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function bootstrap() {
  nativeTheme.themeSource = 'light';
  boardFile = resolveBoardFile();
  if (SMOKE) {
    try {
      fs.rmSync(boardFile, { force: true });
    } catch (error) {
      /* файла нет — и хорошо */
    }
  }

  registerIpc();
  createWindow();
}

// Интерфейс приложения — русский, поэтому и системные поля (например,
// календарь в редакторе срока) показываем по-русски.
app.commandLine.appendSwitch('lang', 'ru-RU');

if (SMOKE) {
  app.whenReady().then(bootstrap);
} else {
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    app.quit();
  } else {
    app.on('second-instance', () => {
      if (mainWindow) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.focus();
      }
    });
    app.whenReady().then(bootstrap);
  }
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' || SMOKE) app.quit();
});

app.on('activate', () => {
  if (mainWindow === null) createWindow();
});

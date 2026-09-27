/*
 * Ядро канбан-доски: состояние, правила, персистентность.
 *
 * Модуль не знает ни о DOM, ни об Electron — его гоняют и юнит-тесты
 * (node --test), и рендерер. Вся работа с хранилищем идёт через адаптер
 * {load(), save(payload)} — в Electron это IPC, в браузере localStorage.
 *
 * Ключевые правила предметной области:
 *  - на доске есть колонки (вертикальные поля) с необязательным WIP-лимитом;
 *  - задача живёт в колонке, порядок задаётся дробным числом `order`;
 *  - перемещение в колонку с достигнутым лимитом отклоняется (pull-система);
 *  - удаление — мягкое (deletedAt), чтобы работала отмена «Вернуть»;
 *  - каждое успешное изменение превращается в отложенную запись на диск.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  root.KanbanCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const SCHEMA_VERSION = 2;
  const DELETED_TASK_TTL_MS = 30 * 24 * 60 * 60 * 1000; // архив удалённых — 30 дней
  const BOARD_NAME_LIMIT = 60;

  const DEFAULT_COLUMNS = [
    { id: 'pool', title: 'Пул задач', wipLimit: null, role: 'pool' },
    { id: 'urgent', title: 'Срочные', wipLimit: null, role: null },
    { id: 'in-progress', title: 'В работе', wipLimit: 3, role: null },
    { id: 'waiting', title: 'На ожидании', wipLimit: null, role: null },
    { id: 'done', title: 'Завершено', wipLimit: null, role: 'done' },
  ];

  const TAGS = [
    { id: 'idea', label: 'Идея' },
    { id: 'work', label: 'Работа' },
    { id: 'personal', label: 'Личное' },
    { id: 'urgent', label: 'Срочно' },
    { id: 'study', label: 'Учёба' },
  ];

  const COLORS = ['mint', 'yellow', 'peach', 'pink', 'blue', 'lilac'];

  // Темы оформления доски (id стабильны — хранятся в файле доски).
  const THEMES = [
    { id: 'kraft', label: 'Крафт' },
    { id: 'rice', label: 'Рисовая бумага' },
    { id: 'cork', label: 'Пробковая доска' },
    { id: 'graphite', label: 'Графит' },
    { id: 'chalk', label: 'Меловая доска' },
  ];
  const DEFAULT_THEME = 'kraft';

  function sanitizeTheme(raw) {
    return THEMES.some((entry) => entry.id === raw) ? raw : DEFAULT_THEME;
  }

  const LIMITS = { text: 4300, html: 12000 };

  // Подмножество HTML для форматирования текста стикера
  // (жирный/курсив/зачёркнутый/списки/размер шрифта).
  const RICH_TAGS = new Set(['b', 'i', 's', 'u', 'ul', 'ol', 'li', 'br', 'span']);
  const RICH_ALIAS = { strong: 'b', em: 'i', strike: 's', del: 's' };

  // Чистит произвольный HTML до безопасного подмножества.
  // Блочные div/p превращаются в переносы, скрипты и мусор вырезаются,
  // у span остаётся только размер шрифта.
  function sanitizeRich(html) {
    let s = String(html || '');
    s = s.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
    s = s.replace(/<!--[\s\S]*?-->/g, '');
    // Блочные div/p — в переносы: стык </div><div> даёт один <br>,
    // иначе между соседними блоками появлялись бы пустые строки.
    s = s.replace(/<\/(div|p)\s*>\s*<(div|p)[^>]*>/gi, '<br>');
    s = s.replace(/<(div|p)[^>]*>/gi, '<br>');
    s = s.replace(/<\/(div|p)\s*>/gi, '');
    s = s.replace(/(<br\s*\/?>){3,}/gi, '<br><br>');
    s = s.replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g, (match, tag) => {
      tag = String(tag).toLowerCase();
      const closing = match.startsWith('</');
      if (tag === 'div' || tag === 'p') return '';
      if (!RICH_TAGS.has(tag) && !RICH_ALIAS[tag]) return '';
      if (tag === 'span') {
        if (closing) return '</span>';
        const found = /font-size\s*:\s*(\d+)\s*px/i.exec(match);
        const size = found ? Math.max(10, Math.min(32, Number(found[1]))) : 0;
        return size ? `<span data-fs="${size}" style="font-size:${size}px">` : '<span>';
      }
      const canon = RICH_ALIAS[tag] || tag;
      return closing ? `</${canon}>` : `<${canon}>`;
    });
    // Склеить цепочки переносов по краям и ужать длинные серии.
    s = s.replace(/^(<br\s*\/?>)+/i, '').replace(/(<br\s*\/?>)+$/i, '');
    if (s.length > LIMITS.html) s = s.slice(0, LIMITS.html);
    return s;
  }

  // Текст без разметки — для проверок пустоты и поиска.
  function strippedText(html) {
    return String(html || '')
      .replace(/<[^>]*>/g, '')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .trim();
  }
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

  // ---------------------------------------------------------------------
  // Мелкие утилиты
  // ---------------------------------------------------------------------

  function localDateString(ms) {
    const date = new Date(ms);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  function todayString(clock) {
    return localDateString((clock || Date.now)());
  }

  function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  // Поиск по тексту стикера без учёта регистра и разметки.
  function matchesQuery(task, query) {
    const needle = String(query || '').trim().toLocaleLowerCase('ru');
    if (!needle) return true;
    return strippedText(task.text).toLocaleLowerCase('ru').includes(needle);
  }

  function firstLine(text) {
    const line = strippedText(text).split('\n')[0].trim();
    return line;
  }

  function cloneTask(task) {
    return {
      id: task.id,
      columnId: task.columnId,
      text: task.text,
      tag: task.tag,
      color: task.color,
      dueDate: task.dueDate,
      priority: task.priority,
      order: task.order,
      // Свободная позиция на доске (px относительно начала .board).
      // null — задача ещё не раскладывалась свободно, UI разложит стопкой.
      x: Number.isFinite(task.x) ? task.x : null,
      y: Number.isFinite(task.y) ? task.y : null,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      deletedAt: task.deletedAt,
    };
  }

  function compareByOrder(a, b) {
    if (a.order !== b.order) return a.order - b.order;
    if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
    return a.id < b.id ? -1 : 1;
  }

  // ---------------------------------------------------------------------
  // Стартовая доска (первый запуск, когда файла ещё нет)
  // ---------------------------------------------------------------------

  function seedBoardData(clock) {
    const now = (clock || Date.now)();
    const dayMs = 24 * 60 * 60 * 1000;
    const nowIso = now;
    const task = (id, columnId, order, fields) =>
      Object.assign(
        {
          id,
          columnId,
          text: '',
          tag: null,
          color: null,
          dueDate: null,
          priority: false,
          order,
          x: null,
          y: null,
          createdAt: nowIso,
          updatedAt: nowIso,
          deletedAt: null,
        },
        fields
      );

    const tasks = [
      task('seed-1', 'pool', 1000, {
        text: 'Придумать оформление домашней страницы вики\nПроверить, как выглядят карточки-ссылки: тень, отступы, заголовок.',
        tag: 'idea',
        color: 'mint',
      }),
      task('seed-2', 'pool', 2000, {
        text: 'Собрать список книг на осень',
        tag: 'study',
        color: 'blue',
      }),
      task('seed-3', 'urgent', 1000, {
        text: 'Оплатить продление сервера до пятницы\nСчёт лежит в почте, платёжку подтверждает банк.',
        tag: 'urgent',
        color: 'pink',
        dueDate: localDateString(now + 2 * dayMs),
        priority: true,
      }),
      task('seed-4', 'in-progress', 1000, {
        text: 'Ревью pull request: модуль экспорта',
        tag: 'work',
        color: 'yellow',
      }),
      task('seed-5', 'waiting', 1000, {
        text: 'Ответ от макетчицы по цветам приложения',
        tag: 'personal',
        color: 'lilac',
      }),
      task('seed-6', 'done', 1000, {
        text: 'Настроить автосохранение доски',
        tag: 'work',
        color: 'mint',
      }),
    ];

    return {
      columns: DEFAULT_COLUMNS.map((column) => Object.assign({}, column)),
      tasks,
      theme: DEFAULT_THEME,
    };
  }

  // ---------------------------------------------------------------------
  // Санитизация: чиним произвольный payload в корректную доску
  // ---------------------------------------------------------------------

  function sanitizeColumn(raw) {
    if (!isPlainObject(raw)) return null;
    const id = typeof raw.id === 'string' ? raw.id.trim() : '';
    if (!id || !/^[A-Za-z0-9_-]+$/.test(id)) return null;
    let wipLimit = null;
    if (Number.isInteger(raw.wipLimit) && raw.wipLimit > 0) wipLimit = raw.wipLimit;
    const role = raw.role === 'done' || raw.role === 'pool' ? raw.role : null;
    return {
      id,
      title: typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim() : 'Колонка',
      wipLimit,
      role,
    };
  }

  function sanitizeTask(raw, columnIds, seenIds, now) {
    if (!isPlainObject(raw)) return { task: null, issues: [] };
    const issues = [];
    const id = typeof raw.id === 'string' ? raw.id.trim() : '';
    if (!id || !/^[A-Za-z0-9_-]+$/.test(id) || seenIds.has(id)) {
      return { task: null, issues: [id ? `duplicate/bad id: ${id}` : 'missing id'] };
    }
    const text = sanitizeRich(typeof raw.text === 'string' ? raw.text : '');
    if (!strippedText(text)) return { task: null, issues: [`empty text: ${id}`] };

    let columnId = typeof raw.columnId === 'string' ? raw.columnId : '';
    if (!columnIds.has(columnId)) {
      columnId = null; // решим после — отправим в первую колонку
      issues.push(`unknown column for ${id}`);
    }
    const tag = TAGS.some((entry) => entry.id === raw.tag) ? raw.tag : null;
    const color = COLORS.includes(raw.color) ? raw.color : null;
    const dueDate = typeof raw.dueDate === 'string' && DATE_RE.test(raw.dueDate) ? raw.dueDate : null;
    const order = Number.isFinite(raw.order) ? raw.order : null;
    // Свободные координаты: только конечные числа, иначе null (автораскладка).
    // Ограничиваем разумным диапазоном, чтобы битый файл не уносил стикеры.
    const finiteOrNull = (value) => {
      if (!Number.isFinite(value)) return null;
      if (value < -100000 || value > 100000) return null;
      return value;
    };
    const x = finiteOrNull(raw.x);
    const y = finiteOrNull(raw.y);
    const createdAt = Number.isFinite(raw.createdAt) ? raw.createdAt : now;
    const updatedAt = Number.isFinite(raw.updatedAt) ? raw.updatedAt : createdAt;
    const deletedAt = Number.isFinite(raw.deletedAt) ? raw.deletedAt : null;

    return {
      task: {
        id,
        columnId, // может быть null — подставим ниже
        text,
        tag,
        color,
        dueDate,
        priority: raw.priority === true,
        order,
        x,
        y,
        createdAt,
        updatedAt,
        deletedAt,
      },
      issues,
    };
  }

  function sanitizeBoard(raw, now) {
    const issues = [];
    if (!isPlainObject(raw)) {
      return { board: null, issues: ['board is not an object'], repaired: false };
    }

    const columnsRaw = Array.isArray(raw.columns) ? raw.columns : [];
    const columns = [];
    const columnIds = new Set();
    for (const entry of columnsRaw) {
      const column = sanitizeColumn(entry);
      if (!column || columnIds.has(column.id)) {
        issues.push('dropped invalid/duplicate column');
        continue;
      }
      columnIds.add(column.id);
      columns.push(column);
    }
    if (columns.length === 0) {
      issues.push('no valid columns — using defaults');
      for (const column of DEFAULT_COLUMNS) {
        columns.push(Object.assign({}, column));
        columnIds.add(column.id);
      }
    }

    const tasksRaw = Array.isArray(raw.tasks) ? raw.tasks : [];
    const seenIds = new Set();
    const tasks = [];
    const fallbackColumnId = columns[0].id;
    for (const entry of tasksRaw) {
      const { task, issues: taskIssues } = sanitizeTask(entry, columnIds, seenIds, now);
      if (taskIssues.length) issues.push(...taskIssues);
      if (!task) continue;
      seenIds.add(task.id);
      if ("columnId" in task && task.columnId === null) {
        task.columnId = fallbackColumnId;
      }
      if (task.order === null) task.order = (tasks.length + 1) * 1000;
      tasks.push(task);
    }

    // Прибираем давно удалённые задачи.
    const fresh = [];
    for (const task of tasks) {
      if (task.deletedAt !== null && now - task.deletedAt > DELETED_TASK_TTL_MS) {
        issues.push(`pruned old deleted task: ${task.id}`);
        continue;
      }
      fresh.push(task);
    }

    const board = { columns, tasks: fresh };
    // Тема в доске не хранится (v2: единая на пространство).
    // sanitizeWorkspace и replaceAll забирают raw.theme отдельно.
    const repairedNow = normalizeOrders(board);
    return { board, issues, repaired: issues.length > 0 || repairedNow };
  }

  // Раскладывает order по колонкам ровными шагами, сохраняя взаимный порядок.
  // Возвращает true, если что-то реально поменялось.
  function normalizeOrders(board) {
    let changed = false;
    for (const column of board.columns) {
      const list = board.tasks
        .filter((task) => task.columnId === column.id)
        .sort(compareByOrder);
      let expected = 1000;
      const seen = new Set();
      for (const task of list) {
        if (task.order !== expected || seen.has(task.order)) {
          task.order = expected;
          changed = true;
        }
        seen.add(task.order);
        expected += 1000;
      }
    }
    return changed;
  }

  // ---------------------------------------------------------------------
  // Рабочее пространство: несколько досок в одном файле (схема v2).
  // { version: 2, savedAt, activeBoardId, theme, boards: [{id, name, board}] }
  // Тема единая на всё пространство. Файлы v1 ({board} или голая доска)
  // мигрируют в одну доску «Моя доска», тема переезжает из board.theme.
  // ---------------------------------------------------------------------

  function sanitizeBoardName(raw, fallback) {
    const clean = typeof raw === 'string' ? raw.trim().replace(/\s+/g, ' ').slice(0, BOARD_NAME_LIMIT) : '';
    if (clean) return clean;
    return typeof fallback === 'string' && fallback ? fallback : 'Доска';
  }

  function newBoardId(now, seen) {
    let id = `b-${now.toString(36)}-${Math.floor(Math.random() * 0xffffff).toString(36)}`;
    let suffix = 2;
    while (!id || !/^[A-Za-z0-9_-]+$/.test(id) || (seen && seen.has(id))) {
      id = `b-${now.toString(36)}-${suffix.toString(36)}`;
      suffix += 1;
    }
    if (seen) seen.add(id);
    return id;
  }

  // Пустая доска для новых проектов: те же колонки, без демо-стикеров.
  function emptyBoardData() {
    return { columns: DEFAULT_COLUMNS.map((column) => Object.assign({}, column)), tasks: [] };
  }

  function sanitizeBoardEntry(raw, now, seenIds, fallbackName) {
    const issues = [];
    const source = isPlainObject(raw) ? raw : {};
    let id = typeof source.id === 'string' ? source.id.trim() : '';
    if (!id || !/^[A-Za-z0-9_-]+$/.test(id) || seenIds.has(id)) {
      if (id && seenIds.has(id)) issues.push(`duplicate board id: ${id}`);
      id = newBoardId(now, seenIds);
      issues.push('board id regenerated');
    } else {
      seenIds.add(id);
    }
    const name = sanitizeBoardName(source.name, fallbackName);
    if (name !== source.name) issues.push(`board renamed: ${id}`);
    const boardSource = isPlainObject(source.board) ? source.board : source;
    const result = sanitizeBoard(boardSource, now);
    let board = result.board;
    if (!board) {
      board = sanitizeBoard(emptyBoardData(), now).board;
      issues.push(`board reset to empty: ${id}`);
    }
    if (result.repaired) issues.push(`board repaired: ${id}`);
    issues.push(...result.issues.map((issue) => `${id}: ${issue}`));
    return { entry: { id, name, board }, issues };
  }

  function sanitizeWorkspace(raw, now) {
    const issues = [];
    const time = Number.isFinite(now) ? now : Date.now();
    // Пустое хранилище — не миграция, а первый запуск: init поднимет seed.
    if (raw === null || raw === undefined) {
      return { workspace: null, issues: ['empty storage — seeding'], repaired: false };
    }
    const seenIds = new Set();
    let boards = [];
    let activeBoardId = null;
    let theme = DEFAULT_THEME;

    if (isPlainObject(raw) && Array.isArray(raw.boards)) {
      // Формат v2.
      theme = sanitizeTheme(raw.theme);
      if (raw.theme !== undefined && theme !== raw.theme) issues.push('unknown theme — using default');
      let counter = 0;
      for (const item of raw.boards) {
        counter += 1;
        const { entry, issues: entryIssues } = sanitizeBoardEntry(item, time, seenIds, `Доска ${counter}`);
        boards.push(entry);
        issues.push(...entryIssues);
      }
      if (typeof raw.activeBoardId === 'string' && seenIds.has(raw.activeBoardId)) {
        activeBoardId = raw.activeBoardId;
      } else {
        issues.push('unknown activeBoardId — using first board');
      }
    } else {
      // Миграция v1: {version:1, board} или голая доска {columns, tasks}.
      const source = isPlainObject(raw) && "board" in raw ? raw.board : raw;
      const boardTheme = isPlainObject(source) && typeof source.theme === 'string' ? source.theme : undefined;
      theme = sanitizeTheme(boardTheme);
      const { entry, issues: entryIssues } = sanitizeBoardEntry(
        { id: 'board-1', name: 'Моя доска', board: source }, time, seenIds, 'Моя доска'
      );
      boards.push(entry);
      issues.push('migrated v1 → v2: single board «Моя доска»');
      issues.push(...entryIssues);
    }

    if (boards.length === 0) {
      const seed = sanitizeBoard(seedBoardData(), time).board;
      boards.push({ id: 'board-1', name: 'Моя доска', board: seed });
      seenIds.add('board-1');
      issues.push('no valid boards — seeded «Моя доска»');
    }
    if (!activeBoardId || !seenIds.has(activeBoardId)) activeBoardId = boards[0].id;

    const workspace = { boards, activeBoardId, theme };
    return { workspace, issues, repaired: issues.length > 0 };
  }

  // ---------------------------------------------------------------------
  // Рефлоу X при изменении геометрии дорожек (ресайз окна, +/- колонка).
  // Чистая функция: старый абсолютный x пересчитывается относительно
  // СВОЕЙ дорожки (по columnId, не по центру — иначе съезжает в соседа).
  //  - центр-снапнутые (|x − oldCenter| <= centerTol) встают в новый центр;
  //  - остальные едут пропорционально внутри своей дорожки;
  //  - без дорожек — долей ширины борда.
  // Кламп — в пространстве ДОРОЖЕК (opts.bounds {min,max}), а не борда:
  // в узком окне дорожки упираются в min-width и вылезают за ширину .board
  // (горизонтальный скролл), и кламп по борду насильно стаскивал бы правые
  // стикеры влево с потерей позиции. Без bounds — legacy по ширине борда.
  // ---------------------------------------------------------------------

  function computeReflowX(input) {
    const opts = input || {};
    const x = Number(opts.x);
    const width = Number.isFinite(opts.width) && opts.width > 0 ? opts.width : 200;
    const centerTol = Number.isFinite(opts.centerTol) ? opts.centerTol : 50;
    const oldLane = opts.oldLane || null;
    const newLane = opts.newLane || null;
    const oldBoardWidth =
      Number.isFinite(opts.oldBoardWidth) && opts.oldBoardWidth > 0 ? opts.oldBoardWidth : 0;
    const newBoardWidth =
      Number.isFinite(opts.newBoardWidth) && opts.newBoardWidth > 0 ? opts.newBoardWidth : 0;
    const bounds = opts.bounds || null;

    if (!Number.isFinite(x)) return null;
    // Границы клампа: явно переданные дорожки важнее ширины борда.
    let lo = 0;
    let hi = Infinity;
    if (bounds && (Number.isFinite(bounds.min) || Number.isFinite(bounds.max))) {
      if (Number.isFinite(bounds.min)) lo = bounds.min;
      hi = Number.isFinite(bounds.max) ? Math.max(lo, bounds.max) : Infinity;
    } else if (newBoardWidth > 0) {
      hi = Math.max(0, newBoardWidth - width);
    }
    const clamp = (value) => Math.max(lo, Math.min(hi, Math.round(value)));

    if (oldLane && newLane) {
      const oldWidth = oldLane.right - oldLane.left;
      const newWidth = newLane.right - newLane.left;
      const oldCenter = (oldLane.left + oldLane.right) / 2 - width / 2;
      if (Math.abs(x - oldCenter) <= centerTol) {
        return clamp((newLane.left + newLane.right) / 2 - width / 2);
      }
      if (oldWidth > 0 && newWidth > 0) {
        const ratio = (x - oldLane.left) / oldWidth;
        return clamp(newLane.left + ratio * newWidth);
      }
      return clamp((newLane.left + newLane.right) / 2 - width / 2);
    }
    if (oldBoardWidth > 0 && newBoardWidth > 0) {
      return clamp((x / oldBoardWidth) * newBoardWidth);
    }
    return clamp(x);
  }

  // ---------------------------------------------------------------------
  // Основной класс
  // ---------------------------------------------------------------------

  class KanbanStore {
    /**
     * @param {object} [options]
     * @param {{load: Function, save: Function}|null} [options.storage]
     * @param {number} [options.autosaveMs] — задержка записи для правок текста
     * @param {Function} [options.clock]
     */
    constructor(options) {
      const settings = options || {};
      this._storage = settings.storage || null;
      this._autosaveMs = Number.isFinite(settings.autosaveMs) ? settings.autosaveMs : 400;
      this._clock = settings.clock || (() => Date.now());
      this._idCounter = 0;
      this._boardCounter = 0;
      // Мультидоска: _boards — все доски [{id, name, board}],
      // _board — ссылка на board активной (старые методы не меняются),
      // _theme — единая тема пространства.
      this._boards = [];
      this._activeBoardId = null;
      this._board = null;
      this._theme = DEFAULT_THEME;
      this._query = '';
      this._listeners = new Set();
      this._saveTimer = null;
      this._dirty = false;
      this._lastSavedAt = 0;
      this._saveError = null;
      this._loadReport = { seeded: false, repaired: false, issues: [] };
    }

    // -- жизненный цикл -------------------------------------------------

    init() {
      const now = this._clock();
      let workspace = null;
      if (this._storage) {
        let raw = null;
        try {
          raw = this._storage.load();
        } catch (error) {
          this._loadReport.issues.push(`load failed: ${error.message}`);
        }
        if (isPlainObject(raw) && raw.version !== undefined && raw.version !== SCHEMA_VERSION && raw.version !== 1) {
          this._loadReport.issues.push(`unknown version ${raw.version}; best-effort load`);
        }
        const result = sanitizeWorkspace(raw, now);
        if (result.workspace) {
          workspace = result.workspace;
          this._loadReport.repaired = result.repaired;
          this._loadReport.issues.push(...result.issues);
        }
      }
      if (!workspace) {
        const seed = sanitizeBoard(seedBoardData(), now).board;
        workspace = { boards: [{ id: 'board-1', name: 'Моя доска', board: seed }], activeBoardId: 'board-1', theme: DEFAULT_THEME };
        this._loadReport.seeded = true;
      }
      this._boards = workspace.boards;
      this._activeBoardId = workspace.activeBoardId;
      this._theme = workspace.theme;
      this._syncActiveRef();
      if (this._loadReport.seeded || this._loadReport.repaired) {
        this._dirty = true;
        this._scheduleSave(0);
      }
      return Object.assign({}, this._loadReport);
    }

    subscribe(listener) {
      this._listeners.add(listener);
      return () => this._listeners.delete(listener);
    }

    _emit(event) {
      for (const listener of [...this._listeners]) {
        try {
          listener(event);
        } catch (error) {
          console.error('[kanban] listener error:', error);
        }
      }
    }

    // -- доски (рабочее пространство) ------------------------------------

    _activeEntry() {
      return this._boards.find((entry) => entry.id === this._activeBoardId) || this._boards[0] || null;
    }

    _syncActiveRef() {
      const entry = this._activeEntry();
      this._activeBoardId = entry ? entry.id : null;
      this._board = entry ? entry.board : null;
    }

    activeBoardId() {
      return this._activeBoardId;
    }

    // Список для вкладок: id, имя и число ОТКРЫТЫХ стикеров
    // (завершённые и удалённые не считаются — как непрочитанное в ежедневнике).
    listBoards() {
      return this._boards.map((entry) => {
        const doneIds = new Set(
          entry.board.columns.filter((column) => column.role === 'done').map((column) => column.id)
        );
        return {
          id: entry.id,
          name: entry.name,
          taskCount: entry.board.tasks.filter(
            (task) => task.deletedAt === null && !doneIds.has(task.columnId)
          ).length,
        };
      });
    }

    _nextBoardId() {
      this._boardCounter += 1;
      const now = this._clock();
      let id = `b-${now.toString(36)}-${this._boardCounter.toString(36)}`;
      const seen = new Set(this._boards.map((entry) => entry.id));
      let suffix = 2;
      while (seen.has(id)) {
        id = `b-${now.toString(36)}-${this._boardCounter.toString(36)}-${suffix.toString(36)}`;
        suffix += 1;
      }
      return id;
    }

    createBoard(name) {
      const clean = sanitizeBoardName(name, `Доска ${this._boards.length + 1}`);
      const entry = {
        id: this._nextBoardId(),
        name: clean,
        board: sanitizeBoard(emptyBoardData(), this._clock()).board,
      };
      this._boards.push(entry);
      this._activeBoardId = entry.id;
      this._query = '';
      this._syncActiveRef();
      this._afterChange('board-create');
      return { ok: true, board: { id: entry.id, name: entry.name } };
    }

    renameBoard(id, name) {
      const entry = this._boards.find((item) => item.id === id);
      if (!entry) return { ok: false, reason: 'not-found' };
      const clean = typeof name === 'string' ? name.trim().replace(/\s+/g, ' ').slice(0, BOARD_NAME_LIMIT) : '';
      if (!clean) return { ok: false, reason: 'empty-title' };
      if (clean === entry.name) return { ok: true, board: { id: entry.id, name: entry.name } };
      entry.name = clean;
      this._afterChange('board-rename');
      return { ok: true, board: { id: entry.id, name: entry.name } };
    }

    deleteBoard(id) {
      const entry = this._boards.find((item) => item.id === id);
      if (!entry) return { ok: false, reason: 'not-found' };
      if (this._boards.length <= 1) return { ok: false, reason: 'last-board' };
      this._boards = this._boards.filter((item) => item.id !== id);
      if (this._activeBoardId === id) {
        this._activeBoardId = this._boards[0].id;
        this._query = '';
      }
      this._syncActiveRef();
      this._afterChange('board-delete');
      return { ok: true, activeBoardId: this._activeBoardId };
    }

    switchBoard(id) {
      if (!this._boards.some((entry) => entry.id === id)) return { ok: false, reason: 'not-found' };
      if (id === this._activeBoardId) return { ok: true, board: { id }, noop: true };
      this._activeBoardId = id;
      this._query = '';
      this._syncActiveRef();
      this._afterChange('board-switch');
      return { ok: true, board: { id } };
    }

    // -- чтение ----------------------------------------------------------

    get query() {
      return this._query;
    }

    lastSavedAt() {
      return this._lastSavedAt;
    }

    lastSaveError() {
      return this._saveError;
    }

    getTask(id) {
      const task = this._findTask(id);
      return task && task.deletedAt === null ? cloneTask(task) : null;
    }

    _findTask(id) {
      return this._board.tasks.find((entry) => entry.id === id) || null;
    }

    _column(id) {
      return this._board.columns.find((entry) => entry.id === id) || null;
    }

    _activeTasks(columnId) {
      return this._board.tasks
        .filter((task) => task.columnId === columnId && task.deletedAt === null)
        .sort(compareByOrder);
    }

    _overLimit(column) {
      if (!column.wipLimit) return false;
      return this._activeTasks(column.id).length >= column.wipLimit;
    }

    // Снимок для рендера: колонки с видимыми (по фильтру) задачами + статистика.
    view() {
      const query = this._query;
      const today = todayString(this._clock);
      let total = 0;
      let overdue = 0;
      const columns = this._board.columns.map((column) => {
        const active = this._activeTasks(column.id);
        const visible = query ? active.filter((task) => matchesQuery(task, query)) : active;
        total += active.length;
        if (column.role !== 'done') {
          overdue += active.filter((task) => task.dueDate !== null && task.dueDate < today).length;
        }
        return {
          id: column.id,
          title: column.title,
          wipLimit: column.wipLimit,
          role: column.role,
          count: active.length,
          visibleCount: visible.length,
          atLimit: column.wipLimit !== null && active.length >= column.wipLimit,
          overLimit: column.wipLimit !== null && active.length > column.wipLimit,
          tasks: visible.map(cloneTask),
        };
      });
      return { columns, stats: { total, overdue }, query };
    }

    snapshot() {
      return JSON.parse(JSON.stringify(this._board));
    }

    setQuery(query) {
      const next = String(query || '');
      if (next === this._query) return;
      this._query = next;
      this._emit({ type: 'change', reason: 'query' });
    }

    // -- тема оформления (единая на всё пространство) ----------------------

    getTheme() {
      return sanitizeTheme(this._theme);
    }

    setTheme(id) {
      if (!THEMES.some((entry) => entry.id === id)) return { ok: false, reason: 'bad-theme' };
      if (this._theme === id) return { ok: true, theme: id };
      this._theme = id;
      this._afterChange('theme');
      return { ok: true, theme: id };
    }

    // -- задачи ----------------------------------------------------------

    _nextId() {
      this._idCounter += 1;
      return `t-${this._clock().toString(36)}-${this._idCounter.toString(36)}`;
    }

    createTask(input) {
      const fields = input || {};
      const text = sanitizeRich(typeof fields.text === 'string' ? fields.text : '');
      if (!strippedText(text)) return { ok: false, reason: 'empty-text' };

      let column = fields.columnId ? this._column(fields.columnId) : null;
      if (!column) column = this._board.columns[0];
      if (!column) return { ok: false, reason: 'no-columns' };
      if (this._overLimit(column)) return { ok: false, reason: 'wip', columnId: column.id };

      const now = this._clock();
      const list = this._activeTasks(column.id);
      const first = list.length ? list[0] : null;
      const freeCoord = (value) => {
        if (!Number.isFinite(value)) return null;
        if (value < -100000 || value > 100000) return null;
        return value;
      };
      const task = {
        id: this._nextId(),
        columnId: column.id,
        text,
        tag: TAGS.some((entry) => entry.id === fields.tag) ? fields.tag : null,
        color: COLORS.includes(fields.color) ? fields.color : null,
        dueDate: typeof fields.dueDate === 'string' && DATE_RE.test(fields.dueDate) ? fields.dueDate : null,
        priority: fields.priority === true,
        // Новая задача кладётся наверх колонки — как свежий стикер в стопку.
        order: first ? first.order - 1000 : 1000,
        x: freeCoord(fields.x),
        y: freeCoord(fields.y),
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      };
      this._board.tasks.push(task);
      this._afterChange('create', task);
      return { ok: true, task: cloneTask(task) };
    }

    updateTask(id, patch) {
      const task = this._findTask(id);
      if (!task || task.deletedAt !== null) return { ok: false, reason: 'not-found' };
      const fields = patch || {};
      const changed = [];

      if ("text" in fields) {
        const text = sanitizeRich(typeof fields.text === 'string' ? fields.text : '');
        if (!strippedText(text)) return { ok: false, reason: 'empty-text' };
        if (text !== task.text) {
          task.text = text;
          changed.push('text');
        }
      }
      if ("tag" in fields) {
        const tag = TAGS.some((entry) => entry.id === fields.tag) ? fields.tag : null;
        if (tag !== task.tag) {
          task.tag = tag;
          changed.push('tag');
        }
      }
      if ("color" in fields) {
        const color = COLORS.includes(fields.color) ? fields.color : null;
        if (color !== task.color) {
          task.color = color;
          changed.push('color');
        }
      }
      if ("dueDate" in fields) {
        const dueDate =
          typeof fields.dueDate === 'string' && DATE_RE.test(fields.dueDate) ? fields.dueDate : null;
        if (dueDate !== task.dueDate) {
          task.dueDate = dueDate;
          changed.push('dueDate');
        }
      }
      if ("priority" in fields) {
        const priority = fields.priority === true;
        if (priority !== task.priority) {
          task.priority = priority;
          changed.push('priority');
        }
      }
      if (changed.length === 0) return { ok: true, task: cloneTask(task) };

      task.updatedAt = this._clock();
      this._afterChange('update', task);
      return { ok: true, task: cloneTask(task) };
    }

    /**
     * Перемещение задачи. Позиция задаётся соседями места назначения:
     * вставить после `afterId` и/или перед `beforeId`. Если соседей нет —
     * задача уходит в конец колонки. Поля `x`/`y` (свободные координаты)
     * при наличии сохраняются как визуальная позиция — стикер остаётся
     * там, где его бросили, даже на границе колонок.
     */
    moveTask(id, targetColumnId, position) {
      const task = this._findTask(id);
      if (!task || task.deletedAt !== null) return { ok: false, reason: 'not-found' };
      const target = this._column(targetColumnId);
      if (!target) return { ok: false, reason: 'no-column' };

      const spot = position || {};
      const list = this._activeTasks(target.id).filter((entry) => entry.id !== task.id);
      const index = this._insertIndex(list, spot.afterId || null, spot.beforeId || null);

      // WIP-лимит проверяем только при переходе в другую колонку.
      if (target.id !== task.columnId && this._overLimit(target)) {
        return { ok: false, reason: 'wip', columnId: target.id, limit: target.wipLimit };
      }

      let previous = index > 0 ? list[index - 1] : null;
      let next = index < list.length ? list[index] : null;
      const order = this._orderForIndex(list, index, previous, next);

      const movedColumn = task.columnId !== target.id;
      task.columnId = target.id;
      task.order = order;
      if (Number.isFinite(spot.x) && Number.isFinite(spot.y)) {
        task.x = Math.max(-100000, Math.min(100000, spot.x));
        task.y = Math.max(-100000, Math.min(100000, spot.y));
      }
      task.updatedAt = this._clock();
      this._afterChange(movedColumn ? 'move' : 'reorder', task);
      return { ok: true, task: cloneTask(task) };
    }

    /**
     * Точечное обновление свободной позиции (живое перетаскивание).
     * WIP-проверка — как в moveTask: смена колонки в переполненную отклоняется.
     */
    setTaskPos(id, targetColumnId, x, y, orderSpot) {
      const task = this._findTask(id);
      if (!task || task.deletedAt !== null) return { ok: false, reason: 'not-found' };
      const target = this._column(targetColumnId);
      if (!target) return { ok: false, reason: 'no-column' };
      if (target.id !== task.columnId && this._overLimit(target)) {
        return { ok: false, reason: 'wip', columnId: target.id, limit: target.wipLimit };
      }
      const spot = orderSpot || {};
      const list = this._activeTasks(target.id).filter((entry) => entry.id !== task.id);
      const index = this._insertIndex(list, spot.afterId || null, spot.beforeId || null);
      const order = this._orderForIndex(list, index, index > 0 ? list[index - 1] : null,
        index < list.length ? list[index] : null);
      task.columnId = target.id;
      task.order = order;
      if (Number.isFinite(x) && Number.isFinite(y)) {
        task.x = Math.max(-100000, Math.min(100000, x));
        task.y = Math.max(-100000, Math.min(100000, y));
      }
      task.updatedAt = this._clock();
      this._afterChange('move', task);
      return { ok: true, task: cloneTask(task) };
    }

    _insertIndex(list, afterId, beforeId) {
      const indexAfter = afterId ? list.findIndex((entry) => entry.id === afterId) : -1;
      const indexBefore = beforeId ? list.findIndex((entry) => entry.id === beforeId) : -1;
      if (indexAfter >= 0 && indexBefore === indexAfter + 1) return indexBefore;
      if (indexAfter >= 0) return indexAfter + 1;
      if (indexBefore >= 0) return indexBefore;
      return list.length;
    }

    // Общий расчёт order для вставки в позицию index списка list
    // (без перемещаемой задачи). При сближении соседей (< 2) доска
    // нормализуется — единый путь для moveTask и setTaskPos, иначе
    // живое перетаскивание вырождает дробный порядок в щели.
    _orderForIndex(list, index, previous, next) {
      let prev = previous !== undefined ? previous : index > 0 ? list[index - 1] : null;
      let nxt = next !== undefined ? next : index < list.length ? list[index] : null;
      if (prev && nxt && nxt.order - prev.order < 2) {
        normalizeOrders(this._board);
        prev = index > 0 ? list[index - 1] : null;
        nxt = index < list.length ? list[index] : null;
      }
      if (!prev && !nxt) return 1000;
      if (!prev) return nxt.order - 1000;
      if (!nxt) return prev.order + 1000;
      return (prev.order + nxt.order) / 2;
    }

    /**
     * Точечный сдвиг свободной позиции (расталкивание при наложении).
     * Колонка и порядок не меняются — только визуальные x/y.
     */
    setTaskXY(id, x, y) {
      const task = this._findTask(id);
      if (!task || task.deletedAt !== null) return { ok: false, reason: 'not-found' };
      if (!Number.isFinite(x) || !Number.isFinite(y)) return { ok: false, reason: 'bad-pos' };
      task.x = Math.max(-100000, Math.min(100000, x));
      task.y = Math.max(-100000, Math.min(100000, y));
      task.updatedAt = this._clock();
      this._afterChange('move', task);
      return { ok: true, task: cloneTask(task) };
    }

    /**
     * Пакетное обновление свободных X-позиций (рефлоу при ресайзе).
     * Тихий путь: одна запись на диск и одно событие, без спама рендеров.
     * WIP/порядок не трогаются — только визуальный x. Возвращает число
     * реально изменённых задач.
     */
    updatePositionsBatch(items) {
      const list = Array.isArray(items) ? items : [];
      if (!list.length) return { ok: true, updated: 0, skipped: true };
      const now = this._clock();
      let updated = 0;
      for (const entry of list) {
        if (!entry || typeof entry.id !== 'string') continue;
        const task = this._findTask(entry.id);
        if (!task || task.deletedAt !== null) continue;
        if (!Number.isFinite(entry.x)) continue;
        const nextX = Math.max(-100000, Math.min(100000, Math.round(entry.x)));
        if (task.x === nextX) continue;
        task.x = nextX;
        task.updatedAt = now;
        updated += 1;
      }
      if (!updated) return { ok: true, updated: 0, skipped: true };
      this._dirty = true;
      this._scheduleSave(0);
      this._emit({ type: 'change', reason: 'reflow' });
      return { ok: true, updated };
    }

    /**
     * Перенос в другую колонку без пересчёта порядка (групповое перетаскивание).
     * WIP-лимит проверяется как обычно.
     */
    relocateTask(id, targetColumnId, x, y) {
      const task = this._findTask(id);
      if (!task || task.deletedAt !== null) return { ok: false, reason: 'not-found' };
      const target = this._column(targetColumnId);
      if (!target) return { ok: false, reason: 'no-column' };
      if (target.id !== task.columnId && this._overLimit(target)) {
        return { ok: false, reason: 'wip', columnId: target.id, limit: target.wipLimit };
      }
      task.columnId = target.id;
      if (Number.isFinite(x) && Number.isFinite(y)) {
        task.x = Math.max(-100000, Math.min(100000, x));
        task.y = Math.max(-100000, Math.min(100000, y));
      }
      task.updatedAt = this._clock();
      this._afterChange('move', task);
      return { ok: true, task: cloneTask(task) };
    }

    deleteTask(id) {
      const task = this._findTask(id);
      if (!task || task.deletedAt !== null) return { ok: false, reason: 'not-found' };
      task.deletedAt = this._clock();
      this._afterChange('delete', task);
      return { ok: true, task: cloneTask(task) };
    }

    restoreTask(id) {
      const task = this._findTask(id);
      if (!task || task.deletedAt === null) return { ok: false, reason: 'not-found' };
      task.deletedAt = null;
      task.updatedAt = this._clock();
      this._afterChange('restore', task);
      return { ok: true, task: cloneTask(task) };
    }

    duplicateTask(id) {
      const source = this.getTask(id);
      if (!source) return { ok: false, reason: 'not-found' };
      const result = this.createTask({
        columnId: source.columnId,
        text: `${source.text} (копия)`,
        tag: source.tag,
        color: source.color,
        dueDate: source.dueDate,
        priority: source.priority,
        // Копия чуть со сдвигом, чтобы не лежать ровно под оригиналом.
        x: Number.isFinite(source.x) ? source.x + 18 : null,
        y: Number.isFinite(source.y) ? source.y + 18 : null,
      });
      if (result.ok) {
        // Копия встаёт сразу за оригиналом.
        this.moveTask(result.task.id, source.columnId, {
          afterId: source.id,
          x: result.task.x,
          y: result.task.y,
        });
      }
      return result;
    }

    // -- колонки ---------------------------------------------------------

    addColumn(title) {
      const clean = typeof title === 'string' ? title.trim().slice(0, 80) : '';
      if (!clean) return { ok: false, reason: 'empty-title' };
      const base = clean
        .toLocaleLowerCase('ru')
        .replace(/[^a-zа-яё0-9]+/gi, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 24) || 'col';
      let id = base;
      let suffix = 2;
      while (this._column(id)) {
        id = `${base}-${suffix}`;
        suffix += 1;
      }
      const column = { id, title: clean, wipLimit: null, role: null };
      this._board.columns.push(column);
      this._afterChange('column-add', null, column);
      return { ok: true, column: Object.assign({}, column) };
    }

    renameColumn(id, title) {
      const column = this._column(id);
      if (!column) return { ok: false, reason: 'not-found' };
      const clean = typeof title === 'string' ? title.trim().slice(0, 80) : '';
      if (!clean) return { ok: false, reason: 'empty-title' };
      if (clean === column.title) return { ok: true, column: Object.assign({}, column) };
      column.title = clean;
      this._afterChange('column-rename', null, column);
      return { ok: true, column: Object.assign({}, column) };
    }

    setWipLimit(id, limit) {
      const column = this._column(id);
      if (!column) return { ok: false, reason: 'not-found' };
      let value = null;
      if (limit !== null && limit !== undefined && limit !== '') {
        value = Number(limit);
        if (!Number.isInteger(value) || value <= 0) return { ok: false, reason: 'bad-limit' };
      }
      column.wipLimit = value;
      this._afterChange('column-wip', null, column);
      return { ok: true, column: Object.assign({}, column) };
    }

    /**
     * Удаление колонки. Стикеры остаются на месте: x/y не меняются,
     * задачам переназначается columnId через reassign(task) — UI отдаёт
     * владельца по центру стикера среди оставшихся дорожек. Без reassign
     * задачи уходят в первую оставшуюся колонку. WIP при системном
     * переназначении не блокирует (подсветка over-limit покажет переполнение),
     * порядок — в конец новой колонки. Архив (deletedAt) сохраняется.
     */
    removeColumn(id, reassign) {
      const column = this._column(id);
      if (!column) return { ok: false, reason: 'not-found' };
      if (this._board.columns.length <= 1) return { ok: false, reason: 'last-column' };
      const rest = this._board.columns.filter((entry) => entry.id !== id);
      const fallbackId = rest.length ? rest[0].id : null;
      const resolve = typeof reassign === 'function' ? reassign : () => fallbackId;
      const now = this._clock();
      let moved = 0;
      for (const task of this._board.tasks) {
        if (task.columnId !== id) continue;
        let targetId = null;
        try {
          targetId = resolve(cloneTask(task));
        } catch (error) {
          targetId = null;
        }
        if (!rest.some((entry) => entry.id === targetId)) targetId = fallbackId;
        if (!targetId) continue;
        task.columnId = targetId;
        task.updatedAt = now;
        // В конец новой колонки, сохраняя относительный порядок переехавших.
        const peers = this._board.tasks
          .filter((entry) => entry.columnId === targetId && entry.id !== task.id && entry.deletedAt === null)
          .sort(compareByOrder);
        task.order = peers.length ? peers[peers.length - 1].order + 1000 : 1000;
        moved += 1;
      }
      this._board.columns = rest;
      normalizeOrders(this._board);
      this._afterChange('column-remove', null, column);
      return { ok: true, moved };
    }

    // -- персистентность --------------------------------------------------

    // Полный payload пространства (v2) для записи на диск.
    _workspacePayload() {
      return {
        version: SCHEMA_VERSION,
        savedAt: this._clock(),
        activeBoardId: this._activeBoardId,
        theme: this._theme,
        boards: JSON.parse(JSON.stringify(this._boards)),
      };
    }

    _afterChange(reason, task, column) {
      const delay = reason === 'update' ? this._autosaveMs : 0;
      this._dirty = true;
      this._scheduleSave(delay);
      this._emit({ type: 'change', reason, task: task ? cloneTask(task) : null, column: column || null });
    }

    _scheduleSave(delay) {
      if (this._saveTimer) clearTimeout(this._saveTimer);
      const wait = Math.max(0, Number.isFinite(delay) ? delay : this._autosaveMs);
      this._saveTimer = setTimeout(() => {
        this._saveTimer = null;
        this.flush();
      }, wait);
    }

    flush() {
      // Ручная запись отменяет отложенную — иначе таймер запишет ещё раз.
      if (this._saveTimer) {
        clearTimeout(this._saveTimer);
        this._saveTimer = null;
      }
      if (!this._dirty) return { ok: true, savedAt: this._lastSavedAt, skipped: true };
      if (!this._storage) {
        this._dirty = false;
        return { ok: true, savedAt: this._lastSavedAt, skipped: true };
      }
      const payload = this._workspacePayload();
      let result;
      try {
        result = this._storage.save(payload);
      } catch (error) {
        this._saveError = error.message || String(error);
        this._emit({ type: 'save-error', error: this._saveError });
        return { ok: false, error: this._saveError };
      }
      // Асинхронное хранилище (Electron invoke): сохраняем оптимистично,
      // статус подтянется событием 'saved' по резолву. invoke отдаёт
      // {ok:false} резолвом, а не броском — проверяем флаг явно.
      if (result && typeof result.then === 'function') {
        return result.then(
          (response) => {
            if (response && response.ok === false) {
              this._saveError = response.error || 'запись не удалась';
              this._emit({ type: 'save-error', error: this._saveError });
              return { ok: false, error: this._saveError };
            }
            this._dirty = false;
            this._lastSavedAt = payload.savedAt;
            this._saveError = null;
            this._emit({ type: 'saved', savedAt: payload.savedAt });
            return { ok: true, savedAt: payload.savedAt };
          },
          (error) => {
            this._saveError = (error && error.message) || String(error);
            this._emit({ type: 'save-error', error: this._saveError });
            return { ok: false, error: this._saveError };
          }
        );
      }
      this._dirty = false;
      this._lastSavedAt = payload.savedAt;
      this._saveError = null;
      this._emit({ type: 'saved', savedAt: payload.savedAt });
      return { ok: true, savedAt: payload.savedAt };
    }

    /**
     * Блокирующая запись для сценария выгрузки (beforeunload).
     * Использует storage.saveSync при наличии, иначе синхронный save.
     * Промисные хранилища здесь не ждут — выгрузка не может ждать invoke.
     */
    flushSync() {
      if (this._saveTimer) {
        clearTimeout(this._saveTimer);
        this._saveTimer = null;
      }
      if (!this._dirty) return { ok: true, savedAt: this._lastSavedAt, skipped: true };
      if (!this._storage) {
        this._dirty = false;
        return { ok: true, savedAt: this._lastSavedAt, skipped: true };
      }
      const payload = this._workspacePayload();
      try {
        if (typeof this._storage.saveSync === 'function') {
          this._storage.saveSync(payload);
        } else {
          const result = this._storage.save(payload);
          if (result && typeof result.then === 'function') {
            return { ok: false, error: 'async-pending', asyncPending: true };
          }
        }
        this._dirty = false;
        this._lastSavedAt = payload.savedAt;
        this._saveError = null;
        this._emit({ type: 'saved', savedAt: payload.savedAt });
        return { ok: true, savedAt: payload.savedAt };
      } catch (error) {
        this._saveError = error.message || String(error);
        this._emit({ type: 'save-error', error: this._saveError });
        return { ok: false, error: this._saveError };
      }
    }

    /**
     * Замена данных целиком (импорт/аварийное восстановление).
     * Принимает и пространство v2 ({boards}), и одиночную доску v1 —
     * одиночная заменяет АКТИВНУЮ доску, остальные не трогает.
     * Используется тестами и инструментами; UI вызывает при импорте из файла.
     */
    replaceAll(payload) {
      if (isPlainObject(payload) && Array.isArray(payload.boards)) {
        const result = sanitizeWorkspace(payload, this._clock());
        if (!result.workspace || !result.workspace.boards.length) return { ok: false, reason: 'bad-payload' };
        this._boards = result.workspace.boards;
        this._activeBoardId = result.workspace.activeBoardId;
        this._theme = result.workspace.theme;
        this._query = '';
        this._syncActiveRef();
        this._afterChange('replace');
        return { ok: true, report: { repaired: result.repaired, issues: result.issues } };
      }
      const result = sanitizeBoard(isPlainObject(payload) && "board" in payload ? payload.board : payload, this._clock());
      if (!result.board) return { ok: false, reason: 'bad-payload' };
      const entry = this._activeEntry();
      if (!entry) return { ok: false, reason: 'no-boards' };
      entry.board = result.board;
      // Импорт старого файла с темой внутри доски: тема применяется глобально.
      const source = isPlainObject(payload) && "board" in payload ? payload.board : payload;
      if (isPlainObject(source) && typeof source.theme === 'string' && THEMES.some((item) => item.id === source.theme)) {
        this._theme = source.theme;
      }
      this._syncActiveRef();
      this._afterChange('replace');
      return { ok: true, report: { repaired: result.repaired, issues: result.issues } };
    }

    /** Отложенная запись ещё висит? (для тестов и сценария выхода) */
    hasPendingSave() {
      return this._dirty || this._saveTimer !== null;
    }
  }

  return {
    SCHEMA_VERSION,
    DEFAULT_COLUMNS,
    TAGS,
    COLORS,
    THEMES,
    DEFAULT_THEME,
    LIMITS,
    seedBoardData,
    matchesQuery,
    firstLine,
    sanitizeRich,
    strippedText,
    todayString,
    localDateString,
    sanitizeBoard,
    sanitizeWorkspace,
    sanitizeBoardName,
    normalizeOrders,
    computeReflowX,
    KanbanStore,
  };
});

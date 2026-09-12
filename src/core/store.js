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

  const SCHEMA_VERSION = 1;
  const DELETED_TASK_TTL_MS = 30 * 24 * 60 * 60 * 1000; // архив удалённых — 30 дней

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

  const LIMITS = { title: 300, note: 4000 };
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

  // Поиск по заголовку и заметке без учёта регистра.
  function matchesQuery(task, query) {
    const needle = String(query || '').trim().toLocaleLowerCase('ru');
    if (!needle) return true;
    const haystack = `${task.title}\n${task.note || ''}`.toLocaleLowerCase('ru');
    return haystack.includes(needle);
  }

  function cloneTask(task) {
    return {
      id: task.id,
      columnId: task.columnId,
      title: task.title,
      note: task.note,
      tag: task.tag,
      color: task.color,
      dueDate: task.dueDate,
      priority: task.priority,
      order: task.order,
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
          title: '',
          note: '',
          tag: null,
          color: null,
          dueDate: null,
          priority: false,
          order,
          createdAt: nowIso,
          updatedAt: nowIso,
          deletedAt: null,
        },
        fields
      );

    const tasks = [
      task('seed-1', 'pool', 1000, {
        title: 'Придумать оформление домашней страницы вики',
        note: 'Проверить, как выглядят карточки-ссылки: тень, отступы, заголовок.',
        tag: 'idea',
        color: 'mint',
      }),
      task('seed-2', 'pool', 2000, {
        title: 'Собрать список книг на осень',
        tag: 'study',
        color: 'blue',
      }),
      task('seed-3', 'urgent', 1000, {
        title: 'Оплатить продление сервера до пятницы',
        note: 'Счёт лежит в почте, платёжку подтверждает банк.',
        tag: 'urgent',
        color: 'pink',
        dueDate: localDateString(now + 2 * dayMs),
        priority: true,
      }),
      task('seed-4', 'in-progress', 1000, {
        title: 'Ревью pull request: модуль экспорта',
        tag: 'work',
        color: 'yellow',
      }),
      task('seed-5', 'waiting', 1000, {
        title: 'Ответ от макетчицы по цветам приложения',
        tag: 'personal',
        color: 'lilac',
      }),
      task('seed-6', 'done', 1000, {
        title: 'Настроить автосохранение доски',
        tag: 'work',
        color: 'mint',
      }),
    ];

    return {
      columns: DEFAULT_COLUMNS.map((column) => Object.assign({}, column)),
      tasks,
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
    const title = typeof raw.title === 'string' ? raw.title.trim().slice(0, LIMITS.title) : '';
    if (!title) return { task: null, issues: [`empty title: ${id}`] };

    let columnId = typeof raw.columnId === 'string' ? raw.columnId : '';
    if (!columnIds.has(columnId)) {
      columnId = null; // решим после — отправим в первую колонку
      issues.push(`unknown column for ${id}`);
    }
    const tag = TAGS.some((entry) => entry.id === raw.tag) ? raw.tag : null;
    const color = COLORS.includes(raw.color) ? raw.color : null;
    const dueDate = typeof raw.dueDate === 'string' && DATE_RE.test(raw.dueDate) ? raw.dueDate : null;
    const order = Number.isFinite(raw.order) ? raw.order : null;
    const createdAt = Number.isFinite(raw.createdAt) ? raw.createdAt : now;
    const updatedAt = Number.isFinite(raw.updatedAt) ? raw.updatedAt : createdAt;
    const deletedAt = Number.isFinite(raw.deletedAt) ? raw.deletedAt : null;

    return {
      task: {
        id,
        columnId, // может быть null — подставим ниже
        title,
        note: typeof raw.note === 'string' ? raw.note.slice(0, LIMITS.note) : '',
        tag,
        color,
        dueDate,
        priority: raw.priority === true,
        order,
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
      this._board = null;
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
      let board = null;
      if (this._storage) {
        let raw = null;
        try {
          raw = this._storage.load();
        } catch (error) {
          this._loadReport.issues.push(`load failed: ${error.message}`);
        }
        if (isPlainObject(raw) && raw.version !== undefined && raw.version !== SCHEMA_VERSION) {
          this._loadReport.issues.push(`unknown version ${raw.version}; best-effort load`);
        }
        const source = isPlainObject(raw) && "board" in raw ? raw.board : raw;
        const result = sanitizeBoard(source, now);
        if (result.board) {
          board = result.board;
          this._loadReport.repaired = result.repaired;
          this._loadReport.issues.push(...result.issues);
        }
      }
      if (!board) {
        board = sanitizeBoard(seedBoardData(this._clock), now).board;
        this._loadReport.seeded = true;
      }
      this._board = board;
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

    // -- задачи ----------------------------------------------------------

    _nextId() {
      this._idCounter += 1;
      return `t-${this._clock().toString(36)}-${this._idCounter.toString(36)}`;
    }

    createTask(input) {
      const fields = input || {};
      const title = typeof fields.title === 'string' ? fields.title.trim().slice(0, LIMITS.title) : '';
      if (!title) return { ok: false, reason: 'empty-title' };

      let column = fields.columnId ? this._column(fields.columnId) : null;
      if (!column) column = this._board.columns[0];
      if (!column) return { ok: false, reason: 'no-columns' };
      if (this._overLimit(column)) return { ok: false, reason: 'wip', columnId: column.id };

      const now = this._clock();
      const list = this._activeTasks(column.id);
      const first = list.length ? list[0] : null;
      const task = {
        id: this._nextId(),
        columnId: column.id,
        title,
        note: typeof fields.note === 'string' ? fields.note.slice(0, LIMITS.note) : '',
        tag: TAGS.some((entry) => entry.id === fields.tag) ? fields.tag : null,
        color: COLORS.includes(fields.color) ? fields.color : null,
        dueDate: typeof fields.dueDate === 'string' && DATE_RE.test(fields.dueDate) ? fields.dueDate : null,
        priority: fields.priority === true,
        // Новая задача кладётся наверх колонки — как свежий стикер в стопку.
        order: first ? first.order - 1000 : 1000,
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

      if ("title" in fields) {
        const title = typeof fields.title === 'string' ? fields.title.trim().slice(0, LIMITS.title) : '';
        if (!title) return { ok: false, reason: 'empty-title' };
        if (title !== task.title) {
          task.title = title;
          changed.push('title');
        }
      }
      if ("note" in fields) {
        const note = typeof fields.note === 'string' ? fields.note.slice(0, LIMITS.note) : '';
        if (note !== task.note) {
          task.note = note;
          changed.push('note');
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
     * задача уходит в конец колонки.
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
      if (previous && next && next.order - previous.order < 2) {
        normalizeOrders(this._board);
        previous = index > 0 ? list[index - 1] : null;
        next = index < list.length ? list[index] : null;
      }
      let order;
      if (!previous && !next) order = 1000;
      else if (!previous) order = next.order - 1000;
      else if (!next) order = previous.order + 1000;
      else order = (previous.order + next.order) / 2;

      const movedColumn = task.columnId !== target.id;
      task.columnId = target.id;
      task.order = order;
      task.updatedAt = this._clock();
      this._afterChange(movedColumn ? 'move' : 'reorder', task);
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
        title: `${source.title} (копия)`,
        note: source.note,
        tag: source.tag,
        color: source.color,
        dueDate: source.dueDate,
        priority: source.priority,
      });
      if (result.ok) {
        // Копия встаёт сразу за оригиналом.
        this.moveTask(result.task.id, source.columnId, { afterId: source.id });
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

    removeColumn(id) {
      const column = this._column(id);
      if (!column) return { ok: false, reason: 'not-found' };
      if (this._board.columns.length <= 1) return { ok: false, reason: 'last-column' };
      if (this._activeTasks(id).length > 0) return { ok: false, reason: 'not-empty' };
      // Архив удалённых задач колонки уходит вместе с ней.
      this._board.tasks = this._board.tasks.filter((task) => task.columnId !== id);
      this._board.columns = this._board.columns.filter((entry) => entry.id !== id);
      this._afterChange('column-remove', null, column);
      return { ok: true };
    }

    // -- персистентность --------------------------------------------------

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
      const payload = { version: SCHEMA_VERSION, savedAt: this._clock(), board: this.snapshot() };
      try {
        this._storage.save(payload);
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
     * Замена доски целиком (импорт/аварийное восстановление).
     * Используется тестами и инструментами; UI пока не вызывает.
     */
    replaceAll(payload) {
      const result = sanitizeBoard(isPlainObject(payload) && "board" in payload ? payload.board : payload, this._clock());
      if (!result.board) return { ok: false, reason: 'bad-payload' };
      this._board = result.board;
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
    LIMITS,
    seedBoardData,
    matchesQuery,
    todayString,
    localDateString,
    sanitizeBoard,
    normalizeOrders,
    KanbanStore,
  };
});

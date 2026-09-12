/*
 * Юнит-тесты ядра доски. Гоняются чистым Node (node --test), UI не нужен.
 * Запуск: npm test
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../src/core/store.js');

// Простое хранилище в памяти для тестов.
function memoryStorage(initial) {
  let value = initial || null;
  return {
    load: () => value,
    save: (payload) => {
      value = JSON.parse(JSON.stringify(payload));
    },
    peek: () => value,
  };
}

function makeStore(initial, options) {
  const storage = memoryStorage(initial);
  const store = new Core.KanbanStore(Object.assign({ storage, autosaveMs: 1 }, options));
  store.init();
  return { store, storage };
}

test('стартовая доска: пять колонок, задачи разложены', () => {
  const { store } = makeStore();
  const snapshot = store.snapshot();
  assert.equal(snapshot.columns.length, 5);
  assert.deepEqual(
    snapshot.columns.map((column) => column.id),
    ['pool', 'urgent', 'in-progress', 'waiting', 'done']
  );
  assert.equal(store.view().stats.total, 6);
  assert.equal(snapshot.columns.find((column) => column.id === 'in-progress').wipLimit, 3);
});

test('создание: новая задача встаёт наверх колонки', () => {
  const { store } = makeStore();
  const before = store.view().columns.find((column) => column.id === 'pool').tasks.map((task) => task.id);
  const result = store.createTask({ columnId: 'pool', title: 'Сверху' });
  assert.equal(result.ok, true);
  const after = store.view().columns.find((column) => column.id === 'pool').tasks.map((task) => task.id);
  assert.equal(after[0], result.task.id);
  assert.deepEqual(after.slice(1), before);
});

test('создание: пустой заголовок отклоняется', () => {
  const { store } = makeStore();
  const result = store.createTask({ columnId: 'pool', title: '   ' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'empty-title');
});

test('WIP-лимит: вход в переполненную колонку отклоняется и при создании, и при переносе', () => {
  const { store } = makeStore();
  // В колонке «в работе» лимит 3, уже 1 задача из стартовой доски.
  store.createTask({ columnId: 'in-progress', title: 'Раз' });
  store.createTask({ columnId: 'in-progress', title: 'Два' });
  const blockedCreate = store.createTask({ columnId: 'in-progress', title: 'Три — уже нельзя' });
  assert.equal(blockedCreate.ok, false);
  assert.equal(blockedCreate.reason, 'wip');

  const moveAttempt = store.moveTask('seed-1', 'in-progress', {});
  assert.equal(moveAttempt.ok, false);
  assert.equal(moveAttempt.reason, 'wip');
});

test('WIP-лимит не мешает двигать задачу внутри самой колонки', () => {
  const { store } = makeStore();
  const view = store.view().columns.find((column) => column.id === 'in-progress');
  const only = view.tasks[0];
  const result = store.moveTask(only.id, 'in-progress', {});
  assert.equal(result.ok, true);
});

test('перемещение: между двумя задачами даёт дробный порядок и сохраняет расстановку', () => {
  const { store } = makeStore();
  const pool = store.view().columns.find((column) => column.id === 'pool');
  const [first, second] = pool.tasks;
  const created = store.createTask({ columnId: 'pool', title: 'В серединку' });
  const result = store.moveTask(created.task.id, 'pool', { afterId: first.id, beforeId: second.id });
  assert.equal(result.ok, true);
  const order = store.view().columns.find((column) => column.id === 'pool').tasks.map((task) => task.id);
  assert.deepEqual(order.slice(0, 3), [first.id, created.task.id, second.id]);
});

test('перемещение: без соседей задача уходит в конец колонки', () => {
  const { store } = makeStore();
  const result = store.moveTask('seed-1', 'waiting', {});
  assert.equal(result.ok, true, JSON.stringify(result));
  const waiting = store.view().columns.find((column) => column.id === 'waiting');
  assert.equal(waiting.tasks[waiting.tasks.length - 1].id, 'seed-1');
});

test('перемещение: в самое начало колонки', () => {
  const { store } = makeStore();
  const waiting = store.view().columns.find((column) => column.id === 'waiting');
  const result = store.moveTask('seed-1', 'waiting', { beforeId: waiting.tasks[0].id });
  assert.equal(result.ok, true);
  const after = store.view().columns.find((column) => column.id === 'waiting');
  assert.equal(after.tasks[0].id, 'seed-1');
});

test('порядок не вырождается при серии вставок в одну щель', () => {
  const { store } = makeStore();
  const pool = store.view().columns.find((column) => column.id === 'pool');
  const anchor = pool.tasks[0];
  const below = pool.tasks[1];
  for (let index = 0; index < 40; index += 1) {
    const created = store.createTask({ columnId: 'pool', title: `Щель ${index}` });
    const result = store.moveTask(created.task.id, 'pool', { afterId: anchor.id, beforeId: below.id });
    assert.equal(result.ok, true);
  }
  const finalOrder = store.view().columns.find((column) => column.id === 'pool').tasks.map((task) => task.order);
  const sorted = [...finalOrder].sort((a, b) => a - b);
  assert.deepEqual(finalOrder, sorted, 'порядок должен остаться монотонным');
  const unique = new Set(finalOrder);
  assert.equal(unique.size, finalOrder.length, 'порядки не должны дублироваться');
});

test('правка: смена заголовка, метки, цвета, срока и флага', () => {
  const { store } = makeStore();
  const result = store.updateTask('seed-2', {
    title: 'Новый заголовок',
    note: 'Заметка',
    tag: 'work',
    color: 'pink',
    dueDate: '2026-09-20',
    priority: true,
  });
  assert.equal(result.ok, true);
  assert.equal(result.task.title, 'Новый заголовок');
  assert.equal(result.task.tag, 'work');
  assert.equal(result.task.color, 'pink');
  assert.equal(result.task.dueDate, '2026-09-20');
  assert.equal(result.task.priority, true);
});

test('правка: пустой заголовок отклоняется, состояние не меняется', () => {
  const { store } = makeStore();
  const before = store.getTask('seed-2').title;
  const result = store.updateTask('seed-2', { title: '   ' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'empty-title');
  assert.equal(store.getTask('seed-2').title, before);
});

test('правка: недопустимые метка и цвет сбрасываются в null', () => {
  const { store } = makeStore();
  const result = store.updateTask('seed-2', { tag: 'не-существует', color: 'радуга' });
  assert.equal(result.ok, true);
  assert.equal(result.task.tag, null);
  assert.equal(result.task.color, null);
});

test('удаление: мягкое, возврат восстанавливает задачу', () => {
  const { store } = makeStore();
  assert.equal(store.deleteTask('seed-2').ok, true);
  assert.equal(store.getTask('seed-2'), null);
  assert.equal(store.view().stats.total, 5);
  assert.equal(store.restoreTask('seed-2').ok, true);
  assert.equal(store.view().stats.total, 6);
});

test('дублирование: копия встаёт следом за оригиналом', () => {
  const { store } = makeStore();
  const result = store.duplicateTask('seed-1');
  assert.equal(result.ok, true);
  const pool = store.view().columns.find((column) => column.id === 'pool').tasks.map((task) => task.id);
  assert.equal(pool[0], 'seed-1');
  assert.equal(pool[1], result.task.id);
  assert.match(result.task.title, /копия/);
});

test('поиск: фильтрует видимые стикеры без изменения данных', () => {
  const { store } = makeStore();
  store.updateTask('seed-2', { note: 'Уникальное слово синхрофазотрон' });
  store.setQuery('синхрофазотрон');
  const view = store.view();
  const visible = view.columns.reduce((sum, column) => sum + column.visibleCount, 0);
  assert.equal(visible, 1);
  assert.equal(view.stats.total, 6);
  store.setQuery('');
  assert.equal(store.view().columns.reduce((sum, column) => sum + column.visibleCount, 0), 6);
});

test('колонки: добавление, переименование, лимит, удаление пустой', () => {
  const { store } = makeStore();
  const added = store.addColumn('Идеи на потом');
  assert.equal(added.ok, true);
  assert.equal(store.renameColumn(added.column.id, 'Архив идей').ok, true);
  assert.equal(store.setWipLimit(added.column.id, 5).ok, true);
  const snapshot = store.snapshot();
  assert.equal(snapshot.columns.find((column) => column.id === added.column.id).wipLimit, 5);
  assert.equal(store.setWipLimit(added.column.id, null).ok, true);
  assert.equal(store.removeColumn(added.column.id).ok, true);
});

test('колонки: непустую и последнюю удалить нельзя', () => {
  const { store } = makeStore();
  const notEmpty = store.removeColumn('pool');
  assert.equal(notEmpty.ok, false);
  assert.equal(notEmpty.reason, 'not-empty');
  const single = new Core.KanbanStore({ storage: memoryStorage() });
  single.init();
  single.replaceAll({ columns: [{ id: 'only', title: 'Единственная' }], tasks: [] });
  const last = single.removeColumn('only');
  assert.equal(last.ok, false);
  assert.equal(last.reason, 'last-column');
});

test('сохранение: изменение планирует запись, flush пишет версию и доску', () => {
  const { store, storage } = makeStore();
  store.createTask({ columnId: 'pool', title: 'К сохранению' });
  assert.equal(store.hasPendingSave(), true);
  const result = store.flush();
  assert.equal(result.ok, true);
  const saved = storage.peek();
  assert.equal(saved.version, Core.SCHEMA_VERSION);
  assert.equal(typeof saved.savedAt, 'number');
  assert.ok(Array.isArray(saved.board.tasks));
  assert.equal(store.hasPendingSave(), false);
  assert.ok(store.lastSavedAt() > 0);
});

test('сохранение: ошибка диска не роняет доску, ошибка видна наружу', () => {
  const storage = {
    load: () => null,
    save: () => {
      throw new Error('диск полон');
    },
  };
  const store = new Core.KanbanStore({ storage, autosaveMs: 1 });
  store.init();
  store.createTask({ columnId: 'pool', title: 'Упс' });
  const result = store.flush();
  assert.equal(result.ok, false);
  assert.match(store.lastSaveError(), /диск полон/);
});

test('санитизация: битые данные чинятся, хорошие задачи выживают', () => {
  const broken = {
    version: 1,
    board: {
      columns: [
        { id: 'pool', title: 'Пул', wipLimit: null, role: 'pool' },
        { id: 'bad id!', title: 'Кривая' },
        { id: 'pool', title: 'Дубль' },
      ],
      tasks: [
        { id: 'a', columnId: 'pool', title: 'Живая', order: 1000 },
        { id: 'b', columnId: 'нет-такой', title: 'Потеряшка', order: 500 },
        { id: 'c', columnId: 'pool', title: '', order: 100 },
        { id: 'd', columnId: 'pool', title: 'Дубль айди', order: 100 },
        { id: 'a', columnId: 'pool', title: 'Дубликат id', order: 100 },
        null,
      ],
    },
  };
  const { store } = makeStore(broken);
  const snapshot = store.snapshot();
  assert.equal(snapshot.columns.length, 1);
  // «Дубль айди» — уникальный id при неуникальном order: задача переживает
  // санитизацию, а её порядок нормализуется.
  const poolView = store.view().columns[0];
  assert.deepEqual(
    poolView.tasks.map((task) => task.title),
    ['Дубль айди', 'Потеряшка', 'Живая'],
    'после нормализации порядок задаётся исходными order'
  );
  assert.equal(
    snapshot.tasks.find((task) => task.title === 'Потеряшка').columnId,
    'pool',
    'задача из неизвестной колонки едет в первую'
  );
  const normalized = poolView.tasks.map((task) => task.order);
  assert.deepEqual(normalized, [1000, 2000, 3000], 'порядки нормализованы');
});

test('санитизация: без колонок подставляются стандартные', () => {
  const { store } = makeStore({ board: { columns: [], tasks: [] } });
  assert.equal(store.snapshot().columns.length, 5);
});

test('санитизация: старые удалённые задачи вычищаются', () => {
  const old = Date.now() - 40 * 24 * 60 * 60 * 1000;
  const { store } = makeStore({
    board: {
      columns: [{ id: 'pool', title: 'Пул' }],
      tasks: [
        { id: 'old', columnId: 'pool', title: 'Стародавняя', order: 1000, deletedAt: old },
        { id: 'new', columnId: 'pool', title: 'Свежая', order: 2000, deletedAt: Date.now() - 1000 },
      ],
    },
  });
  const ids = store.snapshot().tasks.map((task) => task.id);
  assert.deepEqual(ids, ['new']);
});

test('порядок загрузки: файл повреждён — поднимается стартовая доска', () => {
  const storage = {
    load: () => {
      throw new Error('файл не читается');
    },
    save: () => {},
  };
  const store = new Core.KanbanStore({ storage });
  const report = store.init();
  assert.equal(report.seeded, true);
  assert.equal(store.snapshot().columns.length, 5);
});

test('просроченные задачи считаются только вне завершённых', () => {
  const { store } = makeStore({
    board: {
      columns: [{ id: 'pool', title: 'Пул' }, { id: 'done', title: 'Готово', role: 'done' }],
      tasks: [
        { id: 'late', columnId: 'pool', title: 'Просрочена', order: 1000, dueDate: '2020-01-01' },
        { id: 'late-done', columnId: 'done', title: 'Просрочена, но закрыта', order: 1000, dueDate: '2020-01-01' },
        { id: 'future', columnId: 'pool', title: 'В будущем', order: 2000, dueDate: '2099-01-01' },
      ],
    },
  });
  assert.equal(store.view().stats.overdue, 1);
});

test('нормализация порядков сохраняет взаимный порядок задач', () => {
  const board = {
    columns: [{ id: 'a', title: 'A' }],
    tasks: [
      { id: 'x', columnId: 'a', title: 'Икс', order: 5 },
      { id: 'y', columnId: 'a', title: 'Игрек', order: 5 },
      { id: 'z', columnId: 'a', title: 'Зет', order: 1 },
    ],
  };
  const changed = Core.normalizeOrders(board);
  assert.equal(changed, true);
  const byId = Object.fromEntries(board.tasks.map((task) => [task.id, task]));
  assert.ok(byId.z.order < byId.x.order);
  assert.ok(byId.x.order < byId.y.order);
});

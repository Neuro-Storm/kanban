/*
 * Интерфейс канбан-доски.
 *
 * Здесь живёт всё, что видит пользователь: рендер колонок и стикеров,
 * перетаскивание (свой drag-and-drop с призраком и подстановкой места),
 * редактор стикера, тосты с отменой, настройки колонок и автоподпись
 * о сохранении. Доменные правила — в ../core/store.js.
 */
(function () {
  'use strict';

  const Core = window.KanbanCore;
  if (!Core) throw new Error('KanbanCore не загружен');

  // ---------------------------------------------------------------------
  // Хранилище: Electron IPC или localStorage в отладочном режиме
  // ---------------------------------------------------------------------

  function createStorage() {
    if (window.kanbanAPI && typeof window.kanbanAPI.loadBoard === 'function') {
      return {
        load: () => window.kanbanAPI.loadBoard(),
        save: (payload) => window.kanbanAPI.saveBoard(payload),
      };
    }
    const KEY = 'kanban-board-v1';
    return {
      load: () => {
        const raw = window.localStorage.getItem(KEY);
        return raw ? JSON.parse(raw) : null;
      },
      save: (payload) => window.localStorage.setItem(KEY, JSON.stringify(payload)),
    };
  }

  const store = new Core.KanbanStore({ storage: createStorage(), autosaveMs: 450 });
  const loadReport = store.init();

  // ---------------------------------------------------------------------
  // Ссылки на DOM
  // ---------------------------------------------------------------------

  const dom = {
    board: document.getElementById('board'),
    addColumnBtn: document.getElementById('addColumnBtn'),
    addTaskBtn: document.getElementById('addTaskBtn'),
    searchInput: document.getElementById('searchInput'),
    searchBox: document.querySelector('.search'),
    searchClear: document.getElementById('searchClear'),
    saveStatus: document.getElementById('saveStatus'),
    toasts: document.getElementById('toasts'),
    modalBackdrop: document.getElementById('modalBackdrop'),
    confirmPop: document.getElementById('confirmPop'),
    tplColumn: document.getElementById('tpl-column'),
    tplSticker: document.getElementById('tpl-sticker'),
    tplEditor: document.getElementById('tpl-editor'),
  };

  // Режимы автосъёмки: smoke — прогон тестов, shot — чистый кадр для превью.
  const query = new URLSearchParams(window.location.search);
  const SMOKE = query.has('smoke');
  const SHOT = query.has('shot');
  if (SMOKE || SHOT) document.documentElement.classList.add('smoke');

  function notifySmoke(message) {
    if (window.kanbanAPI && typeof window.kanbanAPI.smokeLog === 'function') {
      window.kanbanAPI.smokeLog(message);
    }
  }

  window.addEventListener('error', (event) => {
    notifySmoke(`UI ERROR: ${event.message}`);
  });

  // ---------------------------------------------------------------------
  // Вспомогательные функции
  // ---------------------------------------------------------------------

  const TAGS = Core.TAGS;
  const COLORS = Core.COLORS;

  function tagLabel(id) {
    const entry = TAGS.find((tag) => tag.id === id);
    return entry ? entry.label : null;
  }

  function formatDue(dueDate, todayStr) {
    if (!dueDate) return null;
    if (dueDate === todayStr) return { text: 'сегодня', className: 'due-today' };
    const tomorrowStr = Core.localDateString(Date.now() + 24 * 60 * 60 * 1000);
    const [year, month, day] = dueDate.split('-');
    const short = year === todayStr.slice(0, 4) ? `${day}.${month}` : `${day}.${month}.${year}`;
    if (dueDate === tomorrowStr) return { text: 'завтра', className: '' };
    if (dueDate < todayStr) return { text: `⏰ просрочено · ${short}`, className: 'due-over' };
    return { text: `до ${short}`, className: '' };
  }

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  // ---------------------------------------------------------------------
  // Рендер доски
  // ---------------------------------------------------------------------

  let lastRendered = null;
  let landedTaskId = null;

  function render(options) {
    const opts = options || {};
    const view = store.view();
    const todayStr = Core.todayString(Date.now);
    const activeElement = document.activeElement;
    const editingTitleColumnId =
      activeElement && activeElement.classList.contains('column-title')
        ? activeElement.closest('.column').dataset.columnId
        : null;

    // Колонки перестраиваем полностью (их немного), списки — переиспользуем,
    // чтобы не терять позиции скролла и не мигать анимациями.
    const existing = new Map();
    for (const node of dom.board.children) {
      if (node.dataset.columnId) existing.set(node.dataset.columnId, node);
    }

    const orderedNodes = [];
    for (const viewColumn of view.columns) {
      let columnNode = existing.get(viewColumn.id);
      if (!columnNode) {
        columnNode = buildColumnNode(viewColumn);
      } else {
        existing.delete(viewColumn.id);
        updateColumnHeader(columnNode, viewColumn);
      }
      renderStickers(columnNode, viewColumn, todayStr, opts);
      orderedNodes.push(columnNode);
    }
    for (const stale of existing.values()) stale.remove();

    for (const node of orderedNodes) dom.board.appendChild(node);

    // Подпись о состоянии хранилища.
    if (loadReport.seeded && !loadReport.reported && !SHOT) {
      loadReport.reported = true;
      toast('Первая доска готова — стикеры уже разложены', null);
    }
    if ((loadReport.seeded || loadReport.repaired) && window.kanbanAPI) {
      store.flush();
    }
    lastRendered = view;
    refreshSaveStatus();
  }

  function buildColumnNode(viewColumn) {
    const node = dom.tplColumn.content.firstElementChild.cloneNode(true);
    node.dataset.columnId = viewColumn.id;
    node.dataset.role = viewColumn.role || 'custom';
    updateColumnHeader(node, viewColumn);
    return node;
  }

  function updateColumnHeader(node, viewColumn) {
    const titleNode = node.querySelector('[data-role="title"]');
    if (titleNode.textContent !== viewColumn.title) titleNode.textContent = viewColumn.title;
    node.querySelector('[data-role="count"]').textContent = viewColumn.wipLimit
      ? `${viewColumn.count}/${viewColumn.wipLimit}`
      : String(viewColumn.count);
    node.classList.toggle('at-limit', viewColumn.atLimit && !viewColumn.overLimit);
    node.classList.toggle('over-limit', viewColumn.overLimit);
  }

  function renderStickers(columnNode, viewColumn, todayStr, opts) {
    const list = columnNode.querySelector('[data-role="list"]');
    list.dataset.columnId = viewColumn.id;

    if (viewColumn.tasks.length === 0) {
      list.innerHTML = '';
      const hint = element(
        'div',
        'empty-hint',
        viewColumn.tasks.length === 0 && lastRendered && lastRendered.query
          ? 'Ничего не нашлось'
          : 'Пусто. Перетащи сюда стикер или добавь новый.'
      );
      list.appendChild(hint);
      return;
    }

    list.querySelectorAll('.empty-hint').forEach((node) => node.remove());

    // Переиспользуем существующие узлы стикеров.
    const existing = new Map();
    for (const node of list.children) {
      if (node.dataset.taskId) existing.set(node.dataset.taskId, node);
    }

    for (const task of viewColumn.tasks) {
      let sticker = existing.get(task.id);
      if (!sticker) {
        sticker = buildStickerNode(task);
      } else {
        existing.delete(task.id);
      }
      updateStickerNode(sticker, task, todayStr, viewColumn);
      list.appendChild(sticker);
    }
    for (const stale of existing.values()) stale.remove();

    if (landedTaskId) {
      const landed = list.querySelector(`[data-task-id="${landedTaskId}"]`);
      if (landed) {
        landed.classList.add('landed');
        setTimeout(() => landed.classList.remove('landed'), 320);
        landedTaskId = null;
      }
    }
  }

  function buildStickerNode(task) {
    const node = dom.tplSticker.content.firstElementChild.cloneNode(true);
    node.dataset.taskId = task.id;
    return node;
  }

  function updateStickerNode(node, task, todayStr, viewColumn) {
    node.dataset.color = task.color || 'yellow';
    const titleNode = node.querySelector('[data-role="title"]');
    if (titleNode.textContent !== task.title) titleNode.textContent = task.title;

    const noteNode = node.querySelector('[data-role="note"]');
    const noteText = (task.note || '').trim();
    noteNode.textContent = noteText;
    noteNode.hidden = noteText.length === 0;

    const badges = node.querySelector('[data-role="badges"]');
    badges.innerHTML = '';
    if (task.priority) badges.appendChild(element('span', 'pill prio', '⚑ срочно'));
    if (viewColumn.role === 'done') badges.appendChild(element('span', 'pill done-chip', '✓ готово'));
    badges.hidden = badges.children.length === 0;

    const meta = node.querySelector('[data-role="meta"]');
    meta.innerHTML = '';
    const label = tagLabel(task.tag);
    if (label) meta.appendChild(element('span', 'pill', label));
    const due = formatDue(task.dueDate, todayStr);
    if (due && viewColumn.role !== 'done') {
      meta.appendChild(element('span', `pill ${due.className}`.trim(), due.text));
    }
    meta.hidden = meta.children.length === 0;

    node.classList.toggle('is-priority', task.priority);
  }

  // ---------------------------------------------------------------------
  // Перетаскивание
  // ---------------------------------------------------------------------

  const drag = {
    active: false,
    taskId: null,
    sourceNode: null,
    ghost: null,
    grabOffsetX: 0,
    grabOffsetY: 0,
    pointerId: null,
    pointerType: 'mouse',
    startX: 0,
    startY: 0,
    currentColumnNode: null,
    slot: null,
    lastX: 0,
    lastY: 0,
  };

  // Порог движения: пока курсор не сдвинулся дальше, жест считается кликом.
  function dragTolerance(pointerType) {
    return pointerType === 'touch' ? 12 : 5;
  }

  function onPointerDown(event) {
    if (event.button !== 0) return;
    const sticker = event.target.closest('.sticker');
    if (!sticker) return;
    if (event.target.closest('.sticker-actions') || event.target.closest('button')) return;

    drag.pointerId = event.pointerId;
    drag.taskId = sticker.dataset.taskId;
    drag.sourceNode = sticker;
    drag.pointerType = event.pointerType || 'mouse';
    drag.startX = event.clientX;
    drag.startY = event.clientY;
    drag.lastX = event.clientX;
    drag.lastY = event.clientY;
    try {
      sticker.setPointerCapture(event.pointerId);
    } catch (error) {
      /* синтетические события в тестах могут не иметь активного pointerId */
    }

    const rect = sticker.getBoundingClientRect();
    drag.grabOffsetX = event.clientX - rect.left;
    drag.grabOffsetY = event.clientY - rect.top;
  }

  function beginDrag(clientX, clientY) {
    if (drag.active) return;
    if (clientX === undefined) {
      clientX = drag.lastX;
      clientY = drag.lastY;
    }
    drag.active = true;
    document.body.classList.add('dragging-active');

    const source = drag.sourceNode;
    source.classList.add('dragging');
    source.style.pointerEvents = 'none';

    const ghost = source.cloneNode(true);
    ghost.classList.add('drag-ghost');
    ghost.classList.remove('dragging');
    const sourceRect = source.getBoundingClientRect();
    ghost.style.width = `${sourceRect.width}px`;
    ghost.style.left = `${clientX - drag.grabOffsetX}px`;
    ghost.style.top = `${clientY - drag.grabOffsetY}px`;
    document.body.appendChild(ghost);
    drag.ghost = ghost;

    // На время перетаскивания отключаем наведение на исходный узел.
    const under = document.elementFromPoint(clientX, clientY);
    const columnNode = under ? under.closest('.column') : null;
    updateDropTarget(columnNode, clientX, clientY);
  }

  function moveDrag(clientX, clientY) {
    drag.lastX = clientX;
    drag.lastY = clientY;
    if (!drag.active) return;

    const ghost = drag.ghost;
    if (ghost) {
      ghost.style.left = `${clientX - drag.grabOffsetX}px`;
      ghost.style.top = `${clientY - drag.grabOffsetY}px`;
    }

    const under = document.elementFromPoint(clientX, clientY);
    const columnNode = under ? under.closest('.column') : null;
    if (columnNode) updateDropTarget(columnNode, clientX, clientY);
  }

  function updateDropTarget(columnNode, clientX, clientY) {
    if (drag.currentColumnNode !== columnNode) {
      if (drag.currentColumnNode) {
        drag.currentColumnNode.classList.remove('drop-target');
        // Перешли в другую колонку — старый слот не нужен.
        if (drag.currentColumnNode !== columnNode && drag.slot) removeSlot();
      }
      drag.currentColumnNode = columnNode;
      if (columnNode) columnNode.classList.add('drop-target');
    }
    if (!columnNode) {
      if (drag.slot) removeSlot();
      return;
    }

    const list = columnNode.querySelector('[data-role="list"]');
    const slot = ensureSlot(list, clientY);
    if (slot) slot.style.height = `${Math.max(34, drag.sourceNode.getBoundingClientRect().height * 0.55)}px`;
  }

  function ensureSlot(list, clientY) {
    const stickers = [...list.querySelectorAll('.sticker')].filter((node) => !node.classList.contains('dragging'));
    let reference = null;
    for (const sticker of stickers) {
      const rect = sticker.getBoundingClientRect();
      if (clientY < rect.top + rect.height / 2) {
        reference = sticker;
        break;
      }
    }
    if (!drag.slot) {
      drag.slot = element('div', 'drop-slot');
      list.appendChild(drag.slot);
    }
    if (reference) {
      if (drag.slot.nextElementSibling !== reference) list.insertBefore(drag.slot, reference);
    } else if (list.lastElementChild !== drag.slot) {
      list.appendChild(drag.slot);
    }
    return drag.slot;
  }

  function removeSlot() {
    if (drag.slot) {
      drag.slot.remove();
      drag.slot = null;
    }
  }

  function dropDrag() {
    if (!drag.active) {
      cancelDrag(true);
      return;
    }
    const columnNode = drag.currentColumnNode;
    const list = columnNode ? columnNode.querySelector('[data-role="list"]') : null;
    const slot = drag.slot;

    if (list && slot) {
      // Место вставки: первый стикер после слота — beforeId,
      // последний перед слотом — afterId. Тянущийся стикер исключён из DOM-выборки.
      const children = [...list.children];
      const slotIndex = children.indexOf(slot);
      const isSticker = (node) =>
        node.classList && node.classList.contains('sticker') && !node.classList.contains('dragging');
      const after = children.slice(slotIndex + 1).find(isSticker);
      const beforeList = children.slice(0, slotIndex).filter(isSticker);
      const before = beforeList.length ? beforeList[beforeList.length - 1] : null;
      const beforeId = after ? after.dataset.taskId : null;
      const afterId = before ? before.dataset.taskId : null;

      const result = store.moveTask(drag.taskId, columnNode.dataset.columnId, { afterId, beforeId });
      if (!result.ok && result.reason === 'wip') {
        const column = store.snapshot().columns.find((entry) => entry.id === result.columnId);
        toast(
          `«${column ? column.title : 'Колонка'}»: WIP-лимит ${result.limit}. Сначала заверши что-то из текущего.`,
          null
        );
      }
    }
    landedTaskId = drag.taskId;
    cancelDrag(false);
  }

  function cancelDrag(releaseOnly) {
    const taskId = drag.taskId;
    if (drag.active) {
      document.body.classList.remove('dragging-active');
      if (drag.ghost) drag.ghost.remove();
      if (drag.sourceNode) {
        drag.sourceNode.classList.remove('dragging', 'drag-lift');
        drag.sourceNode.style.pointerEvents = '';
      }
      if (drag.currentColumnNode) drag.currentColumnNode.classList.remove('drop-target');
      removeSlot();
    }
    if (drag.sourceNode && drag.pointerId !== null) {
      try {
        drag.sourceNode.releasePointerCapture(drag.pointerId);
      } catch (error) {
        /* pointer уже отпущен */
      }
    }
    drag.active = false;
    drag.taskId = null;
    drag.sourceNode = null;
    drag.ghost = null;
    drag.pointerId = null;
    drag.currentColumnNode = null;
    if (!releaseOnly && taskId) render();
    void releaseOnly;
  }

  function onPointerMove(event) {
    if (drag.pointerId === null || event.pointerId !== drag.pointerId) return;
    drag.lastX = event.clientX;
    drag.lastY = event.clientY;

    if (!drag.active) {
      const dx = event.clientX - drag.startX;
      const dy = event.clientY - drag.startY;
      const tolerance = dragTolerance(drag.pointerType);
      if (dx * dx + dy * dy > tolerance * tolerance) {
        beginDrag(event.clientX, event.clientY);
      }
      return;
    }
    event.preventDefault();
    moveDrag(event.clientX, event.clientY);
  }

  function onPointerUp(event) {
    if (drag.pointerId === null || event.pointerId !== drag.pointerId) return;
    if (drag.active) {
      dropDrag();
      return;
    }
    // Курсор не сдвинулся — это клик: открываем редактор.
    const taskId = drag.taskId;
    cancelDrag(true);
    if (taskId) openEditor(taskId);
  }

  // Enter на сфокусированном стикере открывает редактор (доступность с клавиатуры).
  dom.board.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && event.target.classList && event.target.classList.contains('sticker')) {
      openEditor(event.target.dataset.taskId);
    }
  });

  dom.board.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('pointermove', onPointerMove, { passive: false });
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', () => cancelDrag(false));

  // Колесо при зажатой средней кнопке — прокрутка доски (как в графических редакторах).
  dom.board.addEventListener('auxclick', (event) => event.preventDefault());
  window.addEventListener('mousedown', (event) => {
    if (event.button === 1) event.preventDefault();
  });

  // ---------------------------------------------------------------------
  // Редактор стикера
  // ---------------------------------------------------------------------

  let editorNode = null;
  let editorTaskId = null;
  let editorDraft = null;

  function openEditor(taskId) {
    const task = store.getTask(taskId);
    if (!task) return;
    closeEditor();
    editorTaskId = taskId;
    editorDraft = {
      title: task.title,
      note: task.note || '',
      tag: task.tag,
      color: task.color,
      dueDate: task.dueDate,
      priority: task.priority,
    };

    editorNode = dom.tplEditor.content.firstElementChild.cloneNode(true);
    document.querySelector('.app').appendChild(editorNode);
    dom.modalBackdrop.hidden = false;
    requestAnimationFrame(() => dom.modalBackdrop.classList.add('show'));

    const titleInput = editorNode.querySelector('#editTitle');
    const noteInput = editorNode.querySelector('#editNote');
    const dueInput = editorNode.querySelector('#editDue');
    const priorityInput = editorNode.querySelector('#editPriority');

    titleInput.value = editorDraft.title;
    noteInput.value = editorDraft.note;
    dueInput.value = editorDraft.dueDate || '';
    priorityInput.checked = editorDraft.priority;

    // Метки
    const tagsBox = editorNode.querySelector('#editTags');
    tagsBox.innerHTML = '';
    for (const tag of TAGS) {
      const chip = element('button', 'tag-chip', tag.label);
      chip.type = 'button';
      chip.dataset.tag = tag.id;
      chip.classList.toggle('selected', editorDraft.tag === tag.id);
      chip.addEventListener('click', () => {
        editorDraft.tag = editorDraft.tag === tag.id ? null : tag.id;
        for (const other of tagsBox.children) other.classList.toggle('selected', other.dataset.tag === editorDraft.tag);
      });
      tagsBox.appendChild(chip);
    }

    // Цвета
    const colorsBox = editorNode.querySelector('#editColors');
    colorsBox.innerHTML = '';
    for (const color of ['none', ...COLORS]) {
      const dot = element('button', 'color-dot');
      dot.type = 'button';
      dot.dataset.color = color;
      dot.title = color === 'none' ? 'По умолчанию' : color;
      dot.classList.toggle('selected', (editorDraft.color || 'none') === color);
      dot.addEventListener('click', () => {
        editorDraft.color = color === 'none' ? null : color;
        for (const other of colorsBox.children) {
          other.classList.toggle('selected', (editorDraft.color || 'none') === other.dataset.color);
        }
      });
      colorsBox.appendChild(dot);
    }

    titleInput.addEventListener('input', () => {
      editorDraft.title = titleInput.value;
    });
    noteInput.addEventListener('input', () => {
      editorDraft.note = noteInput.value;
    });
    dueInput.addEventListener('change', () => {
      editorDraft.dueDate = dueInput.value || null;
    });
    priorityInput.addEventListener('change', () => {
      editorDraft.priority = priorityInput.checked;
    });

    editorNode.querySelector('#editSave').addEventListener('click', () => saveEditor(true));
    editorNode.querySelector('#editDuplicate').addEventListener('click', () => {
      commitEditorDraft();
      store.duplicateTask(editorTaskId);
      toast('Стикер продублирован', null);
      closeEditor();
    });
    editorNode.querySelector('#editDelete').addEventListener('click', () => {
      const id = editorTaskId;
      closeEditor();
      doDelete(id);
    });

    // Ctrl+Enter — сохранить, Escape — закрыть.
    editorNode.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        closeEditor();
      }
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) saveEditor(true);
    });

    dom.modalBackdrop.addEventListener('click', onBackdropClick);
    dom.modalBackdrop.addEventListener('transitionend', hideBackdropIfIdle);
    titleInput.focus();
    titleInput.select();
  }

  function onBackdropClick() {
    saveEditor(true);
  }

  function hideBackdropIfIdle() {
    if (!dom.modalBackdrop.classList.contains('show')) dom.modalBackdrop.hidden = true;
  }

  function commitEditorDraft() {
    if (!editorTaskId || !editorDraft) return { ok: false };
    let title = editorDraft.title.trim();
    if (!title) {
      // Пустой заголовок недопустим — возвращаем исходный.
      const original = store.getTask(editorTaskId);
      title = original ? original.title : 'Без названия';
    }
    return store.updateTask(editorTaskId, {
      title,
      note: editorDraft.note,
      tag: editorDraft.tag,
      color: editorDraft.color,
      dueDate: editorDraft.dueDate,
      priority: editorDraft.priority,
    });
  }

  function saveEditor(shouldClose) {
    const result = commitEditorDraft();
    if (result && result.ok === false && result.reason === 'empty-title') {
      toast('У стикера должен быть заголовок', null);
      return;
    }
    if (shouldClose) closeEditor();
  }

  function closeEditor() {
    if (!editorNode) return;
    editorNode.remove();
    editorNode = null;
    editorTaskId = null;
    editorDraft = null;
    dom.modalBackdrop.classList.remove('show');
    setTimeout(() => {
      if (!editorNode) dom.modalBackdrop.hidden = true;
    }, 260);
    render();
  }

  // ---------------------------------------------------------------------
  // Действия со стикерами
  // ---------------------------------------------------------------------

  function doDelete(taskId) {
    const task = store.getTask(taskId);
    const result = store.deleteTask(taskId);
    if (!result.ok) return;
    const title = task ? task.title : 'Стикер';
    toast(`«${truncate(title, 40)}» удалён`, {
      label: 'Вернуть',
      action: () => {
        store.restoreTask(taskId);
        render();
      },
    });
  }

  function doComplete(taskId) {
    const snapshot = store.snapshot();
    const doneColumn = snapshot.columns.find((column) => column.role === 'done');
    const task = store.getTask(taskId);
    if (!task) return;
    if (task.columnId === (doneColumn && doneColumn.id)) {
      toast('Уже завершено', null);
      return;
    }
    const target = doneColumn || snapshot.columns[snapshot.columns.length - 1];
    const result = store.moveTask(taskId, target.id, {});
    if (!result.ok && result.reason === 'wip') {
      toast(`«${target.title}»: WIP-лимит ${target.wipLimit}`, null);
      return;
    }
    landedTaskId = taskId;
    render();
    toast('Перенесено в «Завершено»', {
      label: 'Вернуть',
      action: () => {
        const backColumn = snapshot.columns.find((column) => column.id === task.columnId);
        store.moveTask(taskId, backColumn ? backColumn.id : snapshot.columns[0].id, {});
        render();
      },
    });
  }

  function truncate(text, length) {
    return text.length > length ? `${text.slice(0, length - 1)}…` : text;
  }

  // Клики по кнопкам стикера и заголовкам колонок (делегирование).
  dom.board.addEventListener('click', (event) => {
    const actionButton = event.target.closest('[data-action]');
    if (actionButton) {
      const sticker = actionButton.closest('.sticker');
      const column = actionButton.closest('.column');
      const action = actionButton.dataset.action;
      if (action === 'delete' && sticker) return doDelete(sticker.dataset.taskId);
      if (action === 'complete' && sticker) return doComplete(sticker.dataset.taskId);
      if (action === 'duplicate' && sticker) {
        store.duplicateTask(sticker.dataset.taskId);
        render();
        toast('Стикер продублирован', null);
        return;
      }
      if (action === 'quick-add' && column) return quickAdd(column.dataset.columnId);
      if (action === 'column-menu' && column) return openColumnMenu(column, actionButton);
    }

    const titleNode = event.target.closest('.column-title');
    if (titleNode) {
      const columnNode = titleNode.closest('.column');
      startTitleEdit(columnNode, titleNode);
      return;
    }
  });

  function quickAdd(columnId) {
    const result = store.createTask({ columnId, title: 'Новый стикер', color: pickColor() });
    if (!result.ok) {
      if (result.reason === 'wip') {
        const column = store.snapshot().columns.find((entry) => entry.id === result.columnId);
        toast(`«${column.title}»: WIP-лимит ${column.wipLimit} — стикер не добавлен`, null);
      }
      return;
    }
    landedTaskId = result.task.id;
    render();
    openEditor(result.task.id);
  }

  function pickColor() {
    return COLORS[Math.floor(Math.random() * COLORS.length)];
  }

  // ---------------------------------------------------------------------
  // Заголовки колонок
  // ---------------------------------------------------------------------

  function startTitleEdit(columnNode, titleNode) {
    const columnId = columnNode.dataset.columnId;
    const column = store.snapshot().columns.find((entry) => entry.id === columnId);
    if (!column) return;
    titleNode.contentEditable = 'plaintext-only';
    titleNode.focus();
    const range = document.createRange();
    range.selectNodeContents(titleNode);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);

    let finished = false;
    const onKeyDown = (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        titleNode.blur();
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        finish(false);
      }
    };
    const finish = (commit) => {
      if (finished) return;
      finished = true;
      titleNode.removeEventListener('keydown', onKeyDown);
      titleNode.removeEventListener('blur', onBlur);
      titleNode.contentEditable = 'false';
      if (commit) {
        const newTitle = titleNode.textContent.trim();
        const result = store.renameColumn(columnId, newTitle);
        if (!result.ok && result.reason === 'empty-title') {
          toast('Название колонки не может быть пустым', null);
        }
      }
      render();
    };
    const onBlur = () => finish(true); // объявлена ниже, но вызовется позже — на момент срабатывания уже существует

    titleNode.addEventListener('blur', onBlur);
    titleNode.addEventListener('keydown', onKeyDown);
  }

  // ---------------------------------------------------------------------
  // Меню колонки
  // ---------------------------------------------------------------------

  function openColumnMenu(columnNode, anchor) {
    const columnId = columnNode.dataset.columnId;
    const snapshot = store.snapshot();
    const column = snapshot.columns.find((entry) => entry.id === columnId);
    if (!column) return;
    closeConfirmPop();

    const pop = element('div', 'column-menu');
    pop.style.cssText =
      'position:fixed;z-index:50;background:var(--paper);border-radius:12px;' +
      'box-shadow:0 18px 40px -14px rgba(40,34,22,.55);padding:10px;display:flex;' +
      'flex-direction:column;gap:6px;min-width:200px;';

    const wipRow = element('div', '');
    wipRow.style.cssText = 'display:flex;align-items:center;gap:8px;padding:4px 6px;';
    wipRow.appendChild(element('span', 'field-label', 'WIP-лимит'));
    const wipInput = document.createElement('input');
    wipInput.type = 'number';
    wipInput.min = '1';
    wipInput.value = column.wipLimit === null ? '' : String(column.wipLimit);
    wipInput.placeholder = '∞';
    wipInput.style.cssText =
      'width:64px;border:1px solid rgba(87,77,56,.2);border-radius:8px;padding:5px 8px;font:inherit;font-size:14px;';
    wipRow.appendChild(wipInput);
    pop.appendChild(wipRow);

    const applyBtn = element('button', 'tag-chip', 'Применить лимит');
    applyBtn.addEventListener('click', () => {
      const raw = wipInput.value.trim();
      const result = store.setWipLimit(columnId, raw === '' ? null : Number(raw));
      if (!result.ok) toast('Лимит должен быть целым числом больше нуля', null);
      closeConfirmPop();
      render();
    });
    pop.appendChild(applyBtn);

    const removeBtn = element('button', 'btn btn-ghost-danger', 'Удалить колонку');
    removeBtn.style.marginTop = '2px';
    removeBtn.addEventListener('click', () => {
      const result = store.removeColumn(columnId);
      if (!result.ok) {
        const messages = {
          'not-empty': 'Сначала перенеси или удали стикеры из колонки',
          'last-column': 'Последнюю колонку удалить нельзя',
        };
        toast(messages[result.reason] || 'Не получилось удалить колонку', null);
        closeConfirmPop();
        return;
      }
      closeConfirmPop();
      render();
    });
    pop.appendChild(removeBtn);

    dom.confirmPop.innerHTML = '';
    dom.confirmPop.appendChild(pop);
    dom.confirmPop.hidden = false;
    const rect = anchor.getBoundingClientRect();
    const popRect = dom.confirmPop.getBoundingClientRect();
    let left = rect.right - popRect.width;
    let top = rect.bottom + 8;
    if (left < 10) left = 10;
    if (top + popRect.height > window.innerHeight - 10) top = rect.top - popRect.height - 8;
    dom.confirmPop.style.left = `${left}px`;
    dom.confirmPop.style.top = `${top}px`;
  }

  function closeConfirmPop() {
    dom.confirmPop.hidden = true;
    dom.confirmPop.innerHTML = '';
  }

  document.addEventListener('pointerdown', (event) => {
    if (!dom.confirmPop.hidden && !dom.confirmPop.contains(event.target)) closeConfirmPop();
  });

  dom.addColumnBtn.addEventListener('click', () => {
    const snapshot = store.snapshot();
    const suggested = `Колонка ${snapshot.columns.length + 1}`;
    const result = store.addColumn(suggested);
    if (result.ok) {
      render();
      toast('Колонка добавлена — переименуй её двойным кликом по заголовку', null);
    }
  });

  // ---------------------------------------------------------------------
  // Тосты
  // ---------------------------------------------------------------------

  function toast(message, action) {
    notifySmoke(`toast: ${message}`);
    const node = element('div', 'toast');
    node.appendChild(element('span', '', message));
    if (action) {
      const button = element('button', 'toast-action', action.label);
      button.addEventListener('click', () => {
        action.action();
        dismiss();
      });
      node.appendChild(button);
    }
    dom.toasts.appendChild(node);
    const timer = setTimeout(dismiss, action ? 6000 : 3800);
    function dismiss() {
      clearTimeout(timer);
      if (!node.parentNode) return;
      node.classList.add('leaving');
      setTimeout(() => node.remove(), 200);
    }
    return dismiss;
  }

  // ---------------------------------------------------------------------
  // Поиск
  // ---------------------------------------------------------------------

  dom.searchInput.addEventListener('input', () => {
    const value = dom.searchInput.value;
    dom.searchBox.classList.toggle('has-query', value.length > 0);
    store.setQuery(value);
  });

  dom.searchClear.addEventListener('click', () => {
    dom.searchInput.value = '';
    dom.searchBox.classList.remove('has-query');
    store.setQuery('');
    dom.searchInput.focus();
  });

  // ---------------------------------------------------------------------
  // Подпись о сохранении
  // ---------------------------------------------------------------------

  function refreshSaveStatus() {
    const status = dom.saveStatus;
    const error = store.lastSaveError();
    if (error) {
      status.textContent = 'ошибка сохранения';
      status.className = 'brand-sub error';
      return;
    }
    if (store.hasPendingSave()) {
      status.textContent = 'сохраняю…';
      status.className = 'brand-sub saving';
      return;
    }
    const savedAt = store.lastSavedAt();
    if (!savedAt) {
      status.textContent = 'доска в работе';
      status.className = 'brand-sub';
      return;
    }
    const time = new Date(savedAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    status.textContent = `сохранено в ${time}`;
    status.className = 'brand-sub saved';
  }

  store.subscribe((event) => {
    if (event.type === 'change') render();
    if (event.type === 'saved' || event.type === 'save-error') refreshSaveStatus();
  });

  setInterval(refreshSaveStatus, 1500);

  // ---------------------------------------------------------------------
  // Горячие клавиши
  // ---------------------------------------------------------------------

  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !editorNode) closeConfirmPop();
    const mod = event.ctrlKey || event.metaKey;
    if (mod && event.key.toLowerCase() === 'f') {
      event.preventDefault();
      dom.searchInput.focus();
      dom.searchInput.select();
    }
    if (mod && event.key.toLowerCase() === 'n' && !editorNode) {
      event.preventDefault();
      const snapshot = store.snapshot();
      const pool = snapshot.columns.find((column) => column.role === 'pool') || snapshot.columns[0];
      quickAdd(pool.id);
    }
  });

  // ---------------------------------------------------------------------
  // Быстрая задача сверху
  // ---------------------------------------------------------------------

  dom.addTaskBtn.addEventListener('click', () => {
    const snapshot = store.snapshot();
    const pool = snapshot.columns.find((column) => column.role === 'pool') || snapshot.columns[0];
    quickAdd(pool.id);
  });

  // ---------------------------------------------------------------------
  // Старт и смоук-тест
  // ---------------------------------------------------------------------

  function startup() {
    render();
    refreshSaveStatus();
  }

  if (SMOKE) {
    runSmokeTest();
  } else {
    startup();
    // Для превью редактора: открываем стикер автоматически.
    if (SHOT && query.has('editor')) {
      setTimeout(() => openEditor('seed-3'), 250);
    }
  }
  // ---------------------------------------------------------------------
  // Сценарий смоук-теста: гоняет реальные действия и рапортует в stdout.
  // ---------------------------------------------------------------------

  function dispatchPointer(type, target, clientX, clientY, pointerId) {
    const event = new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      composed: true,
      pointerId,
      pointerType: 'mouse',
      isPrimary: true,
      button: 0,
      buttons: type === 'pointerup' ? 0 : 1,
      clientX,
      clientY,
    });
    target.dispatchEvent(event);
  }

  function runSmokeTest() {
    const results = [];
    const check = (name, condition, extra) => {
      results.push({ name, ok: Boolean(condition), extra: extra || '' });
    };

    try {
      startup();
      check('seed: пять колонок', store.snapshot().columns.length === 5, String(store.snapshot().columns.length));
      check('seed: шесть стикеров', store.snapshot().tasks.filter((task) => !task.deletedAt).length === 6);

      // Создание задачи
      const created = store.createTask({ columnId: 'pool', title: 'Смоук-стикер', color: 'blue' });
      check('create: ok', created.ok);
      render();

      // Перемещение
      const moved = store.moveTask(created.task.id, 'in-progress', {});
      check('move: ok', moved.ok, JSON.stringify(moved));
      render();

      // WIP-лимит: в работе сейчас 1 из 3. Добьём до трёх и проверим, что четвёртая не входит.
      store.createTask({ columnId: 'in-progress', title: 'Смоук в работе 2' });
      store.createTask({ columnId: 'in-progress', title: 'Смоук в работе 3' });
      const blocked = store.createTask({ columnId: 'in-progress', title: 'Смоук сверх лимита' });
      check('wip: создание отклонено', blocked.ok === false && blocked.reason === 'wip');
      const taskFromPool = store.getTask('seed-1');
      const blockedMove = store.moveTask(taskFromPool.id, 'in-progress', {});
      check('wip: перемещение отклонено', blockedMove.ok === false && blockedMove.reason === 'wip');

      // Правка
      const edited = store.updateTask(created.task.id, { title: 'Смоук-стикер (правленый)', note: 'заметка' });
      check('update: ok', edited.ok && edited.task.title.includes('правленый'));

      // Поиск
      store.setQuery('правленый');
      const viewFiltered = store.view();
      const visibleTotal = viewFiltered.columns.reduce((sum, column) => sum + column.visibleCount, 0);
      check('search: найден один', visibleTotal === 1, String(visibleTotal));
      store.setQuery('');

      // Удаление и возврат
      const deleted = store.deleteTask(created.task.id);
      check('delete: ok', deleted.ok);
      const restored = store.restoreTask(created.task.id);
      check('restore: ok', restored.ok);

      // Автосохранение: ждём flush и сверяем с загруженным.
      store.flush();
      const raw = window.kanbanAPI ? window.kanbanAPI.loadBoard() : null;
      if (raw) {
        check('persist: доска записана', Array.isArray(raw.board.tasks) && raw.board.tasks.length > 0);
        check('persist: сохранились 3 задачи в работе',
          raw.board.tasks.filter((task) => task.columnId === 'in-progress' && !task.deletedAt).length === 3,
          String(raw.board.tasks.filter((task) => task.columnId === 'in-progress' && !task.deletedAt).length));
      } else {
        check('persist: доска записана', false, 'нет kanbanAPI');
      }

      // Колонки: добавление и удаление
      const added = store.addColumn('Проверка');
      check('column: добавлена', added.ok, JSON.stringify(added));
      const removed = store.removeColumn(added.column.id);
      check('column: удалена', removed.ok);

      // Защита от удаления непустой колонки
      const noRemove = store.removeColumn('in-progress');
      check('column: непустая не удаляется', noRemove.ok === false && noRemove.reason === 'not-empty');

      // Живое перетаскивание: симулируем указатель и тащим стикер из пула в «Завершено».
      const dragCreated = store.createTask({ columnId: 'pool', title: 'Перетаскиваемый', color: 'peach' });
      check('drag: стикер создан', dragCreated.ok);
      render();

      const stickerNode = dom.board.querySelector(
        `[data-column-id="pool"] [data-task-id="${dragCreated.task.id}"]`
      );
      check('drag: узел стикера найден', Boolean(stickerNode));
      if (stickerNode) {
        const sourceRect = stickerNode.getBoundingClientRect();
        const startX = sourceRect.left + sourceRect.width / 2;
        const startY = sourceRect.top + Math.min(sourceRect.height / 2, 30);
        dispatchPointer('pointerdown', stickerNode, startX, startY, 77);

        const doneList = dom.board.querySelector('[data-column-id="done"] [data-role="list"]');
        const targetRect = doneList.getBoundingClientRect();
        const targetX = targetRect.left + targetRect.width / 2;
        const targetY = targetRect.top + 24;

        dispatchPointer('pointermove', window, targetX - 8, targetY - 4, 77);
        dispatchPointer('pointermove', window, targetX, targetY, 77);

        check('drag: призрак появился', Boolean(document.querySelector('.drag-ghost')));
        check('drag: колонка подсвечена', Boolean(document.querySelector('.column.drop-target')));
        check('drag: место вставки показано', Boolean(document.querySelector('.drop-slot')));

        dispatchPointer('pointerup', window, targetX, targetY, 77);
        const afterDrag = store.getTask(dragCreated.task.id);
        check('drag: стикер переехал в «Завершено»', afterDrag && afterDrag.columnId === 'done',
          afterDrag ? afterDrag.columnId : 'нет задачи');
        check('drag: призрак убран', !document.querySelector('.drag-ghost'));
        check('drag: подсветка снята', !document.querySelector('.column.drop-target'));
      }

      // Перетаскивание в колонку со свободным лимитом... а теперь проверим,
      // что перетаскивание в переполненную колонку отклоняется с тостом.
      const blockedDrag = store.createTask({ columnId: 'pool', title: 'Упрётся в лимит' });
      render();
      const blockedNode = dom.board.querySelector(
        `[data-column-id="pool"] [data-task-id="${blockedDrag.task.id}"]`
      );
      if (blockedNode) {
        const blockedRect = blockedNode.getBoundingClientRect();
        dispatchPointer('pointerdown', blockedNode, blockedRect.left + 40, blockedRect.top + 20, 78);
        const busyList = dom.board.querySelector('[data-column-id="in-progress"] [data-role="list"]');
        const busyRect = busyList.getBoundingClientRect();
        dispatchPointer('pointermove', window, busyRect.left + busyRect.width / 2, busyRect.top + 20, 78);
        dispatchPointer('pointerup', window, busyRect.left + busyRect.width / 2, busyRect.top + 20, 78);
        const stillPool = store.getTask(blockedDrag.task.id);
        check('drag: переполненная колонка не приняла стикер', stillPool && stillPool.columnId === 'pool',
          stillPool ? stillPool.columnId : 'нет задачи');
      }

      render();
    } catch (error) {
      check('exception', false, error.stack || error.message);
    }

    const failed = results.filter((entry) => !entry.ok);
    for (const entry of results) {
      notifySmoke(`${entry.ok ? 'ok ' : 'FAIL'} ${entry.name}${entry.extra ? ` [${entry.extra}]` : ''}`);
    }
    notifySmoke(`SMOKE ${failed.length === 0 ? 'PASS' : `FAIL ${failed.length}/${results.length}`}`);
    if (window.kanbanAPI && typeof window.kanbanAPI.smokeDone === 'function') {
      window.kanbanAPI.smokeDone(failed.length === 0);
    }
  }
})();

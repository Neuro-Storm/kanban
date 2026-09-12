/*
 * Интерфейс канбан-доски — свободный лист.
 *
 * Стикеры лежат на .board абсолютно (board-relative координаты x/y из ядра)
 * и таскаются вживую: движется сам стикер, без призрака и слота.
 * Колонки — фоновые дорожки: принадлежность для WIP/счётчиков определяется
 * по центру стикера при отпускании, визуально стикер остаётся там, где его
 * бросили (хоть на границе дорожек). Магнит сильный и ощутимый:
 * к центру дорожки тянет в радиусе ~48px (стикер встаёт ровно по центру),
 * к краям/граням дорожек и соседним стикерам — в радиусе ~12-16px,
 * плюс сетка 8px.
 * Создание — кликом по пустому месту (как лист OneNote): кликнул и печатаешь.
 * Рендер инкрементальный: существующие узлы обновляются на месте, новые
 * анимируются один раз — доска не мигает при перемещении/добавлении.
 * Доменные правила — в ../core/store.js.
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
    boardWrap: document.querySelector('.board-wrap'),
    addColumnBtn: document.getElementById('addColumnBtn'),
    bulkDeleteBtn: document.getElementById('bulkDeleteBtn'),
    themeSelect: document.getElementById('themeSelect'),
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

  const STICKER_WIDTH = 200;
  const STICKER_GAP = 12;
  const GRID = 8; // магнитная сетка
  const GRID_TOL = 5; // …тянет заметно, если промах в пределах 5px
  const SNAP_PX = 12; // магнит к граням дорожек и соседним стикерам
  const SNAP_EDGE_PX = 16; // магнит к левому/правому краю контента дорожки
  const SNAP_CENTER_PX = 48; // магнит к центру дорожки — сильный, ощутимый
  const CLICK_TOL = 6; // клик vs протяжка для создания

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

  function clampBoard(x, y) {
    return { x: Math.max(0, Math.round(x)), y: Math.max(0, Math.round(y)) };
  }

  // Чтение рич-текста из contenteditable: innerHTML + чистка в ядре.
  // (Старый textContent-путь склеивал строки, т.к. Enter создаёт <div>.)
  function readRichText(el) {
    if (!el) return '';
    return Core.sanitizeRich(el.innerHTML || '');
  }

  // Ощутимый магнит: сетка 8px + края/центр дорожек + края соседних стикеров.
  // Границы НЕ запрещают стоянку — притянувшаяся к границе точка остаётся
  // на границе, просто ровно по линии.
  function magnet(value) {
    const snapped = Math.round(value / GRID) * GRID;
    return Math.abs(snapped - value) <= GRID_TOL ? snapped : Math.round(value);
  }

  // Полный магнит для свободной точки (левый верхний угол стикера).
  // Приоритет: 1) центр дорожки (главное — встать ровно по середине),
  // 2) края соседей и грани дорожек, 3) слабая сетка. Сетка раньше перебивала
  // прилипание к центру, поэтому магнит «не работал».
  // Возвращает и флаг centerSnapped — для видимой подсветки прилипания.
  function applyMagnet(nx, ny, nodeW, nodeH, movingId) {
    let bestX = Math.round(nx);
    let bestDx = Infinity;
    let bestY = Math.round(ny);
    let bestDy = Infinity;
    let centerSnapped = false;

    const lanes = drag.lanes && drag.lanes.length ? drag.lanes : measureLanes();
    for (const lane of lanes) {
      const centerX = (lane.left + lane.right) / 2 - nodeW / 2; // ровно по центру
      const dxCenter = Math.abs(centerX - nx);
      if (dxCenter < bestDx && dxCenter <= SNAP_CENTER_PX) {
        bestDx = dxCenter;
        bestX = Math.round(centerX);
        centerSnapped = true;
      }
    }

    if (!centerSnapped) {
      for (const lane of lanes) {
        const candidatesX = [
          [lane.left + 8, SNAP_EDGE_PX], // левый край контента дорожки
          [lane.right - nodeW - 8, SNAP_EDGE_PX], // правый край контента дорожки
          [lane.left - nodeW / 2, SNAP_PX], // граница слева — встать ровно на межу
          [lane.right - nodeW / 2, SNAP_PX], // граница справа — встать ровно на межу
        ];
        for (const [cx, tol] of candidatesX) {
          const dx = Math.abs(cx - nx);
          if (dx < bestDx && dx <= tol) {
            bestDx = dx;
            bestX = Math.round(cx);
          }
        }
      }

      for (const node of dom.board.querySelectorAll(':scope > .sticker:not(.is-draft)')) {
        if (movingId && node.dataset.taskId === movingId) continue;
        const left = Number.parseFloat(node.style.left || '0') || 0;
        const top = Number.parseFloat(node.style.top || '0') || 0;
        const width = node.offsetWidth || STICKER_WIDTH;
        const height = node.offsetHeight || 110;
        const candidatesX = [
          left, // левые края вровень
          left + width - nodeW, // правые края вровень
          left + width + STICKER_GAP, // рядом справа
          left - nodeW - STICKER_GAP, // рядом слева
        ];
        for (const cx of candidatesX) {
          const dx = Math.abs(cx - nx);
          if (dx < bestDx && dx <= SNAP_PX) {
            bestDx = dx;
            bestX = Math.round(cx);
          }
        }
        const candidatesY = [
          top, // верхние края вровень
          top + height - nodeH, // нижние края вровень
          top + height + STICKER_GAP, // рядом снизу
          top - nodeH - STICKER_GAP, // рядом сверху
        ];
        for (const cy of candidatesY) {
          const dy = Math.abs(cy - ny);
          if (dy < bestDy && dy <= SNAP_PX) {
            bestDy = dy;
            bestY = Math.round(cy);
          }
        }
      }
    } else {
      // Центр уже держит X — по Y всё равно тянемся к соседям.
      for (const node of dom.board.querySelectorAll(':scope > .sticker:not(.is-draft)')) {
        if (movingId && node.dataset.taskId === movingId) continue;
        const top = Number.parseFloat(node.style.top || '0') || 0;
        const height = node.offsetHeight || 110;
        const candidatesY = [top, top + height - nodeH, top + height + STICKER_GAP, top - nodeH - STICKER_GAP];
        for (const cy of candidatesY) {
          const dy = Math.abs(cy - ny);
          if (dy < bestDy && dy <= SNAP_PX) {
            bestDy = dy;
            bestY = Math.round(cy);
          }
        }
      }
    }

    // Рядом ничего нет — слабая сетка.
    if (bestDx === Infinity) bestX = magnet(nx);
    if (bestDy === Infinity) bestY = magnet(ny);

    if (bestX < 0) bestX = 0;
    if (bestY < 0) bestY = 0;
    return { x: bestX, y: bestY, centerSnapped };
  }

  // Пересечение прямоугольников (строгое: касание краями — не наложение).
  function rectsOverlap(a, b) {
    return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
  }

  // Расталкивание: кого и на какой верх сдвинуть вниз, чтобы брошенная
  // группа стикеров никого не перекрывала. Каскадное — сдвинутый толкает
  // следующего. Возвращает Map(taskId -> newTop).
  // Позиции читаются из DOM (базовые, без превью).
  function resolvePush(nx, ny, nodeW, nodeH, movingId) {
    return resolvePushMulti(
      [{ left: nx, top: ny, right: nx + nodeW, bottom: ny + nodeH }],
      movingId ? [movingId] : []
    );
  }

  function resolvePushMulti(footprints, movingIds) {
    const moving = new Set(movingIds || []);
    const others = [];
    for (const node of dom.board.querySelectorAll(':scope > .sticker:not(.is-draft)')) {
      if (moving.has(node.dataset.taskId)) continue;
      const left = Number.parseFloat(node.style.left || '0') || 0;
      const top = Number.parseFloat(node.style.top || '0') || 0;
      others.push({
        id: node.dataset.taskId,
        left,
        top,
        width: node.offsetWidth || STICKER_WIDTH,
        height: node.offsetHeight || 110,
      });
    }
    others.sort((a, b) => a.top - b.top || a.left - b.left);
    const placed = footprints.map((rect) => ({
      left: rect.left,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
    }));
    const result = new Map();
    for (const other of others) {
      let top = other.top;
      let rect = { left: other.left, top, right: other.left + other.width, bottom: top + other.height };
      let guard = 0;
      let overlapped = placed.filter((p) => rectsOverlap(rect, p));
      while (overlapped.length && guard < others.length + 2) {
        top = Math.max(...overlapped.map((p) => p.bottom)) + STICKER_GAP;
        rect = { left: other.left, top, right: other.left + other.width, bottom: top + other.height };
        overlapped = placed.filter((p) => rectsOverlap(rect, p));
        guard += 1;
      }
      if (top !== other.top) result.set(other.id, Math.round(top));
      placed.push(rect);
    }
    return result;
  }

  function clearPushPreview() {
    for (const node of dom.board.querySelectorAll(':scope > .sticker')) {
      if (node.style.transform) node.style.transform = '';
    }
    if (drag.node) drag.node.classList.remove('magnet-on');
    drag.pushed = null;
  }

  // Board-relative координаты точки клиента.
  function boardCoords(clientX, clientY) {
    const rect = dom.board.getBoundingClientRect();
    return { x: clientX - rect.left, y: clientY - rect.top };
  }

  // Дорожки, измеренные относительно .board (устойчиво к скроллу обёртки).
  function measureLanes() {
    const boardRect = dom.board.getBoundingClientRect();
    const lanes = [];
    for (const node of dom.board.querySelectorAll(':scope > .column')) {
      const rect = node.getBoundingClientRect();
      lanes.push({
        id: node.dataset.columnId,
        node,
        left: rect.left - boardRect.left,
        right: rect.right - boardRect.left,
        top: rect.top - boardRect.top,
      });
    }
    return lanes;
  }

  function laneListTop(columnId) {
    const columnNode = dom.board.querySelector(`:scope > .column[data-column-id="${columnId}"]`);
    if (!columnNode) return null;
    const boardRect = dom.board.getBoundingClientRect();
    const list = columnNode.querySelector('[data-role="list"]');
    const rect = (list || columnNode).getBoundingClientRect();
    return {
      x: rect.left - boardRect.left + 8,
      y: rect.top - boardRect.top + 8,
      list,
    };
  }

  // Владелец по центру стикера. В зазоре — ближайшая дорожка.
  function columnIdAtBoardX(centerX, lanes) {
    const list = lanes || measureLanes();
    if (!list.length) return null;
    for (const lane of list) {
      if (centerX >= lane.left - 7 && centerX < lane.right + 7) return lane.id;
    }
    let best = list[0].id;
    let bestDist = Infinity;
    for (const lane of list) {
      const center = (lane.left + lane.right) / 2;
      const dist = Math.abs(centerX - center);
      if (dist < bestDist) {
        bestDist = dist;
        best = lane.id;
      }
    }
    return best;
  }

  // Доска растёт вглубь: абсолютные стикеры не растягивают родителя сами,
  // поэтому высота .board подбирается под самый нижний стикер — колонки
  // (stretch) удлиняются до любой глубины по мере добавления.
  function fitBoardToContent() {
    let maxBottom = 0;
    for (const node of dom.board.querySelectorAll(':scope > .sticker:not(.is-draft)')) {
      const top = Number.parseFloat(node.style.top || '0') || 0;
      const height = node.offsetHeight || 110;
      maxBottom = Math.max(maxBottom, top + height);
    }
    if (draftNode) {
      const top = Number.parseFloat(draftNode.style.top || '0') || 0;
      maxBottom = Math.max(maxBottom, top + (draftNode.offsetHeight || 110));
    }
    const scroller = dom.boardWrap;
    const floor = scroller ? Math.max(0, scroller.clientHeight - 24) : 0;
    const target = Math.max(floor, Math.ceil(maxBottom) + 32);
    if (Math.abs((fitBoardToContent._last || 0) - target) >= 2) {
      fitBoardToContent._last = target;
      dom.board.style.minHeight = `${target}px`;
    }
  }

  // Свободное место в дорожке: под самым нижним стикером колонки.
  function freeSpotInColumn(columnId) {
    const origin = laneListTop(columnId);
    const fallback = { x: 20, y: 20 };
    if (!origin) return fallback;
    let maxBottom = origin.y;
    for (const node of dom.board.querySelectorAll(':scope > .sticker:not(.is-draft)')) {
      if (node.dataset.columnId !== columnId) continue;
      const top = Number.parseFloat(node.style.top || '0') || 0;
      const height = node.offsetHeight || 110;
      maxBottom = Math.max(maxBottom, top + height + STICKER_GAP);
    }
    // Учитываем и stored-позиции задач без узлов (например, после фильтра).
    try {
      const snapshot = store.snapshot();
      for (const task of snapshot.tasks) {
        if (task.deletedAt !== null || task.columnId !== columnId) continue;
        if (Number.isFinite(task.y)) maxBottom = Math.max(maxBottom, task.y + 122);
      }
    } catch (error) {
      /* снимок недоступен — используем DOM */
    }
    return { x: Math.max(0, Math.round(origin.x)), y: Math.max(0, Math.round(maxBottom)) };
  }

  // ---------------------------------------------------------------------
  // Рендер доски (инкрементальный, без мигания)
  // ---------------------------------------------------------------------

  let lastRendered = null;
  let landedTaskId = null;

  function render() {
    applyTheme();
    const view = store.view();
    const todayStr = Core.todayString(Date.now);
    const scroller = dom.boardWrap || document.documentElement;
    const scrollLeft = scroller.scrollLeft;
    const scrollTop = scroller.scrollTop;

    // 1. Дорожки: переиспользуем узлы, обновляем только заголовки и хинты.
    const existingColumns = new Map();
    for (const node of dom.board.querySelectorAll(':scope > .column')) {
      if (node.dataset.columnId) existingColumns.set(node.dataset.columnId, node);
    }
    for (const viewColumn of view.columns) {
      let columnNode = existingColumns.get(viewColumn.id);
      if (!columnNode) {
        columnNode = buildColumnNode(viewColumn);
        dom.board.insertBefore(columnNode, dom.addColumnBtn);
      } else {
        existingColumns.delete(viewColumn.id);
        updateColumnHeader(columnNode, viewColumn);
      }
      updateLaneHint(columnNode, viewColumn);
    }
    for (const stale of existingColumns.values()) stale.remove();
    // Порядок дорожек — по view, но двигаем только при расхождении.
    const orderedIds = view.columns.map((column) => column.id);
    const currentLaneOrder = [...dom.board.querySelectorAll(':scope > .column')].map(
      (node) => node.dataset.columnId
    );
    if (orderedIds.join('|') !== currentLaneOrder.join('|')) {
      for (const id of orderedIds) {
        const node = dom.board.querySelector(`:scope > .column[data-column-id="${id}"]`);
        if (node) dom.board.insertBefore(node, dom.addColumnBtn);
      }
    }

    // 2. Стикеры: плоский список видимых, узлы обновляются на месте.
    const visibleById = new Map();
    for (const viewColumn of view.columns) {
      for (const task of viewColumn.tasks) visibleById.set(task.id, { task, column: viewColumn });
    }
    const existingStickers = new Map();
    for (const node of dom.board.querySelectorAll(':scope > .sticker:not(.is-draft)')) {
      if (node.dataset.taskId) existingStickers.set(node.dataset.taskId, node);
      // Сброс живого предпросмотра сдвига: позиции берутся из store.
      if (node.style.transform) node.style.transform = '';
      node.classList.remove('magnet-on');
    }

    const toLayout = []; // задачи без x/y — разложить стопкой
    for (const [id, entry] of visibleById) {
      let node = existingStickers.get(id);
      const isNew = !node;
      if (!node) node = buildStickerNode(entry.task);
      else existingStickers.delete(id);
      // Стикер в инлайн-правке: текст пользователя не затираем перерендером.
      if (inlineEdit.node && id === inlineEdit.taskId) {
        node.dataset.columnId = entry.task.columnId;
        node.dataset.color = entry.task.color || 'yellow';
        if (isNew) dom.board.insertBefore(node, dom.addColumnBtn);
      } else {
        updateStickerNode(node, entry.task, todayStr, entry.column);
      }
      node.dataset.columnId = entry.task.columnId;
      node.classList.toggle('selected', selectedIds.has(id));
      if (isNew) {
        node.classList.remove('no-anim');
        dom.board.insertBefore(node, dom.addColumnBtn);
      } else if (id !== drag.taskId) {
        node.classList.add('no-anim');
      }
      if (Number.isFinite(entry.task.x) && Number.isFinite(entry.task.y)) {
        if (id !== drag.taskId || !drag.active) {
          node.style.left = `${entry.task.x}px`;
          node.style.top = `${entry.task.y}px`;
        }
      } else {
        toLayout.push({ id, task: entry.task, node });
      }
    }
    for (const stale of existingStickers.values()) {
      if (stale.dataset.taskId !== drag.taskId) stale.remove();
    }

    // 3. Автораскладка стопкой для задач без координат (наследие).
    if (toLayout.length) {
      const boardRect = dom.board.getBoundingClientRect();
      const cursors = new Map();
      for (const item of toLayout) {
        const columnNode = dom.board.querySelector(
          `:scope > .column[data-column-id="${item.task.columnId}"]`
        );
        const anchor = columnNode
          ? columnNode.querySelector('[data-role="list"]') || columnNode
          : dom.board;
        const anchorRect = anchor.getBoundingClientRect();
        const baseX = anchorRect.left - boardRect.left + 8;
        const baseY = anchorRect.top - boardRect.top + 8;
        const cursor = cursors.get(item.task.columnId) || baseY;
        item.node.style.left = `${Math.max(0, Math.round(baseX))}px`;
        item.node.style.top = `${Math.max(0, Math.round(cursor))}px`;
        const height = item.node.offsetHeight || 110;
        cursors.set(item.task.columnId, cursor + height + STICKER_GAP);
      }
    }

    if (landedTaskId) {
      const landed = dom.board.querySelector(
        `:scope > .sticker[data-task-id="${landedTaskId}"]`
      );
      if (landed) {
        landed.classList.add('landed');
        setTimeout(() => landed.classList.remove('landed'), 320);
      }
      landedTaskId = null;
    }

    if (loadReport.seeded && !loadReport.reported && !SHOT) {
      loadReport.reported = true;
      toast('Первая доска готова — стикеры уже разложены. Кликни по пустому месту и печатай.', null);
    }
    if ((loadReport.seeded || loadReport.repaired) && window.kanbanAPI) {
      store.flush();
    }
    lastRendered = view;
    refreshSaveStatus();
    fitBoardToContent();
    updateBulkBar();
    if (scroller.scrollLeft !== scrollLeft) scroller.scrollLeft = scrollLeft;
    if (scroller.scrollTop !== scrollTop) scroller.scrollTop = scrollTop;
  }

  function buildColumnNode(viewColumn) {
    const node = dom.tplColumn.content.firstElementChild.cloneNode(true);
    node.dataset.columnId = viewColumn.id;
    node.dataset.role = viewColumn.role || 'custom';
    updateColumnHeader(node, viewColumn);
    updateLaneHint(node, viewColumn);
    return node;
  }

  function updateColumnHeader(node, viewColumn) {
    const titleNode = node.querySelector('[data-role="title"]');
    if (titleNode.textContent !== viewColumn.title) titleNode.textContent = viewColumn.title;
    const countNode = node.querySelector('[data-role="count"]');
    const countText = viewColumn.wipLimit ? `${viewColumn.count}/${viewColumn.wipLimit}` : String(viewColumn.count);
    if (countNode.textContent !== countText) countNode.textContent = countText;
    node.classList.toggle('at-limit', viewColumn.atLimit && !viewColumn.overLimit);
    node.classList.toggle('over-limit', viewColumn.overLimit);
  }

  function updateLaneHint(columnNode, viewColumn) {
    const list = columnNode.querySelector('[data-role="list"]');
    if (!list) return;
    const empty = viewColumn.tasks.length === 0;
    let hint = list.querySelector(':scope > .empty-hint');
    if (!empty) {
      if (hint) hint.remove();
      return;
    }
    const searching = Boolean(lastRendered && lastRendered.query) || Boolean(store.query);
    const text = searching ? 'Ничего не нашлось' : 'Пусто. Кликни сюда и печатай.';
    if (!hint) {
      hint = element('div', 'empty-hint', text);
      list.appendChild(hint);
    } else if (hint.textContent !== text) {
      hint.textContent = text;
    }
  }

  function buildStickerNode(task) {
    const node = dom.tplSticker.content.firstElementChild.cloneNode(true);
    node.dataset.taskId = task.id;
    return node;
  }

  // Единый текст стикера (в ядре поле text, без заголовка/заметки).
  // Для тостов показываем первую строку.
  function headLine(text) {
    return Core.firstLine(text) || 'Стикер';
  }

  function updateStickerNode(node, task, todayStr, viewColumn) {
    node.dataset.color = task.color || 'yellow';
    const textNode = node.querySelector('[data-role="text"]');
    const html = task.text || '';
    if (textNode.innerHTML !== html) textNode.innerHTML = html;

    const badges = node.querySelector('[data-role="badges"]');
    const wantPrio = Boolean(task.priority);
    const wantDone = viewColumn && viewColumn.role === 'done';
    const hasPrio = badges.querySelector('.prio') !== null;
    const hasDone = badges.querySelector('.done-chip') !== null;
    if (wantPrio !== hasPrio || wantDone !== hasDone) {
      badges.innerHTML = '';
      if (wantPrio) badges.appendChild(element('span', 'pill prio', '⚑ срочно'));
      if (wantDone) badges.appendChild(element('span', 'pill done-chip', '✓ готово'));
    }
    badges.hidden = badges.children.length === 0;

    const meta = node.querySelector('[data-role="meta"]');
    const label = tagLabel(task.tag);
    const due = formatDue(task.dueDate, todayStr);
    const metaKey = `${label || ''}|${due ? due.text : ''}|${viewColumn ? viewColumn.role : ''}`;
    if (node._metaKey !== metaKey) {
      meta.innerHTML = '';
      if (label) meta.appendChild(element('span', 'pill', label));
      if (due && (!viewColumn || viewColumn.role !== 'done')) {
        meta.appendChild(element('span', `pill ${due.className}`.trim(), due.text));
      }
      node._metaKey = metaKey;
    }
    meta.hidden = meta.children.length === 0;

    node.classList.toggle('is-priority', task.priority);
  }

  // ---------------------------------------------------------------------
  // Свободное перетаскивание живого стикера
  // ---------------------------------------------------------------------

  const drag = {
    active: false,
    taskId: null,
    node: null,
    pointerId: null,
    pointerType: 'mouse',
    startClientX: 0,
    startClientY: 0,
    grabDX: 0,
    grabDY: 0,
    origX: 0,
    origY: 0,
    origColumnId: null,
    lastX: 0,
    lastY: 0,
    lanes: [],
    targetColumnId: null,
    targetBlocked: false,
    pushed: null,
    group: null,
  };

  const bgClick = {
    pointerId: null,
    startClientX: 0,
    startClientY: 0,
    boardX: 0,
    boardY: 0,
  };

  // Выбранные стикеры для групповых операций (перенос/удаление).
  const selectedIds = new Set();

  // Рамка протяжного выделения.
  const marquee = {
    active: false,
    pointerId: null,
    startX: 0,
    startY: 0,
    node: null,
  };

  function syncSelectionUI() {
    for (const node of dom.board.querySelectorAll(':scope > .sticker')) {
      node.classList.toggle('selected', selectedIds.has(node.dataset.taskId));
    }
    updateBulkBar();
  }

  function updateBulkBar() {
    const count = selectedIds.size;
    dom.bulkDeleteBtn.hidden = count === 0;
    dom.bulkDeleteBtn.textContent = count > 0 ? `Удалить (${count})` : 'Удалить';
  }

  // Инлайн-правка текста прямо на стикере (без модалки).
  const inlineEdit = {
    taskId: null,
    node: null,
    textEl: null,
    originalText: '',
  };

  function dragTolerance(pointerType) {
    return pointerType === 'touch' ? 12 : 5;
  }

  function isInteractiveTarget(target) {
    return Boolean(
      target.closest(
        'button, input, textarea, select, .column-title, .sticker-actions, .editor, .confirm-pop, .toasts, .column-tools'
      )
    );
  }

  function onPointerDown(event) {
    if (event.button !== undefined && event.button !== 0) return;
    // Активная правка (черновик или инлайн): клик мимо — только сохранить,
    // новый стикер/новая правка не начинаются этим же кликом.
    if (draftNode && !(event.target.closest && event.target.closest('.sticker.is-draft'))) {
      commitDraft();
      bgClick.pointerId = null;
      return;
    }
    if (inlineEdit.node && !(event.target.closest && event.target.closest('.board > .sticker'))) {
      commitInlineEdit();
      bgClick.pointerId = null;
      return;
    }
    const sticker = event.target.closest ? event.target.closest('.board > .sticker:not(.is-draft)') : null;
    if (sticker) {
      if (event.target.closest('.sticker-actions') || event.target.closest('button')) return;
      // Shift+клик — toggle в выделении, без drag и правки.
      if (event.shiftKey) {
        const id = sticker.dataset.taskId;
        if (selectedIds.has(id)) selectedIds.delete(id);
        else selectedIds.add(id);
        syncSelectionUI();
        return;
      }
      // Стикер уже в инлайн-правке — жест отдают тексту (курсор/выделение), drag не начинаем.
      if (inlineEdit.node && inlineEdit.taskId === sticker.dataset.taskId) return;
      // Чужая инлайн-правка открыта — коммитим её, этим кликом новую не начинаем.
      if (inlineEdit.node) {
        commitInlineEdit();
        return;
      }
      drag.pointerId = event.pointerId;
      drag.taskId = sticker.dataset.taskId;
      drag.node = sticker;
      drag.pointerType = event.pointerType || 'mouse';
      drag.startClientX = event.clientX;
      drag.startClientY = event.clientY;
      const coords = boardCoords(event.clientX, event.clientY);
      drag.lastX = coords.x;
      drag.lastY = coords.y;
      const left = Number.parseFloat(sticker.style.left || '0') || 0;
      const top = Number.parseFloat(sticker.style.top || '0') || 0;
      drag.grabDX = coords.x - left;
      drag.grabDY = coords.y - top;
      try {
        sticker.setPointerCapture(event.pointerId);
      } catch (error) {
        /* синтетические события в тестах */
      }
      return;
    }
    // Фон доски — возможное OneNote-создание.
    const onBoard = event.target.closest
      ? event.target.closest('#board, .board-wrap')
      : null;
    if (onBoard && !isInteractiveTarget(event.target)) {
      bgClick.pointerId = event.pointerId;
      bgClick.startClientX = event.clientX;
      bgClick.startClientY = event.clientY;
      const coords = boardCoords(event.clientX, event.clientY);
      bgClick.boardX = coords.x;
      bgClick.boardY = coords.y;
    }
  }

  function beginDrag() {
    if (drag.active || !drag.node) return;
    closeDraft(true);
    commitInlineEdit();
    hideFormatPop();
    drag.active = true;
    drag.origX = Number.parseFloat(drag.node.style.left || '0') || 0;
    drag.origY = Number.parseFloat(drag.node.style.top || '0') || 0;
    drag.origColumnId = drag.node.dataset.columnId || null;
    drag.lanes = measureLanes();
    drag.targetColumnId = drag.origColumnId;
    drag.targetBlocked = false;
    // Группа: тянем всё выделение целиком, со сдвигом относительно ведущего.
    drag.group = null;
    if (selectedIds.size > 1 && selectedIds.has(drag.taskId)) {
      const members = [];
      for (const id of selectedIds) {
        const memberNode = dom.board.querySelector(`:scope > .sticker[data-task-id="${id}"]`);
        if (!memberNode || memberNode.classList.contains('is-draft')) continue;
        const left = Number.parseFloat(memberNode.style.left || '0') || 0;
        const top = Number.parseFloat(memberNode.style.top || '0') || 0;
        members.push({
          id,
          node: memberNode,
          dx: Math.round(left - drag.origX),
          dy: Math.round(top - drag.origY),
          ox: left,
          oy: top,
          w: memberNode.offsetWidth || STICKER_WIDTH,
          h: memberNode.offsetHeight || 110,
          x: left,
          y: top,
        });
      }
      if (members.length > 1) {
        drag.group = members;
        for (const member of members) {
          member.node.classList.add('dragging-live', 'no-anim');
          member.node.style.zIndex = '20';
          member.node.style.transition = 'none';
        }
      }
    }
    document.body.classList.add('dragging-active');
    drag.node.classList.add('dragging-live', 'no-anim');
    drag.node.style.zIndex = '20';
    drag.node.style.transition = 'none';
    highlightTarget(stickerCenterX(drag.lastX));
  }

  function stickerCenterX(boardX) {
    return boardX - drag.grabDX + STICKER_WIDTH / 2;
  }

  function highlightTarget(centerX) {
    const targetId = columnIdAtBoardX(centerX, drag.lanes.length ? drag.lanes : undefined);
    if (targetId && targetId !== drag.targetColumnId) {
      clearLaneHighlight();
      drag.targetColumnId = targetId;
    } else if (!targetId) {
      return;
    }
    // WIP-предпросмотр: красным — если чужая переполненная дорожка.
    let blocked = false;
    try {
      const snapshot = store.snapshot();
      const target = snapshot.columns.find((column) => column.id === drag.targetColumnId);
      const sourceId = drag.origColumnId;
      if (target && target.wipLimit !== null && target.id !== sourceId) {
        const count = snapshot.tasks.filter(
          (task) => task.columnId === target.id && task.deletedAt === null
        ).length;
        blocked = count >= target.wipLimit;
      }
    } catch (error) {
      blocked = false;
    }
    drag.targetBlocked = blocked;
    for (const lane of drag.lanes) {
      const isTarget = lane.id === drag.targetColumnId;
      lane.node.classList.toggle('drop-target', isTarget && !blocked);
      lane.node.classList.toggle('drop-blocked', isTarget && blocked);
    }
  }

  function clearLaneHighlight() {
    for (const lane of drag.lanes) {
      lane.node.classList.remove('drop-target', 'drop-blocked');
    }
    if (!drag.lanes.length) {
      for (const node of dom.board.querySelectorAll(':scope > .column')) {
        node.classList.remove('drop-target', 'drop-blocked');
      }
    }
  }

  function moveDrag(clientX, clientY) {
    const coords = boardCoords(clientX, clientY);
    drag.lastX = coords.x;
    drag.lastY = coords.y;
    const nodeW = (drag.node && drag.node.offsetWidth) || STICKER_WIDTH;
    const nodeH = (drag.node && drag.node.offsetHeight) || 110;
    const snapped = applyMagnet(coords.x - drag.grabDX, coords.y - drag.grabDY, nodeW, nodeH, drag.taskId);
    drag.node.style.left = `${snapped.x}px`;
    drag.node.style.top = `${snapped.y}px`;
    drag.node.classList.toggle('magnet-on', snapped.centerSnapped);
    // Группа едет жёстко за ведущим.
    const group = drag.group && drag.group.length > 1 ? drag.group : null;
    if (group) {
      for (const member of group) {
        if (member.id === drag.taskId) {
          member.x = snapped.x;
          member.y = snapped.y;
          continue;
        }
        member.x = Math.max(0, snapped.x + member.dx);
        member.y = Math.max(0, snapped.y + member.dy);
        member.node.style.left = `${member.x}px`;
        member.node.style.top = `${member.y}px`;
      }
    }
    // Живой предпросмотр расталкивания: задетые съезжают вниз.
    const footprints = group
      ? group.map((member) => ({
        left: member.x,
        top: member.y,
        right: member.x + member.w,
        bottom: member.y + member.h,
      }))
      : [{ left: snapped.x, top: snapped.y, right: snapped.x + nodeW, bottom: snapped.y + nodeH }];
    const movingIds = group ? group.map((member) => member.id) : [drag.taskId];
    const pushed = resolvePushMulti(footprints, movingIds);
    drag.pushed = pushed;
    const movingSet = new Set(movingIds);
    for (const node of dom.board.querySelectorAll(':scope > .sticker:not(.is-draft)')) {
      if (movingSet.has(node.dataset.taskId)) continue;
      const newTop = pushed.get(node.dataset.taskId);
      if (newTop === undefined) {
        if (node.style.transform) node.style.transform = '';
        continue;
      }
      const baseTop = Number.parseFloat(node.style.top || '0') || 0;
      node.style.transform = `translateY(${Math.round(newTop - baseTop)}px)`;
    }
    highlightTarget(snapped.x + nodeW / 2);
  }

  // Соседи по вертикали в целевой дорожке для логического порядка.
  function orderNeighbors(targetColumnId, dropCenterY, exclude) {
    const excluded = new Set(Array.isArray(exclude) ? exclude : [exclude]);
    const peers = [];
    for (const node of dom.board.querySelectorAll(':scope > .sticker:not(.is-draft)')) {
      if (excluded.has(node.dataset.taskId)) continue;
      if (node.dataset.columnId !== targetColumnId) continue;
      const top = Number.parseFloat(node.style.top || '0') || 0;
      const height = node.offsetHeight || 110;
      peers.push({ id: node.dataset.taskId, centerY: top + height / 2 });
    }
    // Задачи целевой дорожки без узлов (скрыты поиском): по stored y.
    try {
      const snapshot = store.snapshot();
      const known = new Set(peers.map((peer) => peer.id));
      for (const task of snapshot.tasks) {
        if (task.deletedAt !== null || task.columnId !== targetColumnId) continue;
        if (excluded.has(task.id) || known.has(task.id)) continue;
        if (Number.isFinite(task.y)) peers.push({ id: task.id, centerY: task.y + 55 });
      }
    } catch (error) {
      /* без снимка — только DOM */
    }
    peers.sort((a, b) => a.centerY - b.centerY);
    let before = null;
    let after = null;
    for (const peer of peers) {
      if (peer.centerY < dropCenterY) after = peer;
      else {
        before = peer;
        break;
      }
    }
    return { afterId: after ? after.id : null, beforeId: before ? before.id : null };
  }

  function dropDrag(clientX, clientY) {
    const coords = boardCoords(clientX, clientY);
    const nodeW = (drag.node && drag.node.offsetWidth) || STICKER_WIDTH;
    const nodeHeight = (drag.node && drag.node.offsetHeight) || 110;
    const snapped = applyMagnet(coords.x - drag.grabDX, coords.y - drag.grabDY, nodeW, nodeHeight, drag.taskId);
    const nx = snapped.x;
    const ny = snapped.y;
    const centerX = nx + nodeW / 2;
    const centerY = ny + nodeHeight / 2;
    const targetId = columnIdAtBoardX(centerX) || drag.origColumnId;
    const group = drag.group && drag.group.length > 1 ? drag.group : null;
    const groupIds = group ? group.map((member) => member.id) : [drag.taskId];
    // WIP с учётом всей группы: считаем входящих в целевую дорожку.
    const preSnapshot = store.snapshot();
    const preTarget = preSnapshot.columns.find((column) => column.id === targetId);
    let preEntering = 0;
    for (const gid of groupIds) {
      const current = preSnapshot.tasks.find((task) => task.id === gid);
      if (current && current.deletedAt === null && current.columnId !== targetId) preEntering += 1;
    }
    const preCount = preSnapshot.tasks.filter(
      (task) => task.columnId === targetId && task.deletedAt === null
    ).length;
    const preBlocked =
      Boolean(preTarget) &&
      preTarget.wipLimit !== null &&
      preEntering > 0 &&
      preCount + preEntering > preTarget.wipLimit;
    const spot = orderNeighbors(targetId, centerY, groupIds);
    // Расталкивание считаем до записи: кого сдвинуть вниз из-под броска.
    const footprints = group
      ? group.map((member) => ({
        left: member.id === drag.taskId ? nx : member.x,
        top: member.id === drag.taskId ? ny : member.y,
        right: (member.id === drag.taskId ? nx : member.x) + member.w,
        bottom: (member.id === drag.taskId ? ny : member.y) + member.h,
      }))
      : undefined;
    const pushed = group
      ? resolvePushMulti(footprints, groupIds)
      : resolvePush(nx, ny, nodeW, nodeHeight, drag.taskId);
    const finishNodes = group ? group.map((member) => member.node) : drag.node ? [drag.node] : [];
    const finishPos = new Map();
    if (group) {
      for (const member of group) {
        finishPos.set(member.id, member.id === drag.taskId ? { x: nx, y: ny } : { x: member.x, y: member.y });
      }
    }
    const returnAllToOrigin = () => {
      const origins = group || [{ node: drag.node, ox: drag.origX, oy: drag.origY }];
      for (const origin of origins) {
        const backNode = origin.node;
        if (!backNode) continue;
        backNode.classList.add('returning');
        backNode.style.left = `${origin.ox !== undefined ? origin.ox : drag.origX}px`;
        backNode.style.top = `${origin.oy !== undefined ? origin.oy : drag.origY}px`;
        setTimeout(() => backNode.classList.remove('returning'), 260);
      }
    };
    const movedId = drag.taskId;
    if (preBlocked) {
      toast(
        `«${preTarget ? preTarget.title : 'Колонка'}»: WIP-лимит ${preTarget.wipLimit} — группа не входит. Сначала заверши что-то из текущего.`,
        null
      );
      returnAllToOrigin();
      cancelDragVisual();
      drag.taskId = null;
      drag.node = null;
      drag.pointerId = null;
      return;
    }
    const result = store.setTaskPos(drag.taskId, targetId, nx, ny, spot);
    const wasBlocked = !result.ok && result.reason === 'wip';
    if (wasBlocked) {
      const snapshot = store.snapshot();
      const column = snapshot.columns.find((entry) => entry.id === result.columnId);
      toast(
        `«${column ? column.title : 'Колонка'}»: WIP-лимит ${result.limit}. Сначала заверши что-то из текущего.`,
        null
      );
      // Плавный возврат на исходную точку.
      returnAllToOrigin();
      cancelDragVisual();
      drag.taskId = null;
      drag.node = null;
      drag.pointerId = null;
      return;
    }
    // Ведомые группы едут в ту же дорожку без пересчёта порядка.
    if (group) {
      for (const member of group) {
        if (member.id === drag.taskId) continue;
        const pos = finishPos.get(member.id);
        store.relocateTask(member.id, targetId, pos.x, pos.y);
      }
    }
    landedTaskId = movedId;
    cancelDragVisual();
    drag.taskId = null;
    drag.node = null;
    drag.pointerId = null;
    // Подписка store уже вызвала render(); докрутим позиции и z-index.
    for (const finishedNode of finishNodes) {
      if (!finishedNode || !finishedNode.isConnected) continue;
      const pos = finishPos.size ? finishPos.get(finishedNode.dataset.taskId) : { x: nx, y: ny };
      if (!pos) continue;
      finishedNode.style.left = `${pos.x}px`;
      finishedNode.style.top = `${pos.y}px`;
      finishedNode.style.zIndex = '1';
    }
    // Коммитим сдвиг задетых вниз (колонка/порядок не меняются, только x/y).
    for (const [pushedId, newTop] of pushed) {
      const pushedNode = dom.board.querySelector(`:scope > .sticker[data-task-id="${pushedId}"]`);
      const baseLeft = pushedNode ? Number.parseFloat(pushedNode.style.left || '0') || 0 : null;
      if (pushedNode && Number.isFinite(baseLeft)) {
        store.setTaskXY(pushedId, Math.round(baseLeft), newTop);
      }
    }
  }

  function cancelDragVisual() {
    document.body.classList.remove('dragging-active');
    clearLaneHighlight();
    clearPushPreview();
    const liveNodes = drag.group && drag.group.length > 1
      ? drag.group.map((member) => member.node)
      : drag.node ? [drag.node] : [];
    for (const liveNode of liveNodes) {
      if (!liveNode) continue;
      liveNode.classList.remove('dragging-live');
      liveNode.style.zIndex = '1';
      liveNode.style.transition = '';
    }
    if (drag.node) {
      try {
        if (drag.pointerId !== null) drag.node.releasePointerCapture(drag.pointerId);
      } catch (error) {
        /* pointer уже отпущен */
      }
    }
    drag.active = false;
    drag.lanes = [];
    drag.targetColumnId = null;
    drag.targetBlocked = false;
    drag.group = null;
  }

  function onPointerMove(event) {
    if (drag.pointerId !== null && event.pointerId === drag.pointerId && drag.node) {
      if (!drag.active) {
        const dx = event.clientX - drag.startClientX;
        const dy = event.clientY - drag.startClientY;
        const tolerance = dragTolerance(drag.pointerType);
        if (dx * dx + dy * dy > tolerance * tolerance) beginDrag();
        else return;
      }
      event.preventDefault();
      moveDrag(event.clientX, event.clientY);
      return;
    }
    // Протяжка по пустому месту — рамка выделения.
    if (bgClick.pointerId !== null && event.pointerId === bgClick.pointerId) {
      const dx = event.clientX - bgClick.startClientX;
      const dy = event.clientY - bgClick.startClientY;
      if (!marquee.active) {
        if (dx * dx + dy * dy <= CLICK_TOL * CLICK_TOL) return;
        marquee.active = true;
        marquee.pointerId = event.pointerId;
        const start = boardCoords(bgClick.startClientX, bgClick.startClientY);
        marquee.startX = start.x;
        marquee.startY = start.y;
        marquee.rect = null;
        const node = element('div', 'marquee');
        node.hidden = true;
        dom.board.insertBefore(node, dom.addColumnBtn);
        marquee.node = node;
      }
      event.preventDefault();
      updateMarquee(event.clientX, event.clientY);
    }
  }

  function updateMarquee(clientX, clientY) {
    if (!marquee.active || !marquee.node) return;
    const coords = boardCoords(clientX, clientY);
    const left = Math.max(0, Math.min(marquee.startX, coords.x));
    const top = Math.max(0, Math.min(marquee.startY, coords.y));
    const right = Math.max(marquee.startX, coords.x);
    const bottom = Math.max(marquee.startY, coords.y);
    marquee.rect = { left, top, right, bottom };
    marquee.node.hidden = false;
    marquee.node.style.left = `${Math.round(left)}px`;
    marquee.node.style.top = `${Math.round(top)}px`;
    marquee.node.style.width = `${Math.max(0, Math.round(right - left))}px`;
    marquee.node.style.height = `${Math.max(0, Math.round(bottom - top))}px`;
  }

  function endMarquee(additive) {
    const rect = marquee.rect;
    if (marquee.node) marquee.node.remove();
    marquee.node = null;
    marquee.active = false;
    marquee.pointerId = null;
    marquee.rect = null;
    bgClick.pointerId = null;
    if (!rect || (rect.right - rect.left < 4 && rect.bottom - rect.top < 4)) return;
    const hit = [];
    for (const node of dom.board.querySelectorAll(':scope > .sticker:not(.is-draft)')) {
      const left = Number.parseFloat(node.style.left || '0') || 0;
      const top = Number.parseFloat(node.style.top || '0') || 0;
      const other = {
        left,
        top,
        right: left + (node.offsetWidth || STICKER_WIDTH),
        bottom: top + (node.offsetHeight || 110),
      };
      if (rectsOverlap(rect, other)) hit.push(node.dataset.taskId);
    }
    if (!additive) selectedIds.clear();
    for (const id of hit) selectedIds.add(id);
    syncSelectionUI();
  }

  function cancelMarquee() {
    if (marquee.node) marquee.node.remove();
    marquee.node = null;
    marquee.active = false;
    marquee.pointerId = null;
    marquee.rect = null;
  }

  function onPointerUp(event) {
    if (drag.pointerId !== null && event.pointerId === drag.pointerId) {
      if (drag.active) {
        dropDrag(event.clientX, event.clientY);
        bgClick.pointerId = null;
        return;
      }
      // Клик по стикеру без сдвига — править текст прямо на месте.
      const taskId = drag.taskId;
      const node = drag.node;
      drag.taskId = null;
      drag.node = null;
      drag.pointerId = null;
      if (node) {
        try {
          node.releasePointerCapture(event.pointerId);
        } catch (error) {
          /* уже отпущен */
        }
      }
      bgClick.pointerId = null;
      if (taskId) {
        // Клик по члену множественного выделения — свернуть до одного и править.
        if (selectedIds.size > 1 && selectedIds.has(taskId)) {
          selectedIds.clear();
          selectedIds.add(taskId);
          syncSelectionUI();
        }
        startInlineEdit(taskId);
      }
    }
    // Рамка выделения имеет приоритет над кликом-созданием.
    if (marquee.active && event.pointerId === marquee.pointerId) {
      endMarquee(Boolean(event.shiftKey));
      return;
    }
    // Клик по пустому месту — черновик OneNote.
    if (bgClick.pointerId !== null && event.pointerId === bgClick.pointerId) {
      const dx = event.clientX - bgClick.startClientX;
      const dy = event.clientY - bgClick.startClientY;
      const isClick = dx * dx + dy * dy <= CLICK_TOL * CLICK_TOL;
      // Цель берём по координатам: pointerup может прийти на window
      // (синтетика в тестах) — тогда смотрим, что под курсором.
      let upTarget = event.target && event.target.closest ? event.target : null;
      if (!upTarget && typeof document.elementFromPoint === 'function') {
        try {
          upTarget = document.elementFromPoint(event.clientX, event.clientY);
        } catch (error) {
          upTarget = null;
        }
      }
      const targetOk = Boolean(
        upTarget &&
          upTarget.closest &&
          upTarget.closest('#board, .board-wrap') &&
          !isInteractiveTarget(upTarget) &&
          !upTarget.closest('.board > .sticker')
      );
      bgClick.pointerId = null;
      if (isClick && targetOk && !editorNode) {
        // Новый контекст: старое выделение снимаем.
        if (selectedIds.size > 0) {
          selectedIds.clear();
          syncSelectionUI();
        }
        openDraft(bgClick.boardX, bgClick.boardY);
      }
    }
  }

  // Enter на сфокусированном стикере открывает полный редактор (метка, цвет, срок).
  // Одиночный клик мышью — правит текст на месте (startInlineEdit).
  // Дабл-клик модалку не открывает (отключено).
  dom.board.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && event.target.classList && event.target.classList.contains('sticker')) {
      openEditor(event.target.dataset.taskId);
    }
  });

  dom.board.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('pointermove', onPointerMove, { passive: false });
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', () => {
    if (drag.active && drag.node) {
      drag.node.style.left = `${drag.origX}px`;
      drag.node.style.top = `${drag.origY}px`;
    }
    cancelDragVisual();
    cancelMarquee();
    drag.taskId = null;
    drag.node = null;
    drag.pointerId = null;
    bgClick.pointerId = null;
  });

  // Колесо при зажатой средней кнопке — прокрутка доски (как в графических редакторах).
  dom.board.addEventListener('auxclick', (event) => event.preventDefault());
  window.addEventListener('mousedown', (event) => {
    if (event.button === 1) event.preventDefault();
  });

  // Окно потянули — пол пересчитываем, глубина под контент остаётся.
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      resizeTimer = null;
      fitBoardToContent._last = 0;
      fitBoardToContent();
    }, 150);
  });

  // ---------------------------------------------------------------------
  // OneNote-создание: клик по пустому — сразу печатаешь
  // ---------------------------------------------------------------------

  let draftNode = null;

  function closeDraft(removeOnly) {
    if (!draftNode) return;
    draftNode.remove();
    draftNode = null;
    hideFormatPop();
    void removeOnly;
  }

  function openDraft(boardX, boardY) {
    if (editorNode) return;
    if (draftNode) commitDraft();
    const pos = clampBoard(boardX - 20, boardY - 10);
    const node = element('article', 'sticker is-draft');
    node.style.left = `${pos.x}px`;
    node.style.top = `${pos.y}px`;
    // Черновик сразу в цвете будущего стикера — видно и в тёмных темах.
    node.dataset.color = pickColor();
    const title = element('div', 'draft-title');
    title.contentEditable = 'true';
    title.setAttribute('role', 'textbox');
    title.setAttribute('aria-label', 'Новый стикер — печатай');
    node.appendChild(title);
    node.appendChild(element('div', 'draft-hint', 'Ctrl+Enter — сохранить · Esc — отмена'));
    dom.board.appendChild(node);
    draftNode = node;
    title.focus();
    try {
      const range = document.createRange();
      range.selectNodeContents(title);
      range.collapse(false);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    } catch (error) {
      /* без выделения — просто фокус */
    }

    title.addEventListener('keydown', (event) => {
      // Enter — новая строка. Сохранение — Ctrl+Enter или клик мимо.
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        commitDraft();
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        closeDraft(true);
      }
    });
    title.addEventListener('blur', () => {
      // Небольшая задержка: клик по другому пустому месту должен успеть закоммитить.
      setTimeout(() => {
        if (draftNode === node) commitDraft();
      }, 120);
    });
  }

  function commitDraft() {
    if (!draftNode) return;
    const titleNode = draftNode.querySelector('.draft-title');
    const text = readRichText(titleNode);
    const left = Number.parseFloat(draftNode.style.left || '0') || 0;
    const top = Number.parseFloat(draftNode.style.top || '0') || 0;
    const node = draftNode;
    draftNode = null;
    node.remove();
    hideFormatPop();
    if (!Core.strippedText(text)) return;
    const lanes = measureLanes();
    const columnId = columnIdAtBoardX(left + STICKER_WIDTH / 2, lanes);
    const snapshot = store.snapshot();
    const target = snapshot.columns.find((column) => column.id === columnId) || snapshot.columns[0];
    if (!target) return;
    const result = store.createTask({
      columnId: target.id,
      text,
      color: COLORS.includes(node.dataset.color) ? node.dataset.color : pickColor(),
      x: Math.round(left),
      y: Math.round(top),
    });
    if (!result.ok) {
      if (result.reason === 'wip') {
        toast(`«${target.title}»: WIP-лимит ${target.wipLimit} — стикер не добавлен`, null);
      }
      return;
    }
    landedTaskId = result.task.id;
    // render() придёт по подписке; ничего лишнего не делаем — без мигания.
  }

  // ---------------------------------------------------------------------
  // Инлайн-правка: клик по стикеру — правишь текст на месте, без модалки.
  // Полный редактор (метка/цвет/срок) — по карандашу ✎ и Enter.
  // ---------------------------------------------------------------------

  function startInlineEdit(taskId) {
    if (editorNode) return;
    if (draftNode) commitDraft();
    if (inlineEdit.node && inlineEdit.taskId !== taskId) commitInlineEdit();
    const task = store.getTask(taskId);
    if (!task) return;
    const node = dom.board.querySelector(`:scope > .sticker[data-task-id="${taskId}"]`);
    if (!node) return;
    if (inlineEdit.node === node) return;
    cancelInlineEdit();

    const textEl = node.querySelector('[data-role="text"]');
    inlineEdit.taskId = taskId;
    inlineEdit.node = node;
    inlineEdit.textEl = textEl;
    inlineEdit.originalText = task.text;

    node.classList.add('editing-inline', 'no-anim');
    textEl.contentEditable = 'true';
    textEl.focus();
    try {
      const range = document.createRange();
      range.selectNodeContents(textEl);
      range.collapse(false);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    } catch (error) {
      /* без выделения — просто фокус */
    }

    textEl.addEventListener('keydown', onInlineTextKey);
    node.addEventListener('focusout', onInlineFocusOut);
  }

  function onInlineTextKey(event) {
    // Enter — новая строка (единый многострочный текст).
    // Ctrl+Enter — сохранить, Escape — отмена.
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      commitInlineEdit();
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      cancelInlineEdit();
    }
  }

  function onInlineFocusOut(event) {
    const node = inlineEdit.node;
    if (!node) return;
    setTimeout(() => {
      if (inlineEdit.node !== node) return;
      const active = document.activeElement;
      if (active && node.contains(active)) return;
      commitInlineEdit();
    }, 120);
  }

  function detachInlineListeners() {
    const { node, textEl } = inlineEdit;
    if (textEl) textEl.removeEventListener('keydown', onInlineTextKey);
    if (node) node.removeEventListener('focusout', onInlineFocusOut);
    hideFormatPop();
  }

  function commitInlineEdit() {
    if (!inlineEdit.node) return;
    const { taskId, node, textEl } = inlineEdit;
    const text = readRichText(textEl);
    detachInlineListeners();
    if (textEl) textEl.contentEditable = 'false';
    node.classList.remove('editing-inline');
    inlineEdit.taskId = null;
    inlineEdit.node = null;
    inlineEdit.textEl = null;
    if (!Core.strippedText(text)) {
      // Пустой текст недопустим — откатываем, стикер не трогаем.
      render();
      return;
    }
    const result = store.updateTask(taskId, { text });
    if (result && result.ok === false && result.reason === 'empty-text') {
      render();
      return;
    }
    // render() придёт по подписке store.
  }

  function cancelInlineEdit() {
    if (!inlineEdit.node) return;
    const { node, textEl } = inlineEdit;
    detachInlineListeners();
    if (textEl) textEl.contentEditable = 'false';
    node.classList.remove('editing-inline');
    inlineEdit.taskId = null;
    inlineEdit.node = null;
    inlineEdit.textEl = null;
    // Откат визуального текста — перерендером из store, без записи.
    render();
  }

  // ---------------------------------------------------------------------
  // Всплывающий тулбар форматирования: появляется над выделением текста
  // в любом редакторе (стикере, черновике, модалке) — как в мессенджерах.
  // ---------------------------------------------------------------------

  const FONT_SIZES = [13, 15, 17, 21, 25];
  let formatPop = null;

  // Активный редактируемый корень под курсором (или null).
  function activeEditableRoot() {
    const selection = window.getSelection();
    if (!selection || !selection.rangeCount) return null;
    let node = selection.anchorNode;
    while (node) {
      if (node.nodeType === 1 && node.contentEditable === 'true') return node;
      node = node.parentNode;
    }
    return null;
  }

  function ensureFormatPop() {
    if (formatPop) return formatPop;
    const pop = element('div', 'format-pop');
    pop.hidden = true;
    const buttons = [
      { format: 'bold', html: '<b>B</b>', title: 'Жирный' },
      { format: 'italic', html: '<i>I</i>', title: 'Курсив' },
      { format: 'strike', html: '<s>S</s>', title: 'Зачёркнутый' },
      { sep: true },
      { format: 'list', html: '☰', title: 'Список' },
      { sep: true },
      { format: 'smaller', html: 'A−', title: 'Шрифт меньше' },
      { format: 'bigger', html: 'A+', title: 'Шрифт больше' },
      { sep: true },
      { format: 'clear', html: '⊘', title: 'Убрать форматирование' },
    ];
    for (const entry of buttons) {
      if (entry.sep) {
        pop.appendChild(element('span', 'format-sep'));
        continue;
      }
      const button = element('button', 'format-btn');
      button.type = 'button';
      button.dataset.format = entry.format;
      button.title = entry.title;
      button.innerHTML = entry.html;
      // mousedown гасим, чтобы не терять выделение до клика.
      button.addEventListener('mousedown', (event) => event.preventDefault());
      button.addEventListener('click', () => applyFormat(entry.format));
      pop.appendChild(button);
    }
    document.body.appendChild(pop);
    formatPop = pop;
    return pop;
  }

  function hideFormatPop() {
    if (formatPop) formatPop.hidden = true;
  }

  function updateFormatPop() {
    const pop = ensureFormatPop();
    const root = activeEditableRoot();
    const selection = window.getSelection();
    if (
      !root ||
      !selection ||
      !selection.rangeCount ||
      selection.isCollapsed ||
      !root.contains(selection.anchorNode) ||
      drag.active
    ) {
      pop.hidden = true;
      return;
    }
    let rect = null;
    try {
      rect = selection.getRangeAt(0).getBoundingClientRect();
    } catch (error) {
      rect = null;
    }
    if (!rect || (rect.width === 0 && rect.height === 0)) {
      pop.hidden = true;
      return;
    }
    pop.hidden = false;
    const popWidth = pop.offsetWidth || 300;
    const popHeight = pop.offsetHeight || 38;
    let left = rect.left + rect.width / 2 - popWidth / 2;
    left = Math.max(8, Math.min(window.innerWidth - popWidth - 8, left));
    let top = rect.top - popHeight - 8;
    if (top < 8) top = rect.bottom + 8;
    pop.style.left = `${Math.round(left)}px`;
    pop.style.top = `${Math.round(top)}px`;
  }

  function currentFontSize() {
    const selection = window.getSelection();
    if (!selection || !selection.rangeCount) return 17;
    let node = selection.anchorNode;
    while (node && node !== document) {
      if (node.nodeType === 1 && node.dataset && node.dataset.fs) {
        return Number(node.dataset.fs) || 17;
      }
      node = node.parentNode;
    }
    return 17;
  }

  function applyFormat(format) {
    const root = activeEditableRoot();
    if (!root) return;
    if (format === 'bold') document.execCommand('bold', false, null);
    else if (format === 'italic') document.execCommand('italic', false, null);
    else if (format === 'strike') document.execCommand('strikeThrough', false, null);
    else if (format === 'list') document.execCommand('insertUnorderedList', false, null);
    else if (format === 'clear') {
      document.execCommand('removeFormat', false, null);
      const live = activeEditableRoot() || root;
      live.querySelectorAll('span[data-fs]').forEach((span) => {
        span.replaceWith(...span.childNodes);
      });
    } else if (format === 'bigger' || format === 'smaller') {
      const current = currentFontSize();
      const sorted = [...FONT_SIZES].sort((a, b) => a - b);
      const next =
        format === 'bigger'
          ? sorted.find((size) => size > current) || 25
          : [...sorted].reverse().find((size) => size < current) || 13;
      // Надёжный путь в Chromium: размер через font, затем меняем на span.
      document.execCommand('fontSize', false, '4');
      const live = activeEditableRoot() || root;
      live.querySelectorAll('font[size]').forEach((font) => {
        const span = document.createElement('span');
        span.dataset.fs = String(next);
        span.style.fontSize = `${next}px`;
        span.innerHTML = font.innerHTML;
        font.replaceWith(span);
      });
    }
    updateFormatPop();
  }

  document.addEventListener('selectionchange', () => {
    if (drag.active) {
      hideFormatPop();
      return;
    }
    updateFormatPop();
  });
  window.addEventListener('scroll', hideFormatPop, true);

  // ---------------------------------------------------------------------
  // Редактор стикера
  // ---------------------------------------------------------------------

  let editorNode = null;
  let editorTaskId = null;
  let editorDraft = null;

  function openEditor(taskId) {
    if (draftNode) commitDraft();
    commitInlineEdit();
    const task = store.getTask(taskId);
    if (!task) return;
    closeEditor();
    editorTaskId = taskId;
    editorDraft = {
      text: task.text,
      tag: task.tag,
      color: task.color,
      dueDate: task.dueDate,
      priority: task.priority,
    };

    editorNode = dom.tplEditor.content.firstElementChild.cloneNode(true);
    document.querySelector('.app').appendChild(editorNode);
    dom.modalBackdrop.hidden = false;
    requestAnimationFrame(() => dom.modalBackdrop.classList.add('show'));

    const textInput = editorNode.querySelector('#editText');
    const dueInput = editorNode.querySelector('#editDue');
    const priorityInput = editorNode.querySelector('#editPriority');

    textInput.innerHTML = editorDraft.text || '';
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

    textInput.addEventListener('input', () => {
      editorDraft.text = readRichText(textInput);
    });
    dueInput.addEventListener('change', () => {
      editorDraft.dueDate = dueInput.value || null;
    });
    priorityInput.addEventListener('change', () => {
      editorDraft.priority = priorityInput.checked;
    });

    editorNode.querySelector('#editSave').addEventListener('click', () => saveEditor(true));
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
    textInput.focus();
    try {
      const range = document.createRange();
      range.selectNodeContents(textInput);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    } catch (error) {
      /* без выделения — просто фокус */
    }
  }

  function onBackdropClick() {
    saveEditor(true);
  }

  function hideBackdropIfIdle() {
    if (!dom.modalBackdrop.classList.contains('show')) dom.modalBackdrop.hidden = true;
  }

  function commitEditorDraft() {
    if (!editorTaskId || !editorDraft) return { ok: false };
    const text = Core.sanitizeRich(editorDraft.text || '');
    if (!Core.strippedText(text)) {
      // Пустой текст недопустим — возвращаем исходный.
      const original = store.getTask(editorTaskId);
      if (!original) return { ok: false, reason: 'empty-text' };
      return store.updateTask(editorTaskId, {
        text: original.text,
        tag: editorDraft.tag,
        color: editorDraft.color,
        dueDate: editorDraft.dueDate,
        priority: editorDraft.priority,
      });
    }
    return store.updateTask(editorTaskId, {
      text,
      tag: editorDraft.tag,
      color: editorDraft.color,
      dueDate: editorDraft.dueDate,
      priority: editorDraft.priority,
    });
  }

  function saveEditor(shouldClose) {
    const result = commitEditorDraft();
    if (result && result.ok === false && result.reason === 'empty-text') {
      toast('У стикера должен быть текст', null);
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
    hideFormatPop();
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
    selectedIds.delete(taskId);
    syncSelectionUI();
    toast(`«${truncate(headLine(task ? task.text : ''), 40)}» удалён`, {
      label: 'Вернуть',
      action: () => {
        store.restoreTask(taskId);
        render();
      },
    });
  }

  // Массовое удаление выделенного (кнопка «Удалить (n)» и клавиша Delete).
  function bulkDelete() {
    const ids = [...selectedIds].filter((id) => store.getTask(id));
    if (ids.length === 0) {
      selectedIds.clear();
      syncSelectionUI();
      return;
    }
    for (const id of ids) store.deleteTask(id);
    selectedIds.clear();
    syncSelectionUI();
    render();
    toast(`Удалено стикеров: ${ids.length}`, {
      label: 'Вернуть',
      action: () => {
        for (const id of ids) store.restoreTask(id);
        render();
      },
    });
  }

  dom.bulkDeleteBtn.addEventListener('click', bulkDelete);

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
      if (action === 'edit' && sticker) return openEditor(sticker.dataset.taskId);
      if (action === 'delete' && sticker) return doDelete(sticker.dataset.taskId);
      if (action === 'quick-add' && column) return quickAdd(column.dataset.columnId);
      if (action === 'column-menu' && column) return openColumnMenu(column, actionButton);
    }

    const titleNode = event.target.closest('.column-title');
    if (titleNode) {
      const columnNode = titleNode.closest('.column');
      startTitleEdit(columnNode, titleNode);
    }
  });

  function quickAdd(columnId) {
    const snapshot = store.snapshot();
    const pool =
      (columnId && snapshot.columns.find((column) => column.id === columnId)) ||
      snapshot.columns.find((column) => column.role === 'pool') ||
      snapshot.columns[0];
    if (!pool) return;
    const spot = freeSpotInColumn(pool.id);
    const result = store.createTask({
      columnId: pool.id,
      text: 'Новый стикер',
      color: pickColor(),
      x: spot.x,
      y: spot.y,
    });
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
      toast('Колонка добавлена — переименуй её кликом по заголовку', null);
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
    if (event.key === 'Escape' && !editorNode && !inlineEdit.node && !draftNode && selectedIds.size > 0) {
      selectedIds.clear();
      syncSelectionUI();
    }
    if (
      (event.key === 'Delete' || event.key === 'Backspace') &&
      !editorNode &&
      !inlineEdit.node &&
      !draftNode &&
      selectedIds.size > 0
    ) {
      const active = document.activeElement;
      const typing =
        active &&
        (active.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName || ''));
      if (!typing) {
        event.preventDefault();
        bulkDelete();
      }
    }
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
  // Тема доски: селект в топбаре, хранится в board.theme (ядро).
  // ---------------------------------------------------------------------

  const THEMES = Core.THEMES;
  for (const theme of THEMES) {
    const option = document.createElement('option');
    option.value = theme.id;
    option.textContent = theme.label;
    dom.themeSelect.appendChild(option);
  }

  // Превью темы без записи в доску: ?theme=cork (флаг --theme= для скриншотов).
  const previewTheme = query.get('theme');
  const PREVIEW_THEME =
    previewTheme && THEMES.some((theme) => theme.id === previewTheme) ? previewTheme : null;
  if (PREVIEW_THEME) {
    dom.themeSelect.disabled = true;
    dom.themeSelect.title = 'Превью темы (флаг --theme), переключение выключено';
  }

  function applyTheme() {
    const current = PREVIEW_THEME || store.getTheme();
    document.documentElement.dataset.theme = current;
    if (dom.themeSelect.value !== current) dom.themeSelect.value = current;
  }

  dom.themeSelect.addEventListener('change', () => {
    const result = store.setTheme(dom.themeSelect.value);
    if (!result.ok) applyTheme(); // успех сам придёт через subscribe → render
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

      // Создание задачи со свободной позицией
      const poolLane = laneListTop('pool') || { x: 20, y: 20 };
      const created = store.createTask({
        columnId: 'pool',
        text: 'Смоук-стикер',
        color: 'blue',
        x: Math.round(poolLane.x),
        y: Math.round(poolLane.y),
      });
      check('create: ok', created.ok);
      check('create: свободные координаты сохранены', Number.isFinite(created.task.x) && Number.isFinite(created.task.y));
      render();

      // Перемещение со свободной позицией
      const doneSpot = freeSpotInColumn('done');
      const moved = store.setTaskPos(created.task.id, 'done', doneSpot.x, doneSpot.y, {});
      check('move: ok', moved.ok, JSON.stringify(moved));
      check('move: позиция обновлена', Number.isFinite(moved.task.x) && moved.task.columnId === 'done');
      render();

      // WIP-лимит: в работе сейчас 1 из 3. Добьём до трёх и проверим, что четвёртая не входит.
      store.createTask({ columnId: 'in-progress', text: 'Смоук в работе 2' });
      store.createTask({ columnId: 'in-progress', text: 'Смоук в работе 3' });
      const blocked = store.createTask({ columnId: 'in-progress', text: 'Смоук сверх лимита' });
      check('wip: создание отклонено', blocked.ok === false && blocked.reason === 'wip');
      const taskFromPool = store.getTask('seed-1');
      const blockedMove = store.setTaskPos(taskFromPool.id, 'in-progress', 10, 10, {});
      check('wip: перемещение отклонено', blockedMove.ok === false && blockedMove.reason === 'wip');

      // Правка единого текста
      const edited = store.updateTask(created.task.id, { text: 'Смоук-стикер (правленый)\nзаметка' });
      check('update: ok', edited.ok && edited.task.text.includes('правленый'));

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

      // Живое перетаскивание: живой узел движется сам, без призрака и слота.
      // Стикер можно бросить на границе — он остаётся где бросили.
      const dragCreated = store.createTask({ columnId: 'pool', text: 'Перетаскиваемый', color: 'peach' });
      check('drag: стикер создан', dragCreated.ok);
      render();

      const stickerNode = dom.board.querySelector(
        `:scope > .sticker[data-task-id="${dragCreated.task.id}"]`
      );
      check('drag: узел стикера найден', Boolean(stickerNode));
      if (stickerNode) {
        const sourceRect = stickerNode.getBoundingClientRect();
        const startX = sourceRect.left + sourceRect.width / 2;
        const startY = sourceRect.top + Math.min(sourceRect.height / 2, 30);
        dispatchPointer('pointerdown', stickerNode, startX, startY, 77);

        const doneColumn = dom.board.querySelector(':scope > .column[data-column-id="done"]');
        const targetRect = doneColumn.getBoundingClientRect();
        const targetX = targetRect.left + targetRect.width / 2;
        const targetY = targetRect.top + 120;

        dispatchPointer('pointermove', window, targetX - 8, targetY - 4, 77);
        dispatchPointer('pointermove', window, targetX, targetY, 77);

        check('drag: живого призрака-клона нет', !document.querySelector('.drag-ghost'));
        check('drag: тянущийся стикер подсвечен живым классом',
          Boolean(dom.board.querySelector('.sticker.dragging-live')));
        check('drag: целевая дорожка подсвечена', Boolean(document.querySelector('.column.drop-target')));

        // Бросок ровно на границу done-дорожки: узел остаётся где бросили.
        const laneRects = measureLanes();
        const doneLane = laneRects.find((lane) => lane.id === 'done');
        if (doneLane) {
          const boardRect = dom.board.getBoundingClientRect();
          const borderClientX = boardRect.left + doneLane.left + 2;
          dispatchPointer('pointerup', window, borderClientX, targetY, 77);
        } else {
          dispatchPointer('pointerup', window, targetX, targetY, 77);
        }
        const afterDrag = store.getTask(dragCreated.task.id);
        check('drag: стикер переехал в «Завершено» (владелец по центру)', afterDrag && afterDrag.columnId === 'done',
          afterDrag ? afterDrag.columnId : 'нет задачи');
        check('drag: живого класса после броска нет', !document.querySelector('.sticker.dragging-live'));
        check('drag: подсветка снята', !document.querySelector('.column.drop-target'));
      }

      // Перетаскивание в переполненную колонку отклоняется и возвращается.
      const blockedDrag = store.createTask({ columnId: 'pool', text: 'Упрётся в лимит' });
      render();
      const blockedNode = dom.board.querySelector(
        `:scope > .sticker[data-task-id="${blockedDrag.task.id}"]`
      );
      if (blockedNode) {
        const blockedRect = blockedNode.getBoundingClientRect();
        dispatchPointer('pointerdown', blockedNode, blockedRect.left + 40, blockedRect.top + 20, 78);
        const busyColumn = dom.board.querySelector(':scope > .column[data-column-id="in-progress"]');
        const busyRect = busyColumn.getBoundingClientRect();
        dispatchPointer('pointermove', window, busyRect.left + busyRect.width / 2, busyRect.top + 120, 78);
        check('drag: переполненная дорожка подсвечена красным',
          Boolean(document.querySelector('.column.drop-blocked')));
        dispatchPointer('pointerup', window, busyRect.left + busyRect.width / 2, busyRect.top + 120, 78);
        const stillPool = store.getTask(blockedDrag.task.id);
        check('drag: переполненная колонка не приняла стикер', stillPool && stillPool.columnId === 'pool',
          stillPool ? stillPool.columnId : 'нет задачи');
      }

      // Магнит: бросок в 30px от центра дорожки — стикер встаёт ровно по центру.
      const magnetTask = store.createTask({ columnId: 'pool', text: 'Магнитный' });
      check('magnet: стикер создан', magnetTask.ok);
      render();
      const magnetNode = dom.board.querySelector(
        `:scope > .sticker[data-task-id="${magnetTask.task.id}"]`
      );
      const waitingLane = measureLanes().find((lane) => lane.id === 'waiting');
      check('magnet: дорожка измерена', Boolean(magnetNode && waitingLane));
      if (magnetNode && waitingLane) {
        const boardRect = dom.board.getBoundingClientRect();
        const nodeW = magnetNode.offsetWidth || 200;
        const centerLeft = Math.round((waitingLane.left + waitingLane.right) / 2 - nodeW / 2);
        const nodeRect = magnetNode.getBoundingClientRect();
        const startX = nodeRect.left + nodeRect.width / 2;
        const startY = nodeRect.top + 20;
        const nodeLeft = nodeRect.left - boardRect.left;
        const grabDX = startX - boardRect.left - nodeLeft;
        const dropClientX = boardRect.left + centerLeft + 30 + grabDX;
        dispatchPointer('pointerdown', magnetNode, startX, startY, 83);
        dispatchPointer('pointermove', window, dropClientX - 10, startY, 83);
        dispatchPointer('pointermove', window, dropClientX, startY, 83);
        check('magnet: прилипание видно', Boolean(dom.board.querySelector('.sticker.magnet-on')));
        dispatchPointer('pointerup', window, dropClientX, startY, 83);
        const magnetAfter = store.getTask(magnetTask.task.id);
        check('magnet: встал ровно по центру', magnetAfter && magnetAfter.x === centerLeft,
          magnetAfter ? `x=${magnetAfter.x} центр=${centerLeft}` : 'нет задачи');
      }

      // Расталкивание: бросок поверх занятого места сдвигает соседа вниз.
      const pushLanes = measureLanes();
      const pushLane = pushLanes.find((lane) => lane.id === 'waiting');
      if (pushLane) {
        const laneBoardRect = dom.board.getBoundingClientRect();
        const laneW = pushLane.right - pushLane.left;
        const anchorX = Math.round(pushLane.left + 8);
        const anchorY = Math.round(pushLane.top + 420);
        const pushA = store.createTask({ columnId: 'waiting', text: 'Не двигать', x: anchorX, y: anchorY });
        const pushB = store.createTask({ columnId: 'waiting', text: 'Бросить сюда', x: anchorX, y: anchorY });
        check('push: пара создана', pushA.ok && pushB.ok);
        render();
        const nodeB = dom.board.querySelector(`:scope > .sticker[data-task-id="${pushB.task.id}"]`);
        if (nodeB) {
          const rectB = nodeB.getBoundingClientRect();
          const bX = rectB.left + rectB.width / 2;
          const bY = rectB.top + 20;
          dispatchPointer('pointerdown', nodeB, bX, bY, 84);
          dispatchPointer('pointermove', window, bX + 6, bY + 6, 84);
          dispatchPointer('pointermove', window, bX + 10, bY + 10, 84);
          check('push: живой сдвиг виден',
            [...dom.board.querySelectorAll(':scope > .sticker')].some((n) => n.style.transform.includes('translateY')));
          dispatchPointer('pointerup', window, bX + 10, bY + 10, 84);
          render();
          const aTask = store.getTask(pushA.task.id);
          const bTask = store.getTask(pushB.task.id);
          const nodeA2 = dom.board.querySelector(`:scope > .sticker[data-task-id="${pushA.task.id}"]`);
          const nodeB2 = dom.board.querySelector(`:scope > .sticker[data-task-id="${pushB.task.id}"]`);
          const hB = (nodeB2 && nodeB2.offsetHeight) || 110;
          const pushedDown = aTask && bTask && aTask.y >= bTask.y + hB + STICKER_GAP - 2;
          check('push: сосед съехал вниз без наложения', pushedDown,
            aTask && bTask ? `a.y=${aTask.y} b.y=${bTask.y} h=${hB}` : 'нет задач');
          void laneBoardRect;
          void laneW;
        } else {
          check('push: узел найден', false);
        }
      }

      // Рамка выделения: протяжка по пустому выбирает стикеры.
      render();
      const selLanes = measureLanes();
      const selBoardRect = dom.board.getBoundingClientRect();
      const shiftDispatch = (type, target, clientX, clientY, pointerId) => {
        target.dispatchEvent(new PointerEvent(type, {
          bubbles: true, cancelable: true, composed: true,
          pointerId, pointerType: 'mouse', button: 0,
          buttons: type === 'pointerup' ? 0 : 1,
          clientX, clientY, shiftKey: true,
        }));
      };
      if (selLanes.length > 0) {
        const lane0 = selLanes[0];
        const mStartX = selBoardRect.left + lane0.left + 4;
        const mStartY = selBoardRect.top + lane0.top + 60;
        dispatchPointer('pointerdown', dom.board, mStartX, mStartY, 87);
        dispatchPointer('pointermove', window, mStartX + 150, mStartY + 250, 87);
        dispatchPointer('pointermove', window, mStartX + 300, mStartY + 500, 87);
        check('marquee: рамка видна', Boolean(dom.board.querySelector('.marquee')));
        dispatchPointer('pointerup', window, mStartX + 300, mStartY + 500, 87);
        check('marquee: рамка убрана', !dom.board.querySelector('.marquee'));
        check('marquee: seed-1 выбран', selectedIds.has('seed-1'));
        check('marquee: выбрано несколько',
          selectedIds.size >= 2 &&
          dom.board.querySelectorAll(':scope > .sticker.selected').length === selectedIds.size,
          String(selectedIds.size));

        // Shift+рамка добавляет к выделению.
        const doneLane = selLanes.find((lane) => lane.id === 'done');
        if (doneLane) {
          const sizeBefore = selectedIds.size;
          const sX = selBoardRect.left + doneLane.left + 20;
          const sY = selBoardRect.top + doneLane.top + 60;
          shiftDispatch('pointerdown', dom.board, sX, sY, 88);
          shiftDispatch('pointermove', window, sX + 150, sY + 400, 88);
          shiftDispatch('pointerup', window, sX + 150, sY + 400, 88);
          check('marquee: shift добавил', selectedIds.size > sizeBefore,
            `${sizeBefore}->${selectedIds.size}`);
        }

        // Esc снимает выделение.
        window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Escape' }));
        check('marquee: Esc очистил', selectedIds.size === 0 &&
          !dom.board.querySelector(':scope > .sticker.selected'));

        // Shift+клики собирают пару для группового переноса.
        const seedNode1 = dom.board.querySelector(':scope > .sticker[data-task-id="seed-1"]');
        const seedNode2 = dom.board.querySelector(':scope > .sticker[data-task-id="seed-2"]');
        if (seedNode1 && seedNode2) {
          const rect1 = seedNode1.getBoundingClientRect();
          const rect2 = seedNode2.getBoundingClientRect();
          shiftDispatch('pointerdown', seedNode1, rect1.left + 100, rect1.top + 20, 89);
          shiftDispatch('pointerup', window, rect1.left + 100, rect1.top + 20, 89);
          shiftDispatch('pointerdown', seedNode2, rect2.left + 100, rect2.top + 20, 90);
          shiftDispatch('pointerup', window, rect2.left + 100, rect2.top + 20, 90);
          check('group: пара выбрана', selectedIds.has('seed-1') && selectedIds.has('seed-2'));

          // Тянем ведущего — ведомый едет на тот же вектор (базы берём из DOM:
          // у стикеров автораскладки в store ещё null).
          const domLeft1 = Number.parseFloat(seedNode1.style.left || '0') || 0;
          const domTop1 = Number.parseFloat(seedNode1.style.top || '0') || 0;
          const domLeft2 = Number.parseFloat(seedNode2.style.left || '0') || 0;
          const domTop2 = Number.parseFloat(seedNode2.style.top || '0') || 0;
          const dragRect = seedNode1.getBoundingClientRect();
          const dragX = dragRect.left + dragRect.width / 2;
          const dragY = dragRect.top + 20;
          dispatchPointer('pointerdown', seedNode1, dragX, dragY, 91);
          dispatchPointer('pointermove', window, dragX + 30, dragY + 40, 91);
          dispatchPointer('pointermove', window, dragX + 60, dragY + 80, 91);
          dispatchPointer('pointerup', window, dragX + 60, dragY + 80, 91);
          const after1 = store.getTask('seed-1');
          const after2 = store.getTask('seed-2');
          const d1x = after1.x - domLeft1;
          const d1y = after1.y - domTop1;
          const d2x = after2.x - domLeft2;
          const d2y = after2.y - domTop2;
          check('group: ведомый сдвинут тем же вектором',
            (d1x !== 0 || d1y !== 0) && d1x === d2x && d1y === d2y,
            `[${d1x},${d1y}] vs [${d2x},${d2y}]`);
          check('group: выделение сохранилось', selectedIds.has('seed-1') && selectedIds.has('seed-2'));
        } else {
          check('group: узлы найдены', false);
        }

        // Массовое удаление кнопкой + возврат через тост.
        const totalBefore = store.snapshot().tasks.filter((task) => task.deletedAt === null).length;
        const selCount = selectedIds.size;
        check('bulk: кнопка видна', !dom.bulkDeleteBtn.hidden && selCount >= 2,
          `кнопка hidden=${dom.bulkDeleteBtn.hidden} n=${selCount}`);
        dom.bulkDeleteBtn.click();
        const totalAfterDelete = store.snapshot().tasks.filter((task) => task.deletedAt === null).length;
        check('bulk: удалено пачкой', totalAfterDelete === totalBefore - selCount,
          `${totalBefore}->${totalAfterDelete} (n=${selCount})`);
        check('bulk: выделение снято', selectedIds.size === 0);
        const toastActions = dom.toasts.querySelectorAll('.toast-action');
        check('bulk: тост с возвратом', toastActions.length > 0);
        if (toastActions.length > 0) toastActions[toastActions.length - 1].click();
        const totalAfterRestore = store.snapshot().tasks.filter((task) => task.deletedAt === null).length;
        check('bulk: всё вернулось', totalAfterRestore === totalBefore,
          `${totalAfterDelete}->${totalAfterRestore}`);
      } else {
        check('marquee: дорожки измерены', false);
      }

      // OneNote-создание: клик по пустому месту (зазор между дорожками) открывает черновик.
      render();
      const gapLanes = measureLanes();
      if (gapLanes.length >= 2) {
        const boardRect = dom.board.getBoundingClientRect();
        const gapX = boardRect.left + (gapLanes[0].right + gapLanes[1].left) / 2;
        const gapY = boardRect.top + gapLanes[0].top + 200;
        dispatchPointer('pointerdown', dom.board, gapX, gapY, 79);
        dispatchPointer('pointerup', window, gapX, gapY, 79);
        check('click-create: черновик появился', Boolean(dom.board.querySelector('.sticker.is-draft')));
        const draftNode = dom.board.querySelector('.sticker.is-draft');
        check('click-create: черновик сразу в цвете стикера',
          Boolean(draftNode) && COLORS.includes(draftNode.dataset.color),
          draftNode ? draftNode.dataset.color : 'нет узла');

        // Печатаем в черновик и кликаем мимо: старый сохраняется, новый не создаётся.
        const draftTitle = dom.board.querySelector('.sticker.is-draft .draft-title');
        const tasksBefore = store.snapshot().tasks.filter((task) => task.deletedAt === null).length;
        if (draftTitle) draftTitle.textContent = 'Заметка из черновика';
        const gapY2 = gapY + 150;
        dispatchPointer('pointerdown', dom.board, gapX, gapY2, 81);
        dispatchPointer('pointerup', window, gapX, gapY2, 81);
        const tasksAfter = store.snapshot().tasks.filter((task) => task.deletedAt === null).length;
        check('click-create: клик мимо сохранил черновик', tasksAfter === tasksBefore + 1, `${tasksBefore}->${tasksAfter}`);
        check('click-create: новый черновик не создан', !dom.board.querySelector('.sticker.is-draft'));
        closeDraft(true);
      } else {
        check('click-create: черновик появился', false, 'нет дорожек для клика');
      }

      // Клик по стикеру — инлайн-правка текста, а не модалка.
      render();
      const inlineProbe = dom.board.querySelector(':scope > .sticker[data-task-id="seed-2"]')
        || dom.board.querySelector(':scope > .sticker:not(.is-draft)');
      check('inline: стикер для пробы найден', Boolean(inlineProbe));
      if (inlineProbe) {
        const probeRect = inlineProbe.getBoundingClientRect();
        const probeX = probeRect.left + probeRect.width / 2;
        const probeY = probeRect.top + Math.min(probeRect.height / 2, 40);
        dispatchPointer('pointerdown', inlineProbe, probeX, probeY, 82);
        dispatchPointer('pointerup', window, probeX, probeY, 82);
        check('inline: правка на месте, без модалки',
          Boolean(dom.board.querySelector('.sticker.editing-inline')) && !document.querySelector('.editor'));
        // Esc — откат инлайн-правки.
        const editingTitle = dom.board.querySelector('.sticker.editing-inline [data-role="text"]');
        if (editingTitle) {
          editingTitle.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Escape' }));
        }
        check('inline: Esc закрыл правку', !dom.board.querySelector('.sticker.editing-inline'));
        // Дабл-клик модалку не открывает.
        inlineProbe.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, composed: true }));
        check('inline: дабл-клик модалку не открывает', !document.querySelector('.editor'));
        // Полный редактор — через карандаш ✎.
        const editBtn = inlineProbe.querySelector('[data-action="edit"]');
        check('inline: кнопка ✎ есть', Boolean(editBtn));
        if (editBtn) editBtn.click();
        check('editor: единое поле текста', Boolean(document.querySelector('#editText')));
        check('editor: разделения заголовок/заметка нет',
          !document.querySelector('#editTitle') && !document.querySelector('#editNote'));
        const editorSheet = document.querySelector('.editor');
        if (editorSheet) {
          editorSheet.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Escape' }));
        }
        check('inline: редактор закрылся', !document.querySelector('.editor'));
      }

      // Многострочность: Enter в правке создаёт <div>, сохранение держит \n.
      const mlTask = store.createTask({ columnId: 'pool', text: 'Многострочный' });
      check('multiline: стикер создан', mlTask.ok);
      render();
      const mlNode = mlTask.ok
        ? dom.board.querySelector(`:scope > .sticker[data-task-id="${mlTask.task.id}"]`)
        : null;
      if (mlNode) {
        const mlRect = mlNode.getBoundingClientRect();
        const mlX = mlRect.left + mlRect.width / 2;
        const mlY = mlRect.top + 20;
        dispatchPointer('pointerdown', mlNode, mlX, mlY, 85);
        dispatchPointer('pointerup', window, mlX, mlY, 85);
        const mlText = dom.board.querySelector('.sticker.editing-inline [data-role="text"]');
        check('multiline: инлайн открылся', Boolean(mlText));
        if (mlText) {
          mlText.innerHTML = 'первая<div>вторая</div><div>третья</div>';
          mlText.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Enter', ctrlKey: true }));
          const mlSaved = store.getTask(mlTask.task.id);
          check('multiline: переносы сохранены', mlSaved && mlSaved.text === 'первая<br>вторая<br>третья',
            mlSaved ? JSON.stringify(mlSaved.text) : 'нет задачи');
          render();
          const mlShown = dom.board.querySelector(
            `:scope > .sticker[data-task-id="${mlTask.task.id}"] [data-role="text"]`
          );
          check('multiline: переносы на доске',
            Boolean(mlShown) && mlShown.textContent.includes('первая') && mlShown.textContent.includes('третья'),
            mlShown ? JSON.stringify(mlShown.textContent.slice(0, 40)) : 'нет узла');
        }
      } else {
        check('multiline: узел найден', false);
      }

      // Форматирование: выделить текст, нажать B — тулбар как в мессенджерах.
      const fTask = store.createTask({ columnId: 'pool', text: 'Сделать жирным' });
      check('format: стикер создан', fTask.ok);
      render();
      const fNode = fTask.ok
        ? dom.board.querySelector(`:scope > .sticker[data-task-id="${fTask.task.id}"]`)
        : null;
      if (fNode) {
        const fRect = fNode.getBoundingClientRect();
        const fX = fRect.left + fRect.width / 2;
        const fY = fRect.top + 20;
        dispatchPointer('pointerdown', fNode, fX, fY, 86);
        dispatchPointer('pointerup', window, fX, fY, 86);
        const fText = dom.board.querySelector('.sticker.editing-inline [data-role="text"]');
        check('format: инлайн открылся', Boolean(fText));
        if (fText) {
          const range = document.createRange();
          range.selectNodeContents(fText);
          const selection = window.getSelection();
          selection.removeAllRanges();
          selection.addRange(range);
          updateFormatPop();
          check('format: тулбар всплыл', Boolean(formatPop && !formatPop.hidden));
          const boldBtn = formatPop.querySelector('[data-format="bold"]');
          if (boldBtn) boldBtn.click();
          check('format: жирный применён', fText.innerHTML.includes('<b>'),
            fText.innerHTML.slice(0, 60));
          fText.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Enter', ctrlKey: true }));
          const fSaved = store.getTask(fTask.task.id);
          check('format: разметка сохранена', fSaved && fSaved.text.includes('<b>Сделать жирным</b>'),
            fSaved ? JSON.stringify(fSaved.text.slice(0, 60)) : 'нет задачи');
        }
      } else {
        check('format: узел найден', false);
      }

      // Единый текст: заголовок и детали — один блок без разделения.
      const seedNode = dom.board.querySelector(':scope > .sticker[data-task-id="seed-3"] [data-role="text"]');
      check('unified: текст и детали в одном блоке',
        Boolean(seedNode) && seedNode.textContent.includes('Оплатить') && seedNode.textContent.includes('почте'),
        seedNode ? seedNode.textContent.slice(0, 40) : 'нет узла');

      // Глубина: доска удлинена под самый нижний стикер.
      check('depth: доска подогнана под контент',
        dom.board.style.minHeight.endsWith('px') && Number.parseFloat(dom.board.style.minHeight) > 0,
        dom.board.style.minHeight);

      // Темы: селект переключает оформление, тема хранится в доске.
      const styleOf = () => window.getComputedStyle(document.body);
      const kraftLook = styleOf().backgroundImage + '|' + styleOf().backgroundColor;
      check('theme: по умолчанию крафт',
        document.documentElement.dataset.theme === 'kraft' && dom.themeSelect.value === 'kraft',
        `html=${document.documentElement.dataset.theme} select=${dom.themeSelect.value}`);
      for (const theme of THEMES) {
        dom.themeSelect.value = theme.id;
        dom.themeSelect.dispatchEvent(new Event('change', { bubbles: true }));
        check(`theme: переключена «${theme.label}»`,
          document.documentElement.dataset.theme === theme.id && store.getTheme() === theme.id,
          `html=${document.documentElement.dataset.theme}`);
      }
      const graphiteLook = styleOf().backgroundImage + '|' + styleOf().backgroundColor;
      check('theme: графит выглядит иначе, чем крафт', kraftLook !== graphiteLook,
        `${kraftLook.slice(0, 60)} vs ${graphiteLook.slice(0, 60)}`);
      check('theme: тема в снимке доски', store.snapshot().theme === store.getTheme(), store.snapshot().theme);
      const badTheme = store.setTheme('бархат');
      check('theme: мусор отклоняется', !badTheme.ok && store.getTheme() !== 'бархат');
      // Возвращаем крафт, чтобы скриншот остался привычным.
      dom.themeSelect.value = 'kraft';
      dom.themeSelect.dispatchEvent(new Event('change', { bubbles: true }));

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

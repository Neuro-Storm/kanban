/*
 * Мост между рендерером и главным процессом.
 * Наружу торчит только то, что нужно доске, — никаких путей и файловых API.
 */
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('kanbanAPI', {
  // Синхронное чтение на старте: доске нужно состояние до первого рендера.
  loadBoard: () => ipcRenderer.sendSync('board:load-sync'),

  // Основной путь — асинхронный (очередь в main, без фриза рендерера).
  // Возвращает промис; ошибку диска отдаёт объектом {ok:false}, а не броском,
  // чтобы оптимистичный flush не ронял интерфейс.
  saveBoard: (payload) => ipcRenderer.invoke('board:save', payload),

  // Блокирующий путь для выгрузки (beforeunload) и детерминированных проверок.
  saveBoardSync: (payload) => {
    const result = ipcRenderer.sendSync('board:save-sync', payload);
    if (!result || result.ok !== true) {
      throw new Error((result && result.error) || 'запись не удалась');
    }
    return true;
  },

  exportBoard: () => ipcRenderer.invoke('board:export'),
  importBoard: () => ipcRenderer.invoke('board:import'),

  smokeLog: (message) => ipcRenderer.send('smoke:log', String(message)),
  smokeDone: (passed) => ipcRenderer.send('smoke:done', Boolean(passed)),
});

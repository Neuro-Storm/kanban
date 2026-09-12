/*
 * Мост между рендерером и главным процессом.
 * Наружу торчит только то, что нужно доске, — никаких путей и файловых API.
 */
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('kanbanAPI', {
  // Синхронное чтение на старте: доске нужно состояние до первого рендера.
  loadBoard: () => ipcRenderer.sendSync('board:load-sync'),

  // Сохранение тоже синхронное: запись маленького JSON-файла,
  // зато рендерер сразу знает об ошибке диска.
  saveBoard: (payload) => {
    const result = ipcRenderer.sendSync('board:save-sync', payload);
    if (!result || result.ok !== true) {
      throw new Error((result && result.error) || 'запись не удалась');
    }
    return true;
  },

  smokeLog: (message) => ipcRenderer.send('smoke:log', String(message)),
  smokeDone: (passed) => ipcRenderer.send('smoke:done', Boolean(passed)),
});

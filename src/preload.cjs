'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel) => (args) => ipcRenderer.invoke(channel, args);

contextBridge.exposeInMainWorld('routines', {
  localList: invoke('local:list'),
  localGet: invoke('local:get'),
  localUpdate: invoke('local:update'),
  localRename: invoke('local:rename'),
  localImportOrphan: invoke('local:importOrphan'),
  cloudList: invoke('cloud:list'),
  cloudGet: invoke('cloud:get'),
  cloudUpdate: invoke('cloud:update'),
  cloudRun: invoke('cloud:run'),
  movePreview: invoke('move:preview'),
  moveCloudToLocal: invoke('move:cloudToLocal'),
  moveLocalToCloud: invoke('move:localToCloud'),
  cronPreview: invoke('cron:preview'),
  pickFolder: invoke('dialog:pickFolder'),
  openExternal: invoke('app:openExternal'),
});

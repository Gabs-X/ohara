// Ponte entre a tela da Ohara Guia e o processo principal. Toda chamada devolve { ok, data, error }.
const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (fn) => {
  const handler = (_e, payload) => fn(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};
const inv = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('guia', {
  info: inv('app:info'),
  getConfig: inv('config:get'),
  setConfig: inv('config:set'),

  health: inv('health:get'),
  checkHealth: inv('health:check'),
  fixHealth: inv('health:fix'),
  providers: inv('providers:get'),

  listChats: inv('chats:list'),
  getChat: inv('chat:get'),
  createChat: inv('chat:create'),
  deleteChat: inv('chat:delete'),
  setCwd: inv('chat:setCwd'),
  send: inv('chat:send'),
  cancel: inv('chat:cancel'),
  undo: inv('chat:undo'),
  redo: inv('chat:redo'),
  previewRoute: inv('route:preview'),

  listProjects: inv('projects:list'),
  newProject: inv('projects:new'),
  detectProject: inv('project:detect'),
  runProject: inv('project:run'),
  openFolder: inv('project:openFolder'),

  listPlans: inv('plans:list'),
  getPlan: inv('plan:get'),
  createPlan: inv('plan:create'),
  revisePlan: inv('plan:revise'),
  deletePlan: inv('plan:delete'),
  setStep: inv('plan:step'),
  runStep: inv('plan:runStep'),

  usage: inv('usage:get'),

  pickFolder: inv('dialog:folder'),
  pickImages: inv('dialog:image'),
  captureScreen: inv('screen:capture'),
  openExternal: inv('shell:openExternal'),

  updateState: inv('update:state'),
  updateCheck: inv('update:check'),
  updateInstall: inv('update:install'),
  loginItem: inv('app:loginItem'),

  onRoute: on('chat:route'),
  onEvent: on('chat:event'),
  onDone: on('chat:done'),
  onMessage: on('chat:message'),
  onUsage: on('usage:update'),
  onHealth: on('health:update'),
  onView: on('app:view'),
  onUpdate: on('update:status'),
});

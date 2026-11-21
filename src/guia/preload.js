// Ponte entre a tela da Ohara Guia e o processo principal. Toda chamada devolve { ok, data, error }.
const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (fn) => {
  const handler = (_e, payload) => fn(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};
const inv = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);

// A tela de Ferramentas é a mesma da Ohara (src/renderer/tools.js) e fala com "central": aqui só o que ela usa.
// Umas chamadas lá esperam o valor direto e outras o { ok, data, error }: raw() desembrulha as primeiras.
const raw = (channel) => async (...args) => {
  const r = await ipcRenderer.invoke(channel, ...args);
  if (r?.ok === false) throw new Error(r.error);
  return r?.data;
};
contextBridge.exposeInMainWorld('central', {
  toolsStatus: raw('tools:status'),
  pickFile: raw('dialog:file'),
  pickFolder: raw('dialog:folder'),
  setConfig: raw('config:set'),
  openPath: raw('shell:openPath'),
  copy: raw('clipboard:write'),
  listRepos: async () => [],
  docsIndex: inv('docs:index'),
  docsAsk: inv('docs:ask'),
  toolExtract: inv('tools:extract'),
  toolTriage: inv('tools:triage'),
  toolPhoto: inv('tools:photo'),
  toolAnonymize: inv('tools:anonymize'),
  toolLog: inv('tools:log'),
  onDocsProgress: on('docs:progress'),
});

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
  pcActionConfirm: inv('pcaction:confirm'),
  pcActionCancel: inv('pcaction:cancel'),
  oharaAiStatus: inv('oharaai:status'),
  oharaAiDownload: inv('oharaai:download'),
  oharaAiCancel: inv('oharaai:cancel'),
  onOharaAiProgress: on('oharaai:progress'),
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

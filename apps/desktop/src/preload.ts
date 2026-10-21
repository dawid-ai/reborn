import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { IPC, type AgentActivity, type ApiRpcRequest, type DesktopBridge, type JobUpdate, type MenuEvent, type UpdateEvent } from '@reborn/studio-core/platform'

// The only surface the page sees. Each method maps to one IPC channel; no
// Node or Electron objects cross the bridge.

const subscribe = <T>(channel: string, listener: (payload: T) => void) => {
  const wrapped = (_event: IpcRendererEvent, payload: T) => listener(payload)
  ipcRenderer.on(channel, wrapped)
  return () => {
    ipcRenderer.removeListener(channel, wrapped)
  }
}

const bridge: DesktopBridge = {
  platform: 'desktop',
  getVersion: () => ipcRenderer.invoke(IPC.version),
  openProject: (path) => ipcRenderer.invoke(IPC.openProject, path),
  saveProject: (request) => ipcRenderer.invoke(IPC.saveProject, request),
  listRecent: () => ipcRenderer.invoke(IPC.listRecent),
  packProject: (path) => ipcRenderer.invoke(IPC.packProject, path),
  cancelJob: (id) => ipcRenderer.invoke(IPC.cancelJob, id),
  saveWav: (data, name) => ipcRenderer.invoke(IPC.saveWav, data, name),
  saveVideo: (data, name) => ipcRenderer.invoke(IPC.saveVideo, data, name),
  writeRecovery: (state) => ipcRenderer.send(IPC.writeRecovery, state),
  takeRecovery: () => ipcRenderer.invoke(IPC.takeRecovery),
  writeAutosave: (state) => ipcRenderer.invoke(IPC.writeAutosave, state),
  deleteAutosave: (id) => ipcRenderer.invoke(IPC.deleteAutosave, id),
  listAutosaves: () => ipcRenderer.invoke(IPC.listAutosaves),
  readAutosave: (id) => ipcRenderer.invoke(IPC.readAutosave, id),
  setDocumentState: (state) => ipcRenderer.send(IPC.documentState, state),
  log: (level, message) => ipcRenderer.send(IPC.log, level, message),
  onMenuCommand: (listener) => subscribe<MenuEvent>(IPC.menu, listener),
  onJobUpdate: (listener) => subscribe<JobUpdate>(IPC.jobUpdate, listener),
  getAgentSettings: () => ipcRenderer.invoke(IPC.agentSettings),
  setAgentSettings: (patch) => ipcRenderer.invoke(IPC.agentSetSettings, patch),
  agentComplete: (request) => ipcRenderer.invoke(IPC.agentComplete, request),
  agentRunCli: (prompt) => ipcRenderer.invoke(IPC.agentRunCli, prompt),
  onAgentActivity: (listener) => subscribe<AgentActivity>(IPC.agentActivity, listener),
  agentCancel: () => ipcRenderer.send(IPC.agentCancel),
  onApiRequest: (listener) => subscribe<ApiRpcRequest>(IPC.apiRequest, listener),
  respondApi: (response) => ipcRenderer.send(IPC.apiResponse, response),
  apiClients: () => ipcRenderer.invoke(IPC.apiClients),
  emitApiEvent: (event) => ipcRenderer.send(IPC.apiEvent, event),
  deepAnalyze: (request) => ipcRenderer.invoke(IPC.deepAnalyze, request),
  deepCompare: (request) => ipcRenderer.invoke(IPC.deepCompare, request),
  deepCancel: () => ipcRenderer.send(IPC.deepCancel),
  deepStatus: () => ipcRenderer.invoke(IPC.deepStatus),
  ismailStatus: () => ipcRenderer.invoke(IPC.ismailStatus),
  ismailInstall: (request) => ipcRenderer.invoke(IPC.ismailInstall, request),
  ismailPresets: () => ipcRenderer.invoke(IPC.ismailPresets),
  ismailGenerate: (request) => ipcRenderer.invoke(IPC.ismailGenerate, request),
  ismailSeparate: (request) => ipcRenderer.invoke(IPC.ismailSeparate, request),
  updateCheck: () => ipcRenderer.invoke(IPC.updateCheck),
  updateDownload: () => ipcRenderer.invoke(IPC.updateDownload),
  updateInstall: () => ipcRenderer.invoke(IPC.updateInstall),
  updateCurrent: () => ipcRenderer.invoke(IPC.updateCurrent),
  onUpdateEvent: (listener) => subscribe<UpdateEvent>(IPC.updateEvent, listener),
  updateSimulate: (event) => ipcRenderer.invoke(IPC.updateSimulate, event),
}

contextBridge.exposeInMainWorld('reborn', bridge)

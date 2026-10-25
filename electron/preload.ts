import { contextBridge, ipcRenderer } from 'electron'

// Must stay inlined: sandboxed preloads cannot require local relative modules.
const allowedChannels = new Set([
  'ai:cancel',
  'ai:conversation:branch',
  'ai:conversation:export',
  'ai:conversation:pin',
  'ai:conversation:archive',
  'ai:conversation:status',
  'ai:conversation:trash',
  'ai:conversation:update',
  'ai:conversations',
  'ai:message:contexts',
  'ai:float:close',
  'ai:float:open',
  'ai:previewRequest',
  'ai:send',
  'ai:session:get',
  'ai:session:loadConversation',
  'ai:session:patch',
  'ai:summarize',
  'ai:styles:list',
  'ai:style-selection:get',
  'ai:style-selection:set',
  'ai:style:save',
  'ai:style:delete',
  'ai:style:export',
  'ai:style:import',
  'ai:style:estimate',
  'ai:style-compositions:list',
  'ai:style-compositions:save',
  'ai:style-compositions:delete',
  'ai:style-compositions:export',
  'ai:style-compositions:import',
  'app:close-ready',
  'appearance:chooseBackground',
  'backup:chooseDir',
  'backup:create',
  'backup:list',
  'backup:restore',
  'backup:runAutoNow',
  'chapters:batchMove',
  'chapters:batchTrash',
  'chapters:chooseImage',
  'chapters:create',
  'chapters:duplicate',
  'chapters:get',
  'chapters:reorder',
  'chapters:save',
  'chapters:trash',
  'chapters:updateMeta',
  'characters:presence',
  'connections:list',
  'connections:models',
  'connections:save',
  'connections:test',
  'database:health',
  'export:novel',
  'import:cancel',
  'import:commit',
  'import:decode',
  'import:text',
  'library:list',
  'library:listAll',
  'library:save',
  'library:trash',
  'novels:chooseCover',
  'novels:create',
  'novels:list',
  'novels:open',
  'novels:restore',
  'novels:trash',
  'novels:trashList',
  'novels:update',
  'preferences:get',
  'preferences:set',
  'prompts:delete',
  'prompts:list',
  'prompts:restoreDefaults',
  'prompts:save',
  'revisions:create',
  'revisions:list',
  'revisions:preview',
  'revisions:restore',
  'search:cancel',
  'search:novel',
  'trash:list',
  'trash:purge',
  'trash:restore',
  'volumes:create',
  'volumes:trash',
  'volumes:update',
  'writing:overview',
  'writing:dayDetail',
  'writing:stats',
  'writing:today',
  'writing:focusPing',
  'writing:focusEnd',
  'world:presence',
])

let uiSmokeLastAiSend: unknown = null

contextBridge.exposeInMainWorld('zhuwen', {
  platform: process.platform,
  invoke: (channel: string, payload?: unknown) => {
    if (!allowedChannels.has(channel))
      return Promise.reject(new Error(`Blocked IPC channel: ${channel}`))
    if (process.env.ZHUWEN_UI_SMOKE && channel === 'ai:previewRequest')
      return Promise.resolve({ ok: true, data: [{ role: 'user', content: String((payload as any)?.prompt || '') }] })
    if (process.env.ZHUWEN_UI_SMOKE && channel === 'ai:send') {
      uiSmokeLastAiSend = payload
      if (process.env.ZHUWEN_AI_ECHO !== '1')
        return Promise.resolve({ ok: true, data: { smoke: true } })
    }
    return ipcRenderer.invoke(channel, payload)
  },
  ...(process.env.ZHUWEN_UI_SMOKE ? { __uiSmokeGetLastAiSend: () => uiSmokeLastAiSend } : {}),
  onAiChunk: (handler: (event: unknown) => void) => { const fn=(_:unknown,data:unknown)=>handler(data); ipcRenderer.on('ai:chunk',fn); return ()=>ipcRenderer.removeListener('ai:chunk',fn) },
  onAiDone: (handler: (event: unknown) => void) => { const fn=(_:unknown,data:unknown)=>handler(data); ipcRenderer.on('ai:done',fn); return ()=>ipcRenderer.removeListener('ai:done',fn) },
  onAiSession: (handler: (event: unknown) => void) => { const fn=(_:unknown,data:unknown)=>handler(data); ipcRenderer.on('ai:session',fn); return ()=>ipcRenderer.removeListener('ai:session',fn) }
  ,onAiConversations: (handler: (event: unknown) => void) => { const fn=(_:unknown,data:unknown)=>handler(data); ipcRenderer.on('ai:conversations:list',fn); return ()=>ipcRenderer.removeListener('ai:conversations:list',fn) }
  ,onSearchProgress: (handler: (event: unknown) => void) => { const fn=(_:unknown,data:unknown)=>handler(data); ipcRenderer.on('search:progress',fn); return ()=>ipcRenderer.removeListener('search:progress',fn) }
  ,onImportProgress: (handler: (event: unknown) => void) => { const fn=(_:unknown,data:unknown)=>handler(data); ipcRenderer.on('import:progress',fn); return ()=>ipcRenderer.removeListener('import:progress',fn) }
  ,onBeforeClose: (handler:()=>void) => { ipcRenderer.on('app:before-close',handler); return ()=>ipcRenderer.removeListener('app:before-close',handler) }
})

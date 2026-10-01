import { contextBridge, ipcRenderer } from 'electron'
import type { ProviderResult } from '../shared/types'

const api = {
  onUpdate: (cb: (snapshot: ProviderResult[]) => void): (() => void) => {
    const listener = (_event: unknown, snapshot: ProviderResult[]): void => cb(snapshot)
    ipcRenderer.on('usage:update', listener)
    return () => {
      ipcRenderer.removeListener('usage:update', listener)
    }
  },
  refresh: (): Promise<ProviderResult[]> => ipcRenderer.invoke('usage:refresh'),
  get: (): Promise<ProviderResult[]> => ipcRenderer.invoke('usage:get'),
  setPopupHeight: (height: number): void => {
    ipcRenderer.send('popup:height', height)
  }
}

contextBridge.exposeInMainWorld('ap', api)

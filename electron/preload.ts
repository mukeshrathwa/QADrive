import { contextBridge, ipcRenderer } from 'electron';
import type { RunPromptPayload } from './main.js';

contextBridge.exposeInMainWorld('e2eDesktop', {
  runPrompt: (payload: RunPromptPayload) =>
    ipcRenderer.invoke('e2e:run-prompt', payload),

  stopRun: () => ipcRenderer.invoke('e2e:stop-run'),

  onLog: (callback: (chunk: string) => void) => {
    const listener = (_event: unknown, chunk: string) => callback(chunk);
    ipcRenderer.on('e2e:log', listener);
    return () => ipcRenderer.removeListener('e2e:log', listener);
  },

  onStatus: (
    callback: (data: {
      status: 'idle' | 'running' | 'passed' | 'failed' | 'stopped';
      exitCode?: number | null;
    }) => void
  ) => {
    const listener = (
      _event: unknown,
      data: {
        status: 'idle' | 'running' | 'passed' | 'failed' | 'stopped';
        exitCode?: number | null;
      }
    ) => callback(data);
    ipcRenderer.on('e2e:status', listener);
    return () => ipcRenderer.removeListener('e2e:status', listener);
  },

  onCodeGenerated: (
    callback: (data: { filePath: string; code: string }) => void
  ) => {
    const listener = (
      _event: unknown,
      data: { filePath: string; code: string }
    ) => callback(data);
    ipcRenderer.on('e2e:code-generated', listener);
    return () => ipcRenderer.removeListener('e2e:code-generated', listener);
  },
});

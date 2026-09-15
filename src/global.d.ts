export {}
declare global {
  interface Window {
    zhuwen: {
      platform: string;
      invoke<T = unknown>(channel: string, payload?: unknown): Promise<T>;
      onAiChunk(handler: (data: any) => void): () => void;
      onAiDone(handler: (data: any) => void): () => void;
      onAiSession(handler: (data: any) => void): () => void;
      onAiConversations(handler: (data: any) => void): () => void;
      onSearchProgress(handler: (data: any) => void): () => void;
      onImportProgress(handler: (data: any) => void): () => void;
      onBeforeClose(handler: () => void): () => void;
    };
  }
}

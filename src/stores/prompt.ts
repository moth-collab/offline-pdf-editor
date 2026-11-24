/* Promise based in-app prompts (text / password input) */
import { create } from 'zustand';

export interface PromptRequest {
  title: string;
  message?: string;
  label?: string;
  password?: boolean;
  initial?: string;
  okLabel?: string;
  resolve: (v: string | null) => void;
}

interface PromptStore {
  current: PromptRequest | null;
  ask: (req: Omit<PromptRequest, 'resolve'>) => Promise<string | null>;
  finish: (v: string | null) => void;
}

export const usePrompt = create<PromptStore>((set, get) => ({
  current: null,
  ask: (req) =>
    new Promise((resolve) => {
      get().current?.resolve(null);
      set({ current: { ...req, resolve } });
    }),
  finish: (v) => {
    const cur = get().current;
    set({ current: null });
    cur?.resolve(v);
  },
}));

export const askText = (req: Omit<PromptRequest, 'resolve'>) => usePrompt.getState().ask(req);

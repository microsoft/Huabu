import { create } from 'zustand';

type PreviewState = {
  previewType: string | null;
  previewData: Record<string, unknown> | null;

  // Controls layout mode for the preview panel (Replace canvas or Split with canvas)
  expandMode: 'replace' | 'split';

  openPreview: (type: string, data: Record<string, unknown>) => void;
  closePreview: () => void;
  setExpandMode: (mode: 'replace' | 'split') => void;
};

export const usePreviewStore = create<PreviewState>((set) => ({
  previewType: null,
  previewData: null,
  expandMode: 'split',

  openPreview: (type, data) => set({ previewType: type, previewData: data }),
  closePreview: () => set({ previewType: null, previewData: null }),
  setExpandMode: (mode) => set({ expandMode: mode }),
}));

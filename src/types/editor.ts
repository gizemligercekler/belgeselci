export type WizardStep = 1 | 2 | 3;
export type ZoomDirection = 'uzaklas' | 'yakinlas';

export interface UploadedImage {
  id: string;
  orderNumber: number;
  filename: string;
  cleanTitle: string;
  objectUrl: string;
  file?: File;
}

export interface TranscriptSegment {
  startSec: number;
  endSec: number;
  text: string;
}

export interface TimelineScene {
  id: string;
  orderNumber: number;
  filename: string;
  cleanTitle: string;
  startSec: number;
  endSec: number;
  durationSec: number; // D_i = endSec - startSec
  renderDurationSec: number; // L_i = D_i + 1.0 (for i < N - 1), D_{N-1} for last clip
  zoomDirection: ZoomDirection;
  startScale: number; // Exact scale at t = 0 of clip L_i
  endScale: number; // Exact scale at t = L_i of clip
  matchedExcerpt: string;
}

export interface EditorSettings {
  model: string; // default 'gemini-3.8-flash'
  customApiKey: string; // optional single key override for local PC use
}

export interface ZoomSpeedPreset {
  id: string;
  label: string;
  speedPerSec: number; // decimal per second, e.g. 0.0025 = 0.25%/sn
  pctLabel: string;
}

export const ZOOM_SPEED_PRESETS: ZoomSpeedPreset[] = [
  { id: 'very_slow', label: 'Çok Yavaş', speedPerSec: 0.0015, pctLabel: '%0.15/sn' },
  { id: 'slow', label: 'Yavaş', speedPerSec: 0.0025, pctLabel: '%0.25/sn' },
  { id: 'medium', label: 'Orta', speedPerSec: 0.0035, pctLabel: '%0.35/sn' },
  { id: 'fast', label: 'Hızlı', speedPerSec: 0.005, pctLabel: '%0.50/sn' },
  { id: 'very_fast', label: 'Çok Hızlı', speedPerSec: 0.0075, pctLabel: '%0.75/sn' },
];

export const DEFAULT_ZOOM_SPEED_PER_SEC = 0.0025; // Yavaş %0.25/sn
export const FIXED_DISSOLVE_SEC = 1.0;
export const MIN_SCENE_DURATION_SEC = 2.0;

export const DEFAULT_EDITOR_SETTINGS: EditorSettings = {
  model: 'gemini-3.8-flash',
  customApiKey: '',
};

export interface PersistedSession {
  audioFileName: string;
  totalAudioDuration: number;
  zoomSpeedPerSec: number;
  transcriptSegments: TranscriptSegment[];
  scenes: TimelineScene[];
  settings: EditorSettings;
}

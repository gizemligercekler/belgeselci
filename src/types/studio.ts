export type TierMode = 'free' | 'paid';
export type VisualWorkflowMode = 'manual_free' | 'auto_api';
export type ImageResolution = '1K' | '2K' | '4K';
export type MediaType = 'ai_image' | 'stock_video';
export type KenBurnsEffect = 'zoom_in' | 'zoom_out' | 'pan_left' | 'pan_right' | 'none';
export type OverlayKind = 'none' | 'bolum' | 'ayet' | 'etiket';
export type WizardStep = 1 | 2 | 3 | 4 | 5 | 6;

export interface StudioSettings {
  tierMode: TierMode;
  freeApiKeysText: string; // Multi-line Gemini API keys for Free Tier 429 rotation
  paidApiKey: string; // Optional Paid Tier Gemini API key
  pexelsApiKey: string; // Optional Pexels API key
  rpmRetryWaitSec: number; // default 25
  interRequestDelaySec: number; // default 2 (free) or 0.2 (paid)

  // Models (editable)
  scriptModel: string; // default 'gemini-3.8-flash'
  ttsModel: string; // default 'gemini-3.8-flash-tts'
  ttsVoice: string; // default 'Charon'
  ttsStylePrompt: string;
  imageModel: string; // default 'gemini-nano-banana-2.1' (optional paid)
  imageResolution: ImageResolution; // '1K' | '2K' | '4K'
  visualWorkflowMode: VisualWorkflowMode; // default 'manual_free'

  // TTS & Text processing
  maxChunkSize: number; // default 2500
  normalPauseMs: number; // default 400
  chapterPauseMs: number; // default 1200
  gentleNormalize: boolean; // default true (-16 LUFS + 10ms fade)
  excludeChapterPrefix: boolean; // default true (strip BÖLÜM X: / BÖLÜM iki:)
  speakBolumTag: boolean; // default true (speak title inside [[BOLUM: ...]])
}

export interface TopicBrief {
  topic: string;
  targetMinutes: number;
  toneAndAngle: string;
  sourceNotes: string;
}

export interface OutlineChapter {
  id: string;
  kind: 'cold_open' | 'chapter' | 'conclusion';
  number?: number;
  title: string;
  hook: string;
  summaryPoints: string;
  draftText: string;
  writtenAt?: number;
}

export interface DirectorOverlay {
  id: string;
  kind: 'bolum' | 'ayet' | 'etiket';
  label: string;
  text: string;
  rawTag: string;
  positionRatio: number; // 0..1 approximate offset within the chunk
}

export interface AudioChunk {
  id: string;
  index: number; // 1-based
  isChapterStart: boolean;
  chapterTitle: string;
  rawText: string;
  cleanedText: string;
  overlays: DirectorOverlay[];
  cacheHash: string; // SHA-256 of model|voice|style|cleanedText
  generatedHash?: string; // hash when audio was last generated
  audioBlobId?: string;
  durationSec?: number;
  status: 'idle' | 'generating' | 'ready' | 'cached' | 'error';
  errorMessage?: string;
}

export interface StoryboardScene {
  id: string;
  sceneNumber: number;
  chunkIndex: number; // 1-based chunk index
  excerpt: string;
  mediaType: MediaType;
  imagePrompt: string;
  stockQuery: string;
  overlayKind: OverlayKind;
  overlayLabel: string;
  overlayText: string;
  kenBurnsEffect: KenBurnsEffect;
  durationSec: number;
  visualBlobId?: string;
  visualMimeType?: string;
  visualFileName?: string;
  remoteVideoUrl?: string;
  remoteThumbnailUrl?: string;
  remoteAuthor?: string;
  status: 'idle' | 'generating' | 'ready' | 'error';
  errorMessage?: string;
}

export interface EditSettings {
  resolution: '1920x1080' | '3840x2160';
  fps: 24 | 30;
  transitionType: 'crossfade';
  transitionDurationSec: number; // default 0.8
  kenBurnsIntensity: number; // e.g. 1.08 (1.0 -> 1.08)
  targetSceneDurationSec: number; // default 18
  bgMusicFileName: string;
  bgMusicBlobId?: string;
  bgMusicVolumeDb: number; // default -22
  bgMusicAutoLoop: boolean; // default true
  overlayChapterPosition: 'bottom-left' | 'top-left';
  overlayChapterBgOpacity: number; // 0.78
  overlayVerseBgOpacity: number; // 0.82
  overlayAccentHex: string; // '#D99B26'
  useFasterWhisper: boolean; // optional in render_documentary.py
}

export interface ProjectRecord {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  activeStep: WizardStep;
  topicBrief: TopicBrief;
  outline: OutlineChapter[];
  rawScript: string;
  bannedCliches: string[];
  chunks: AudioChunk[];
  scenes: StoryboardScene[];
  editSettings: EditSettings;
  studioSettings: StudioSettings;
}

export interface PexelsVideoItem {
  id: number;
  duration: number;
  width: number;
  height: number;
  thumbnail: string;
  pexelsUrl: string;
  author: string;
  videoUrl: string;
  previewUrl: string;
}

export interface BatchProgressState {
  running: boolean;
  paused: boolean;
  total: number;
  completed: number;
  skipped: number;
  failed: number;
  currentLabel: string;
  activeKeyIndex?: number;
  totalKeys?: number;
  waitCountdownSec?: number;
  startedAt: number;
}

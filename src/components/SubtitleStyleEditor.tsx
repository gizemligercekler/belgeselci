import React from 'react';
import { Bold, Italic, Type } from 'lucide-react';
import {
  DEFAULT_SUBTITLE_STYLE,
  SubtitleBgMode,
  SubtitleFontFamily,
  SubtitlePosition,
  SubtitleStyleConfig,
} from '../types/editor';
import { formatDialogueSubtitleLine } from '../utils/mediaUtils';

export const SUBTITLE_FONT_OPTIONS: Array<{ value: SubtitleFontFamily; label: string; cssFamily: string }> = [
  { value: 'Georgia', label: 'Georgia (Tarihi Serif)', cssFamily: 'Georgia, serif' },
  { value: 'Times New Roman', label: 'Times New Roman (Klasik Serif)', cssFamily: '"Times New Roman", Times, serif' },
  { value: 'Arial', label: 'Arial (Temiz Sans)', cssFamily: 'Arial, Helvetica, sans-serif' },
  { value: 'Trebuchet MS', label: 'Trebuchet MS (Belgesel Sans)', cssFamily: '"Trebuchet MS", sans-serif' },
  { value: 'Verdana', label: 'Verdana (Geniş Okunaklı)', cssFamily: 'Verdana, Geneva, sans-serif' },
  { value: 'Calibri', label: 'Calibri (Modern Sans)', cssFamily: 'Calibri, "Segoe UI", sans-serif' },
  { value: 'Segoe UI', label: 'Segoe UI (Sade Sans)', cssFamily: '"Segoe UI", system-ui, sans-serif' },
];

export interface SubtitleStylePreset {
  id: string;
  label: string;
  config: SubtitleStyleConfig;
}

export const SUBTITLE_STYLE_PRESETS: SubtitleStylePreset[] = [
  {
    id: 'tarihi_kutu',
    label: 'Tarihi Belgesel',
    config: {
      ...DEFAULT_SUBTITLE_STYLE,
      fontName: 'Georgia',
      fontSize: 22,
      bold: false,
      italic: false,
      textColor: '#FEF3C7',
      backgroundMode: 'box',
      backgroundColor: '#000000',
      backgroundOpacity: 72,
      outlineWidth: 2,
      position: 'bottom',
    },
  },
  {
    id: 'altin_ayet',
    label: 'Altın İtalik',
    config: {
      ...DEFAULT_SUBTITLE_STYLE,
      fontName: 'Georgia',
      fontSize: 23,
      bold: false,
      italic: true,
      textColor: '#FDE68A',
      backgroundMode: 'box',
      backgroundColor: '#0B0F17',
      backgroundOpacity: 78,
      outlineWidth: 2,
      position: 'bottom',
    },
  },
  {
    id: 'klasik_sans',
    label: 'Net Beyaz Kutu',
    config: {
      ...DEFAULT_SUBTITLE_STYLE,
      fontName: 'Arial',
      fontSize: 21,
      bold: true,
      italic: false,
      textColor: '#FFFFFF',
      backgroundMode: 'box',
      backgroundColor: '#000000',
      backgroundOpacity: 75,
      outlineWidth: 2,
      position: 'bottom',
    },
  },
  {
    id: 'kutusuz_kontur',
    label: 'Kutusuz Kontur',
    config: {
      ...DEFAULT_SUBTITLE_STYLE,
      fontName: 'Trebuchet MS',
      fontSize: 24,
      bold: true,
      italic: false,
      textColor: '#FFFFFF',
      backgroundMode: 'outline',
      backgroundColor: '#000000',
      backgroundOpacity: 0,
      outlineWidth: 3,
      position: 'bottom',
    },
  },
];

const TEXT_COLOR_SWATCHES = [
  { hex: '#FFFFFF', label: 'Beyaz' },
  { hex: '#000000', label: 'Siyah' },
  { hex: '#94A3B8', label: 'Gri' },
  { hex: '#FACC15', label: 'Sarı' },
  { hex: '#FEF3C7', label: 'Sıcak Krem' },
  { hex: '#DC2626', label: 'Kırmızı' },
  { hex: '#2563EB', label: 'Mavi' },
  { hex: '#16A34A', label: 'Yeşil' },
  { hex: '#8B4513', label: 'Kahverengi' },
];

const BG_COLOR_SWATCHES = [
  { hex: '#000000', label: 'Siyah' },
  { hex: '#FFFFFF', label: 'Beyaz' },
  { hex: '#64748B', label: 'Gri' },
  { hex: '#DC2626', label: 'Kırmızı' },
  { hex: '#2563EB', label: 'Mavi' },
  { hex: '#16A34A', label: 'Yeşil' },
  { hex: '#78350F', label: 'Kahverengi' },
  { hex: '#FACC15', label: 'Sarı' },
  { hex: '#0B0F17', label: 'Gece Laciverti' },
];

function hexToRgba(hex: string, opacityPct: number): string {
  const clean = hex.replace('#', '');
  const full = clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean;
  const r = parseInt(full.slice(0, 2), 16) || 0;
  const g = parseInt(full.slice(2, 4), 16) || 0;
  const b = parseInt(full.slice(4, 6), 16) || 0;
  const a = Math.max(0, Math.min(1, opacityPct / 100));
  return `rgba(${r}, ${g}, ${b}, ${a.toFixed(2)})`;
}

export function getSubtitleCssFamily(fontName: SubtitleFontFamily): string {
  return SUBTITLE_FONT_OPTIONS.find((f) => f.value === fontName)?.cssFamily || 'Georgia, serif';
}

/**
 * Computes consistent CSS styles for rendering subtitles in both the live 16:9 preview box
 * and Step 2's full documentary preview player so browser preview matches render.py closely.
 */
export function getSubtitlePreviewPresentation(
  style: SubtitleStyleConfig,
  scaleFactor = 1
): {
  containerPositionClass: string;
  textStyle: React.CSSProperties;
} {
  const containerPositionClass =
    style.position === 'center'
      ? 'inset-y-0 flex items-center justify-center'
      : style.position === 'lower_mid'
        ? 'bottom-[16%] flex justify-center'
        : 'bottom-4 sm:bottom-6 flex justify-center';

  // ASS FontSize 22 at 1080p PlayResY~288 scales nicely around ~14-18px in preview, ~24px fullscreen
  const computedPx = Math.max(10, Math.round(style.fontSize * 0.78 * scaleFactor));
  const outlinePx = Math.max(1, Math.round(style.outlineWidth * 0.85 * scaleFactor));

  const textStyle: React.CSSProperties = {
    fontFamily: getSubtitleCssFamily(style.fontName),
    fontSize: `${computedPx}px`,
    fontWeight: style.bold ? 700 : 400,
    fontStyle: style.italic ? 'italic' : 'normal',
    color: style.textColor,
    lineHeight: 1.35,
  };

  if (style.backgroundMode === 'box') {
    textStyle.backgroundColor = hexToRgba(style.backgroundColor, style.backgroundOpacity);
    textStyle.padding = `${Math.round(5 * scaleFactor)}px ${Math.round(12 * scaleFactor)}px`;
    textStyle.borderRadius = '4px';
  } else if (style.backgroundMode === 'outline') {
    textStyle.backgroundColor = 'transparent';
    textStyle.padding = `${Math.round(2 * scaleFactor)}px ${Math.round(6 * scaleFactor)}px`;
    textStyle.textShadow = [
      `-${outlinePx}px -${outlinePx}px 0 #000`,
      `${outlinePx}px -${outlinePx}px 0 #000`,
      `-${outlinePx}px ${outlinePx}px 0 #000`,
      `${outlinePx}px ${outlinePx}px 0 #000`,
      `0 ${outlinePx + 1}px ${outlinePx * 2}px rgba(0,0,0,0.85)`,
    ].join(', ');
  } else {
    textStyle.backgroundColor = 'transparent';
    textStyle.padding = `${Math.round(2 * scaleFactor)}px ${Math.round(6 * scaleFactor)}px`;
    textStyle.textShadow = '0 1px 4px rgba(0,0,0,0.65)';
  }

  return { containerPositionClass, textStyle };
}

interface SubtitleStyleEditorProps {
  style: SubtitleStyleConfig;
  onChange: (next: SubtitleStyleConfig) => void;
  sampleSource?: string;
  sampleText?: string;
  showSourceToggle?: boolean;
  compact?: boolean;
}

export const SubtitleStyleEditor: React.FC<SubtitleStyleEditorProps> = ({
  style,
  onChange,
  sampleSource = 'Kral',
  sampleText = '"Bu topraklarda hakikat, kılıçtan daha uzun yaşar."',
  showSourceToggle = true,
  compact = false,
}) => {
  const update = (patch: Partial<SubtitleStyleConfig>) => {
    onChange({ ...style, ...patch });
  };

  const previewLine = formatDialogueSubtitleLine(
    { source: sampleSource, text: sampleText },
    style.includeSourcePrefix
  );

  const { containerPositionClass, textStyle } = getSubtitlePreviewPresentation(
    style,
    compact ? 0.92 : 1.0
  );

  return (
    <div className="space-y-4 rounded-md border border-white/[0.08] bg-[#0B0F17]/80 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-xs font-medium text-[#F1F5F9]">
          <Type className="h-3.5 w-3.5 text-[#D99B26]" />
          <span>Altyazı Görünümü &amp; Stil Ayarları (Render&apos;a Birebir Yansır)</span>
        </div>

        {/* Quick Presets */}
        <div className="flex flex-wrap items-center gap-1.5">
          {SUBTITLE_STYLE_PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              onClick={() =>
                onChange({
                  ...preset.config,
                  includeSourcePrefix: style.includeSourcePrefix,
                })
              }
              className="rounded border border-white/[0.08] bg-[#131924] px-2 py-1 text-[11px] text-[#CBD5E1] transition-colors hover:border-[#D99B26]/50 hover:text-[#F1F5F9]"
            >
              {preset.label}
            </button>
          ))}
        </div>
      </div>

      {/* Live 16:9 Documentary Preview Frame */}
      <div className="relative aspect-video w-full overflow-hidden rounded-md border border-white/[0.08] bg-gradient-to-b from-[#1A212E] via-[#12161F] to-[#080B10]">
        {/* Subtle documentary atmospheric backdrop gradient */}
        <div
          className="pointer-events-none absolute inset-0 opacity-60"
          style={{
            background:
              'radial-gradient(ellipse at 50% 35%, rgba(217, 155, 38, 0.14) 0%, rgba(15, 23, 42, 0.2) 55%, rgba(0, 0, 0, 0.78) 100%)',
          }}
        />
        <span className="pointer-events-none absolute left-3 top-2.5 font-mono text-[10px] tracking-wider text-white/35">
          16:9 1080p CANLI ÖNİZLEME
        </span>
        <div className={`pointer-events-none absolute inset-x-4 ${containerPositionClass}`}>
          <p className="max-w-[88%] text-center" style={textStyle}>
            {previewLine}
          </p>
        </div>
      </div>

      {/* Controls Grid */}
      <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2 lg:grid-cols-3">
        {/* Font Family */}
        <div className="space-y-1">
          <label className="block text-[11px] font-medium text-[#94A3B8]">Yazı Tipi (Font)</label>
          <select
            value={style.fontName}
            onChange={(e) => update({ fontName: e.target.value as SubtitleFontFamily })}
            className="w-full rounded-md border border-white/[0.1] bg-[#131924] px-2.5 py-1.5 text-xs text-[#F1F5F9] focus:border-[#D99B26]/60 focus:outline-none"
          >
            {SUBTITLE_FONT_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>

        {/* Font Size */}
        <div className="space-y-1">
          <div className="flex items-center justify-between text-[11px]">
            <label className="font-medium text-[#94A3B8]">Yazı Büyüklüğü</label>
            <span className="font-mono tabular-nums text-[#D99B26]">{style.fontSize} pt</span>
          </div>
          <input
            type="range"
            min={16}
            max={34}
            step={1}
            value={style.fontSize}
            onChange={(e) => update({ fontSize: Number(e.target.value) })}
            className="mt-1.5 w-full accent-[#D99B26]"
          />
        </div>

        {/* Bold / Italic + Position */}
        <div className="space-y-1">
          <label className="block text-[11px] font-medium text-[#94A3B8]">Stil &amp; Konum</label>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => update({ bold: !style.bold })}
              title="Kalın"
              className={`flex h-8 w-8 items-center justify-center rounded-md border text-xs transition-colors ${
                style.bold
                  ? 'border-[#D99B26]/60 bg-[#D99B26]/20 text-[#F1F5F9]'
                  : 'border-white/[0.1] bg-[#131924] text-[#94A3B8] hover:text-[#F1F5F9]'
              }`}
            >
              <Bold className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={() => update({ italic: !style.italic })}
              title="İtalik"
              className={`flex h-8 w-8 items-center justify-center rounded-md border text-xs transition-colors ${
                style.italic
                  ? 'border-[#D99B26]/60 bg-[#D99B26]/20 text-[#F1F5F9]'
                  : 'border-white/[0.1] bg-[#131924] text-[#94A3B8] hover:text-[#F1F5F9]'
              }`}
            >
              <Italic className="h-3.5 w-3.5" />
            </button>
            <select
              value={style.position}
              onChange={(e) => update({ position: e.target.value as SubtitlePosition })}
              className="h-8 flex-1 rounded-md border border-white/[0.1] bg-[#131924] px-2 text-xs text-[#F1F5F9] focus:border-[#D99B26]/60 focus:outline-none"
            >
              <option value="bottom">Alt</option>
              <option value="lower_mid">Alt-Orta</option>
              <option value="center">Ekran Ortası</option>
            </select>
          </div>
        </div>

        {/* Text Color */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-[11px]">
            <label className="font-medium text-[#94A3B8]">Yazı Rengi</label>
            <span className="font-mono text-[10px] uppercase text-[#64748B]">{style.textColor}</span>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {TEXT_COLOR_SWATCHES.map((sw) => (
              <button
                key={sw.hex}
                type="button"
                title={sw.label}
                onClick={() => update({ textColor: sw.hex })}
                className={`h-5 w-5 rounded border transition-transform ${
                  style.textColor.toUpperCase() === sw.hex
                    ? 'scale-110 border-[#D99B26] ring-1 ring-[#D99B26]'
                    : 'border-white/25 hover:scale-105'
                }`}
                style={{ backgroundColor: sw.hex }}
              />
            ))}
            <input
              type="color"
              title="Özel yazı rengi seç"
              aria-label="Özel yazı rengi"
              value={style.textColor}
              onChange={(e) => update({ textColor: e.target.value.toUpperCase() })}
              className="h-5 w-6 cursor-pointer rounded border border-white/20 bg-transparent"
            />
          </div>
        </div>

        {/* Background Mode */}
        <div className="space-y-1.5">
          <label className="block text-[11px] font-medium text-[#94A3B8]">Arka Plan</label>
          <div className="inline-flex w-full rounded-md border border-white/[0.1] bg-[#131924] p-0.5">
            {(
              [
                { id: 'box', label: 'Kutu' },
                { id: 'outline', label: 'Kontur' },
                { id: 'none', label: 'Yok' },
              ] as Array<{ id: SubtitleBgMode; label: string }>
            ).map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => update({ backgroundMode: m.id })}
                className={`flex-1 rounded px-2 py-1 text-[11px] font-medium transition-colors ${
                  style.backgroundMode === m.id
                    ? 'bg-[#D99B26]/20 text-[#F1F5F9]'
                    : 'text-[#94A3B8] hover:text-[#F1F5F9]'
                }`}
              >
                {m.label}
              </button>
            ))}
          </div>
        </div>

        {/* Background Color + Opacity OR Outline Width */}
        {style.backgroundMode === 'box' && (
          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-[11px]">
              <label className="font-medium text-[#94A3B8]">Kutu Rengi &amp; Opaklık</label>
              <span className="font-mono tabular-nums text-[#D99B26]">
                {style.backgroundColor} · %{style.backgroundOpacity}
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              {BG_COLOR_SWATCHES.map((sw) => (
                <button
                  key={sw.hex}
                  type="button"
                  title={sw.label}
                  onClick={() => update({ backgroundColor: sw.hex })}
                  className={`h-5 w-5 shrink-0 rounded border transition-transform ${
                    style.backgroundColor.toUpperCase() === sw.hex
                      ? 'scale-110 border-[#D99B26] ring-1 ring-[#D99B26]'
                      : 'border-white/25 hover:scale-105'
                  }`}
                  style={{ backgroundColor: sw.hex }}
                />
              ))}
              <input
                type="color"
                title="Özel kutu rengi seç"
                aria-label="Özel kutu rengi"
                value={style.backgroundColor}
                onChange={(e) => update({ backgroundColor: e.target.value.toUpperCase() })}
                className="h-5 w-6 shrink-0 cursor-pointer rounded border border-white/20 bg-transparent"
              />
            </div>
            <div className="flex items-center gap-2 pt-0.5">
              <span className="text-[10px] text-[#64748B]">Opaklık</span>
              <input
                type="range"
                aria-label="Kutu opaklığı"
                min={15}
                max={100}
                step={5}
                value={style.backgroundOpacity}
                onChange={(e) => update({ backgroundOpacity: Number(e.target.value) })}
                className="w-full accent-[#D99B26]"
              />
            </div>
          </div>
        )}

        {style.backgroundMode === 'outline' && (
          <div className="space-y-1">
            <div className="flex items-center justify-between text-[11px]">
              <label className="font-medium text-[#94A3B8]">Kontur Kalınlığı</label>
              <span className="font-mono tabular-nums text-[#D99B26]">{style.outlineWidth} px</span>
            </div>
            <input
              type="range"
              min={1}
              max={4}
              step={1}
              value={style.outlineWidth}
              onChange={(e) => update({ outlineWidth: Number(e.target.value) })}
              className="mt-1.5 w-full accent-[#D99B26]"
            />
          </div>
        )}
      </div>

      {/* Optional Source Prefix Toggle */}
      {showSourceToggle && (
        <div className="flex items-center justify-between border-t border-white/[0.06] pt-3">
          <div className="text-[11px] text-[#94A3B8]">
            Satır başında kaynak / ayet referansı göster (örn.{' '}
            <span className="font-mono text-[#CBD5E1]">Kral:</span>,{' '}
            <span className="font-mono text-[#CBD5E1]">Bakara: 15</span>,{' '}
            <span className="font-mono text-[#CBD5E1]">Matta 5:9</span>)
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={style.includeSourcePrefix}
            onClick={() => update({ includeSourcePrefix: !style.includeSourcePrefix })}
            className={`shrink-0 rounded-md border px-2.5 py-1 text-[11px] font-medium transition-colors ${
              style.includeSourcePrefix
                ? 'border-[#D99B26]/60 bg-[#D99B26]/15 text-[#F1F5F9]'
                : 'border-white/[0.1] bg-[#131924] text-[#94A3B8] hover:text-[#F1F5F9]'
            }`}
          >
            {style.includeSourcePrefix ? 'Kaynak Etiketi Açık' : 'Sadece Metin'}
          </button>
        </div>
      )}
    </div>
  );
};

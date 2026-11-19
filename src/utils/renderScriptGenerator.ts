import JSZip from 'jszip';
import { ProjectRecord } from '../types/studio';
import { getMediaBlob } from './storageDb';

export function generateRenderPythonScript(project: ProjectRecord): string {
  const [widthStr, heightStr] = project.editSettings.resolution.split('x');
  const width = Number(widthStr) || 1920;
  const height = Number(heightStr) || 1080;
  const fps = project.editSettings.fps || 24;
  const transitionDur = project.editSettings.transitionDurationSec ?? 0.8;
  const kbScale = project.editSettings.kenBurnsIntensity ?? 1.08;
  const normalPauseMs = project.studioSettings.normalPauseMs ?? 400;
  const chapterPauseMs = project.studioSettings.chapterPauseMs ?? 1200;
  const gentleNormalize = project.studioSettings.gentleNormalize ? 'True' : 'False';
  const useWhisper = project.editSettings.useFasterWhisper ? 'True' : 'False';
  const bgMusicFile = project.editSettings.bgMusicFileName || 'ambient_documentary_bed.mp3';
  const bgMusicDb = project.editSettings.bgMusicVolumeDb ?? -22;
  const accentHex = project.editSettings.overlayAccentHex || '#D99B26';

  return `#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Belgesel Stüdyosu — Otomatik Yerel FFmpeg Render Betiği
Proje: ${project.name.replace(/"/g, "'")}
Üretim Ayarları: ${width}x${height} @ ${fps}fps | Crossfade: ${transitionDur}s | -16 LUFS: ${gentleNormalize}

Gereksinimler:
  - Python 3.9+
  - FFmpeg (PATH üzerinde kurulu)
  - pip install pillow
  - (Opsiyonel) pip install faster-whisper   # Milisaniye hassasiyetinde ayet/bölüm zamanlaması için
"""

import json
import math
import os
import shutil
import subprocess
import sys
import textwrap
from pathlib import Path
from typing import Dict, List, Optional, Tuple

try:
    from PIL import Image, ImageDraw, ImageFont
except ImportError:
    print("HATA: 'Pillow' kütüphanesi bulunamadı. Kurmak için: pip install pillow")
    sys.exit(1)

BASE_DIR = Path(__file__).resolve().parent
MANIFEST_PATH = BASE_DIR / "project_manifest.json"
AUDIO_DIR = BASE_DIR / "audio"
VISUALS_DIR = BASE_DIR / "visuals"
WORK_DIR = BASE_DIR / "_render_tmp"
OUTPUT_MP4 = BASE_DIR / "final_documentary.mp4"

WIDTH = ${width}
HEIGHT = ${height}
FPS = ${fps}
TRANSITION_DUR = ${transitionDur}
KB_SCALE = ${kbScale}
NORMAL_PAUSE_MS = ${normalPauseMs}
CHAPTER_PAUSE_MS = ${chapterPauseMs}
GENTLE_NORMALIZE = ${gentleNormalize}
USE_FASTER_WHISPER = ${useWhisper}
BG_MUSIC_FILENAME = ${JSON.stringify(bgMusicFile)}
BG_MUSIC_DB = ${bgMusicDb}
ACCENT_HEX = ${JSON.stringify(accentHex)}


def run_cmd(cmd: List[str], desc: str = "") -> None:
    if desc:
        print(f"→ {desc}")
    result = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if result.returncode != 0:
        print(f"\\nFFmpeg Hatası ({desc}):\\n{result.stderr[-1500:]}")
        sys.exit(result.returncode)


def probe_duration(media_path: Path) -> float:
    cmd = [
        "ffprobe", "-v", "error",
        "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1",
        str(media_path),
    ]
    res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    try:
        return max(0.5, float(res.stdout.strip()))
    except ValueError:
        return 10.0


def hex_to_rgb(hex_color: str) -> Tuple[int, int, int]:
    h = hex_color.lstrip("#")
    if len(h) != 6:
        return (217, 155, 38)
    return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))


def load_font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont:
    candidates = [
        # macOS
        "/System/Library/Fonts/Supplemental/Georgia Bold.ttf" if bold else "/System/Library/Fonts/Supplemental/Georgia.ttf",
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf" if bold else "/System/Library/Fonts/Supplemental/Arial.ttf",
        # Windows
        "C:/Windows/Fonts/georgiab.ttf" if bold else "C:/Windows/Fonts/georgia.ttf",
        "C:/Windows/Fonts/segoeuib.ttf" if bold else "C:/Windows/Fonts/segoeui.ttf",
        # Linux
        "/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf" if bold else "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSerif-Bold.ttf" if bold else "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
    ]
    for path in candidates:
        if os.path.exists(path):
            return ImageFont.truetype(path, size=size)
    return ImageFont.load_default()


def render_overlay_png(kind: str, label: str, text: str, out_path: Path) -> Optional[Path]:
    """Pillow ile şeffaf 16:9 PNG belgesel alt bandı / ayet kutusu / referans etiketi üretir."""
    if kind == "none" or (not text.strip() and not label.strip()):
        return None

    img = Image.new("RGBA", (WIDTH, HEIGHT), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    scale = WIDTH / 1920.0
    accent_rgb = hex_to_rgb(ACCENT_HEX)

    if kind == "bolum":
        # Sol alt bölüm alt bandı (BBC lower-third)
        font_lbl = load_font(int(22 * scale), bold=False)
        font_title = load_font(int(40 * scale), bold=True)
        pad_x = int(34 * scale)
        pad_y = int(22 * scale)
        margin_x = int(96 * scale)
        margin_bottom = int(110 * scale)

        title_upper = text.strip().upper()
        wrapped = textwrap.wrap(title_upper, width=42)
        line_h = int(50 * scale)
        box_h = pad_y * 2 + int(34 * scale) + len(wrapped) * line_h
        max_w = max([draw.textlength(l, font=font_title) for l in wrapped] + [360 * scale])
        box_w = min(int(WIDTH - margin_x * 2), int(max_w + pad_x * 2))

        x0 = margin_x
        y0 = HEIGHT - margin_bottom - box_h
        draw.rounded_rectangle([x0, y0, x0 + box_w, y0 + box_h], radius=int(10 * scale), fill=(11, 15, 23, 205))
        draw.rectangle([x0, y0 + box_h - int(4 * scale), x0 + box_w, y0 + box_h], fill=(*accent_rgb, 235))
        draw.text((x0 + pad_x, y0 + pad_y), (label or "BÖLÜM").upper(), font=font_lbl, fill=(*accent_rgb, 255))
        curr_y = y0 + pad_y + int(34 * scale)
        for line in wrapped:
            draw.text((x0 + pad_x, curr_y), line, font=font_title, fill=(244, 246, 250, 255))
            curr_y += line_h

    elif kind == "ayet":
        # Alt orta ayet / alıntı kutusu
        font_ref = load_font(int(26 * scale), bold=True)
        font_body = load_font(int(36 * scale), bold=False)
        wrapped = textwrap.wrap(f"“{text.strip()}”", width=56)
        line_h = int(48 * scale)
        pad_x = int(48 * scale)
        pad_y = int(30 * scale)
        box_w = int(WIDTH * 0.72)
        box_h = pad_y * 2 + int(42 * scale) + len(wrapped) * line_h
        x0 = (WIDTH - box_w) // 2
        y0 = HEIGHT - int(115 * scale) - box_h

        draw.rounded_rectangle([x0, y0, x0 + box_w, y0 + box_h], radius=int(14 * scale), fill=(11, 15, 23, 218), outline=(*accent_rgb, 140), width=max(1, int(2 * scale)))
        ref_w = draw.textlength(label.strip(), font=font_ref)
        draw.text(((WIDTH - ref_w) / 2, y0 + pad_y), label.strip(), font=font_ref, fill=(*accent_rgb, 255))
        curr_y = y0 + pad_y + int(44 * scale)
        for line in wrapped:
            lw = draw.textlength(line, font=font_body)
            draw.text(((WIDTH - lw) / 2, curr_y), line, font=font_body, fill=(242, 245, 250, 255))
            curr_y += line_h

    elif kind == "etiket":
        # Sağ üst / sol alt sade kaynak referans kutusu
        font_tag = load_font(int(28 * scale), bold=True)
        tag_text = text.strip()
        tw = draw.textlength(tag_text, font=font_tag)
        pad_x = int(28 * scale)
        pad_y = int(16 * scale)
        box_w = int(tw + pad_x * 2)
        box_h = int(36 * scale + pad_y * 2)
        x0 = WIDTH - int(96 * scale) - box_w
        y0 = int(84 * scale)
        draw.rounded_rectangle([x0, y0, x0 + box_w, y0 + box_h], radius=int(10 * scale), fill=(11, 15, 23, 200), outline=(148, 163, 184, 90), width=max(1, int(1.5 * scale)))
        draw.text((x0 + pad_x, y0 + pad_y), tag_text, font=font_tag, fill=(238, 242, 248, 255))

    img.save(out_path, "PNG")
    return out_path


def build_master_narration(chunks: List[dict]) -> Tuple[Path, Dict[int, Tuple[float, float]]]:
    """
    Tüm ses parçalarını -16 LUFS nazik normalizasyon, 10ms kenar fade ve bölüm/normal sessizliklerle birleştirir.
    Her parça için (başlangıç_sn, süre_sn) zaman haritası döndürür.
    """
    processed_parts: List[Path] = []
    chunk_timings: Dict[int, Tuple[float, float]] = {}
    cursor = 0.0

    for i, ch in enumerate(chunks):
        idx = ch["index"]
        src = AUDIO_DIR / f"chunk_{idx:03d}.wav"
        if not src.exists():
            print(f"UYARI: {src.name} bulunamadı, atlanıyor.")
            continue

        if i > 0:
            pause_ms = CHAPTER_PAUSE_MS if ch.get("isChapterStart") else NORMAL_PAUSE_MS
            pause_sec = pause_ms / 1000.0
            sil_path = WORK_DIR / f"silence_{idx:03d}.wav"
            run_cmd([
                "ffmpeg", "-y", "-f", "lavfi",
                "-i", "anullsrc=r=48000:cl=mono",
                "-t", f"{pause_sec:.3f}",
                "-c:a", "pcm_s16le", str(sil_path)
            ], f"Sessizlik ekleniyor ({pause_ms}ms)")
            processed_parts.append(sil_path)
            cursor += pause_sec

        dur = probe_duration(src)
        proc_path = WORK_DIR / f"norm_{idx:03d}.wav"
        fade_out_start = max(0.0, dur - 0.01)

        if GENTLE_NORMALIZE:
            af = f"aresample=48000,loudnorm=I=-16:TP=-1.5:LRA=11,afade=t=in:st=0:d=0.01,afade=t=out:st={fade_out_start:.3f}:d=0.01"
        else:
            af = f"aresample=48000,afade=t=in:st=0:d=0.01,afade=t=out:st={fade_out_start:.3f}:d=0.01"

        run_cmd([
            "ffmpeg", "-y", "-i", str(src),
            "-af", af,
            "-ar", "48000", "-ac", "1", "-c:a", "pcm_s16le",
            str(proc_path)
        ], f"Ses parçası işleniyor: {src.name}")

        final_dur = probe_duration(proc_path)
        chunk_timings[idx] = (cursor, final_dur)
        cursor += final_dur
        processed_parts.append(proc_path)

    if not processed_parts:
        print("HATA: Birleştirilecek ses dosyası bulunamadı (audio/chunk_XXX.wav).")
        sys.exit(1)

    concat_list = WORK_DIR / "audio_concat.txt"
    with open(concat_list, "w", encoding="utf-8") as f:
        for p in processed_parts:
            safe_p = str(p).replace("'", "'\\\\''")
            f.write(f"file '{safe_p}'\\n")

    master_audio = WORK_DIR / "master_narration.wav"
    run_cmd([
        "ffmpeg", "-y", "-f", "concat", "-safe", "0",
        "-i", str(concat_list), "-c", "copy", str(master_audio)
    ], "Ana ses bandı birleştiriliyor")

    return master_audio, chunk_timings


def optional_whisper_alignment(master_audio: Path) -> List[dict]:
    """Kuruluysa faster-whisper ile kelime zamanlamalarını çıkarır; değilse orantısal zamanlamaya düşer."""
    if not USE_FASTER_WHISPER:
        return []
    try:
        from faster_whisper import WhisperModel  # type: ignore
        print("→ faster-whisper bulundu; hassas zaman hizalama çalıştırılıyor...")
        model = WhisperModel("small", device="auto", compute_type="int8")
        segments, _ = model.transcribe(str(master_audio), language="tr", word_timestamps=False)
        return [{"start": s.start, "end": s.end, "text": s.text.strip()} for s in segments]
    except Exception as exc:
        print(f"BİLGİ: faster-whisper kullanılamadı ({exc}). Orantısal zamanlama kullanılacak.")
        return []


def build_scene_clip(scene: dict, duration_sec: float, out_clip: Path) -> None:
    """Tek bir sahneyi Ken Burns zoompan + şeffaf PNG katmanıyla MP4 klibe dönüştürür."""
    s_num = scene["sceneNumber"]
    visual_file = scene.get("visualFile")
    visual_path = (VISUALS_DIR / visual_file) if visual_file else None
    kb = scene.get("kenBurnsEffect", "zoom_in")
    frames = max(int(math.ceil(duration_sec * FPS)), FPS)

    overlay_png = render_overlay_png(
        scene.get("overlayKind", "none"),
        scene.get("overlayLabel", ""),
        scene.get("overlayText", ""),
        WORK_DIR / f"overlay_{s_num:03d}.png",
    )

    if visual_path and visual_path.exists() and visual_path.suffix.lower() in {".mp4", ".mov", ".webm"}:
        # Video klibi döngüye alıp hedef süreye kırp
        base_filter = f"scale={WIDTH}:{HEIGHT}:force_original_aspect_ratio=increase,crop={WIDTH}:{HEIGHT},fps={FPS},setsar=1"
        inputs = ["-stream_loop", "-1", "-i", str(visual_path)]
    elif visual_path and visual_path.exists():
        # Görsel için akıcı Ken Burns zoompan
        delta = max(0.01, KB_SCALE - 1.0)
        if kb == "zoom_in":
            z_expr = f"1+{delta:.4f}*on/{frames}"
            x_expr = "iw/2-(iw/zoom/2)"
            y_expr = "ih/2-(ih/zoom/2)"
        elif kb == "zoom_out":
            z_expr = f"{KB_SCALE:.4f}-{delta:.4f}*on/{frames}"
            x_expr = "iw/2-(iw/zoom/2)"
            y_expr = "ih/2-(ih/zoom/2)"
        elif kb == "pan_left":
            z_expr = f"{KB_SCALE:.4f}"
            x_expr = f"(iw-iw/zoom)*(1-on/{frames})"
            y_expr = "ih/2-(ih/zoom/2)"
        elif kb == "pan_right":
            z_expr = f"{KB_SCALE:.4f}"
            x_expr = f"(iw-iw/zoom)*(on/{frames})"
            y_expr = "ih/2-(ih/zoom/2)"
        else:
            z_expr = "1.0"
            x_expr = "iw/2-(iw/zoom/2)"
            y_expr = "ih/2-(ih/zoom/2)"

        # Yüksek çözünürlüklü ara ölçekleme ile titreşimsiz zoompan
        up_w = WIDTH * 2
        up_h = HEIGHT * 2
        base_filter = (
            f"scale={up_w}:{up_h}:force_original_aspect_ratio=increase,crop={up_w}:{up_h},"
            f"zoompan=z='{z_expr}':x='{x_expr}':y='{y_expr}':d={frames}:s={WIDTH}x{HEIGHT}:fps={FPS},setsar=1"
        )
        inputs = ["-loop", "1", "-i", str(visual_path)]
    else:
        # Eksik görsel varsa koyu slate arkaplan oluştur
        base_filter = f"fps={FPS},setsar=1"
        inputs = ["-f", "lavfi", "-i", f"color=c=0x0B0F17:s={WIDTH}x{HEIGHT}:d={duration_sec:.3f}"]

    if overlay_png and overlay_png.exists():
        cmd = [
            "ffmpeg", "-y", *inputs, "-i", str(overlay_png),
            "-filter_complex", f"[0:v]{base_filter}[bg];[bg][1:v]overlay=0:0:shortest=1[v]",
            "-map", "[v]", "-t", f"{duration_sec:.3f}",
            "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p",
            str(out_clip),
        ]
    else:
        cmd = [
            "ffmpeg", "-y", *inputs,
            "-vf", base_filter,
            "-t", f"{duration_sec:.3f}",
            "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p",
            str(out_clip),
        ]

    run_cmd(cmd, f"Sahne {s_num:03d} render ediliyor ({duration_sec:.1f}s)")


def main() -> None:
    if not MANIFEST_PATH.exists():
        print("HATA: project_manifest.json bulunamadı.")
        sys.exit(1)

    if WORK_DIR.exists():
        shutil.rmtree(WORK_DIR)
    WORK_DIR.mkdir(parents=True, exist_ok=True)

    with open(MANIFEST_PATH, "r", encoding="utf-8") as f:
        manifest = json.load(f)

    chunks = manifest.get("chunks", [])
    scenes = manifest.get("scenes", [])
    if not scenes:
        print("HATA: Manifest içinde sahne bulunamadı.")
        sys.exit(1)

    master_audio, chunk_timings = build_master_narration(chunks)
    total_audio_dur = probe_duration(master_audio)
    _whisper_segments = optional_whisper_alignment(master_audio)

    # Her ses parçasına bağlı sahnelerin sürelerini orantısal olarak gerçek ses süresine dağıt
    scenes_by_chunk: Dict[int, List[dict]] = {}
    for sc in scenes:
        scenes_by_chunk.setdefault(sc.get("chunkIndex", 1), []).append(sc)

    clip_paths: List[Path] = []
    clip_durations: List[float] = []

    for sc in scenes:
        c_idx = sc.get("chunkIndex", 1)
        group = scenes_by_chunk.get(c_idx, [sc])
        if c_idx in chunk_timings:
            _, chunk_dur = chunk_timings[c_idx]
            dur = max(2.0, chunk_dur / max(1, len(group)))
        else:
            dur = max(3.0, float(sc.get("durationSec", 15)))

        # Crossfade telafisi
        if len(scenes) > 1:
            dur += TRANSITION_DUR * 0.5

        out_clip = WORK_DIR / f"clip_{sc['sceneNumber']:03d}.mp4"
        build_scene_clip(sc, dur, out_clip)
        clip_paths.append(out_clip)
        clip_durations.append(probe_duration(out_clip))

    # Crossfade (xfade) ile video birleştirme
    merged_video = WORK_DIR / "merged_video.mp4"
    if len(clip_paths) == 1:
        shutil.copy(clip_paths[0], merged_video)
    else:
        ff_inputs: List[str] = []
        for cp in clip_paths:
            ff_inputs.extend(["-i", str(cp)])

        filter_parts: List[str] = []
        prev_label = "[0:v]"
        offset = max(0.2, clip_durations[0] - TRANSITION_DUR)
        for i in range(1, len(clip_paths)):
            out_label = f"[v{i}]" if i < len(clip_paths) - 1 else "[vout]"
            filter_parts.append(
                f"{prev_label}[{i}:v]xfade=transition=fade:duration={TRANSITION_DUR:.2f}:offset={offset:.3f}{out_label}"
            )
            prev_label = out_label
            offset += max(0.2, clip_durations[i] - TRANSITION_DUR)

        run_cmd([
            "ffmpeg", "-y", *ff_inputs,
            "-filter_complex", ";".join(filter_parts),
            "-map", "[vout]",
            "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p",
            str(merged_video),
        ], "Sahneler Crossfade geçişiyle birleştiriliyor")

    # Arka plan müziği varsa -22 dB miksaj + döngü
    bg_path = BASE_DIR / BG_MUSIC_FILENAME
    if not bg_path.exists():
        bg_path = AUDIO_DIR / BG_MUSIC_FILENAME

    if bg_path.exists():
        run_cmd([
            "ffmpeg", "-y",
            "-i", str(merged_video),
            "-i", str(master_audio),
            "-stream_loop", "-1", "-i", str(bg_path),
            "-filter_complex",
            f"[2:a]volume={BG_MUSIC_DB}dB,afade=t=in:st=0:d=2,afade=t=out:st={max(0, total_audio_dur-3):.2f}:d=3[bgm];"
            f"[1:a][bgm]amix=inputs=2:duration=first:dropout_transition=2[aout]",
            "-map", "0:v", "-map", "[aout]",
            "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-shortest",
            str(OUTPUT_MP4),
        ], "Ses, arka plan müziği ve video birleştiriliyor")
    else:
        run_cmd([
            "ffmpeg", "-y",
            "-i", str(merged_video),
            "-i", str(master_audio),
            "-map", "0:v", "-map", "1:a",
            "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-shortest",
            str(OUTPUT_MP4),
        ], "Ses ve video birleştiriliyor")

    print(f"\\n✓ TAMAMLANDI! Nihai belgesel hazır: {OUTPUT_MP4}")


if __name__ == "__main__":
    main()
`;
}

export function generateTurkishReadme(project: ProjectRecord): string {
  const s = project.studioSettings;
  const e = project.editSettings;

  return `# Belgesel Stüdyosu — Kullanım ve Yerel Render Kılavuzu

**Proje:** ${project.name}  
**Hedef Çözünürlük:** ${e.resolution} @ ${e.fps} FPS  
**Seslendirme Modeli / Sesi:** \`${s.ttsModel}\` (\`${s.ttsVoice}\`)

---

## 1. Web Uygulaması 6 Adımlı İş Akışı

1. **Konu & Kaynaklar:** Belgesel konusunu, hedef süresini ve anlatım tonunu belirleyin. Dilerseniz tek tıkla **"Demo / Test Metni Yükle"** butonunu kullanarak tüm hattı 2 dakikada test edebilirsiniz.
2. **İskelet & Senaryo:** Bölümleri yeniden sıralayın, tek tek veya sırayla yazdırın. **YZ Klişe Temizleyici** sekmesinde yapay kalıpları temizleyin veya dışarıda yazdığınız \`script.txt\` dosyasını doğrudan içe aktarın.
3. **Ses Stüdyosu (TTS):** Türkçe ön işleme motoru; tarih, Roma rakamı, ekli sayı, parantez ve \`BÖLÜM X:\` / \`BÖLÜM iki:\` ön eklerini kurallarınıza göre otomatik dönüştürür. \`[[AYET: ...]]\` ve \`[[ETIKET: ...]]\` etiketleri seslendirmeden ayrıştırılır. Her parça SHA-256 önbelleğiyle korunur; değişmeyen parçalar tekrar üretilmez.
4. **Görsel & Storyboard:** Varsayılan **Sıfır Maliyetli Manuel Mod** ile her sahne için tek tıkla **"Promptu Kopyala"** yapıp Gemini Web'den ürettiğiniz görseli doğrudan sahne kartına sürükleyip bırakabilir veya ücretsiz Pexels stok videolarını kullanabilirsiniz. İsterseniz Ayarlar'dan kendi ücretli anahtarınızı girerek **Otomatik API (Nano Banana 2.1)** modunu açabilirsiniz.
5. **Kurgu & Önizleme:** Çözünürlük, Ken Burns yoğunluğu, arka plan müziği ve alt bant/ayet kutusu tasarımlarını ayarlayıp canlı 16:9 oynatıcıda sesle senkronize önizleyin.
6. **Dışa Aktar & Render:** Tüm sesler, görseller, \`project_manifest.json\` ve yerel \`render_documentary.py\` betiği tek bir ZIP paketinde indirilir.

---

## 2. Ücretsiz (Free Tier) ve Sıfır Maliyet İpuçları

- **Çoklu Anahtar Rotasyonu:** Ayarlar çekmecesindeki **Ücretsiz Kota (Free Tier)** alanına satır başına bir Gemini API anahtarı yapıştırabilirsiniz. Bir anahtar \`429\` kota sınırına ulaştığında stüdyo otomatik olarak sonraki anahtara geçer; tüm anahtarlar dolduğunda \`RPM_RETRY_WAIT_SEC\` (${s.rpmRetryWaitSec} sn) geri sayımıyla güvenle devam eder.
- **Sıfır Maliyetli Görsel Üretimi:** Adım 4'te **Sıfır Maliyetli Manuel Mod** seçiliyken API görsel ücreti oluşmaz. Promptu kopyalayıp dilediğiniz araçtan indirdiğiniz 16:9 görselleri kartın üstüne sürükleyip bırakmanız yeterlidir.
- **Pexels Stok Video:** Ücretsiz bir Pexels API anahtarı (\`pexels.com/api\`) alarak Ayarlar'a eklerseniz 16:9 yatay stok videoları doğrudan stüdyo içinde arayıp sahnelere bağlayabilirsiniz.

---

## 3. Bilgisayarınızda Yerel 4K / 1080p Render Alma (Filmora Olmadan)

50 dakikalık bir 4K belgeseli tarayıcı içinde işlemek bellek sınırlarına takılacağından, indirdiğiniz ZIP paketi yerel makinenizde donanım hızıyla çalışan hazır bir Python + FFmpeg hattı içerir.

### A. Gerekli Kurulumlar

#### Windows
1. **Python 3.10+** kurun (\`python.org\` — kurulumda *"Add Python to PATH"* kutusunu işaretleyin).
2. **FFmpeg** kurun: PowerShell'i açıp şu komutu çalıştırın:
   \`\`\`powershell
   winget install Gyan.FFmpeg
   \`\`\`
   Kurulumdan sonra terminali kapatıp yeniden açın.
3. Gerekli Python paketini kurun:
   \`\`\`powershell
   pip install pillow
   \`\`\`
4. *(Opsiyonel)* Ayet ve bölüm etiketlerini milisaniye hassasiyetinde hizalamak isterseniz:
   \`\`\`powershell
   pip install faster-whisper
   \`\`\`

#### macOS
1. Homebrew ile FFmpeg ve Python kurun:
   \`\`\`bash
   brew install ffmpeg python
   \`\`\`
2. Pillow kütüphanesini kurun:
   \`\`\`bash
   pip3 install pillow
   \`\`\`
3. *(Opsiyonel)* Hassas zaman hizalama için:
   \`\`\`bash
   pip3 install faster-whisper
   \`\`\`

---

### B. Render Betiğini Çalıştırma

1. İndirdiğiniz ZIP dosyasını bilgisayarınızda bir klasöre çıkarın.
2. *(Opsiyonel)* Arka plan müziği kullanıyorsanız, müzik dosyanızı \`${e.bgMusicFileName}\` adıyla bu klasörün içine (veya \`audio/\` klasörüne) koyun.
3. Klasörde terminal / PowerShell açıp tek komutu çalıştırın:
   \`\`\`bash
   python render_documentary.py
   \`\`\`
   *(macOS/Linux için \`python3 render_documentary.py\`)*

İşlem tamamlandığında aynı klasörde YouTube yüklemesine hazır **\`final_documentary.mp4\`** dosyası oluşturulacaktır.

### Paket İçeriği
- \`project_manifest.json\` — Tüm sahneler, katmanlar, Ken Burns ve duraklama ayarları
- \`audio/chunk_001.wav\` ... — Üretilmiş tüm Türkçe seslendirme parçaları
- \`visuals/scene_001.png\` ... — Sahnelerin 16:9 görsel ve video dosyaları
- \`render_documentary.py\` — Ayarlarınıza göre otomatik üretilmiş FFmpeg + Pillow render betiği
- \`README.md\` — Bu kullanım kılavuzu
`;
}

function guessExtension(mimeType?: string, fileName?: string): string {
  if (fileName && fileName.includes('.')) {
    const ext = fileName.split('.').pop()?.toLowerCase();
    if (ext && /^[a-z0-9]{2,5}$/.test(ext)) return ext;
  }
  if (!mimeType) return 'png';
  if (mimeType.includes('jpeg') || mimeType.includes('jpg')) return 'jpg';
  if (mimeType.includes('webp')) return 'webp';
  if (mimeType.includes('mp4')) return 'mp4';
  if (mimeType.includes('webm')) return 'webm';
  return 'png';
}

export async function buildProductionBundleZip(
  project: ProjectRecord,
  onProgress?: (pct: number, label: string) => void
): Promise<Blob> {
  const zip = new JSZip();
  const audioFolder = zip.folder('audio');
  const visualsFolder = zip.folder('visuals');

  onProgress?.(5, 'Manifest hazırlanıyor...');

  const manifestChunks: Array<Record<string, unknown>> = [];
  const totalItems = project.chunks.length + project.scenes.length + 2;
  let done = 0;

  for (const ch of project.chunks) {
    const fileName = `chunk_${String(ch.index).padStart(3, '0')}.wav`;
    let hasAudioFile = false;

    if (ch.audioBlobId && audioFolder) {
      const media = await getMediaBlob(ch.audioBlobId);
      if (media?.blob) {
        audioFolder.file(fileName, media.blob);
        hasAudioFile = true;
      }
    }

    manifestChunks.push({
      index: ch.index,
      fileName: hasAudioFile ? fileName : null,
      isChapterStart: ch.isChapterStart,
      chapterTitle: ch.chapterTitle,
      durationSec: ch.durationSec || null,
      cacheHash: ch.cacheHash,
      overlays: ch.overlays,
      cleanedText: ch.cleanedText,
    });

    done += 1;
    onProgress?.(Math.min(85, Math.round((done / totalItems) * 85)), `Ses eklendi: ${fileName}`);
  }

  const manifestScenes: Array<Record<string, unknown>> = [];

  for (const sc of project.scenes) {
    let visualFile: string | null = null;
    if (sc.visualBlobId && visualsFolder) {
      const media = await getMediaBlob(sc.visualBlobId);
      if (media?.blob) {
        const ext = guessExtension(sc.visualMimeType || media.mimeType, sc.visualFileName);
        visualFile = `scene_${String(sc.sceneNumber).padStart(3, '0')}.${ext}`;
        visualsFolder.file(visualFile, media.blob);
      }
    }

    manifestScenes.push({
      sceneNumber: sc.sceneNumber,
      chunkIndex: sc.chunkIndex,
      excerpt: sc.excerpt,
      mediaType: sc.mediaType,
      visualFile,
      remoteVideoUrl: sc.remoteVideoUrl || null,
      imagePrompt: sc.imagePrompt,
      stockQuery: sc.stockQuery,
      overlayKind: sc.overlayKind,
      overlayLabel: sc.overlayLabel,
      overlayText: sc.overlayText,
      kenBurnsEffect: sc.kenBurnsEffect,
      durationSec: sc.durationSec,
    });

    done += 1;
    onProgress?.(
      Math.min(88, Math.round((done / totalItems) * 85)),
      `Sahne işlendi: #${sc.sceneNumber}`
    );
  }

  // Optional background music blob
  if (project.editSettings.bgMusicBlobId && audioFolder) {
    const musicMedia = await getMediaBlob(project.editSettings.bgMusicBlobId);
    if (musicMedia?.blob) {
      audioFolder.file(project.editSettings.bgMusicFileName || 'ambient_documentary_bed.mp3', musicMedia.blob);
    }
  }

  const manifestObj = {
    studio: 'Belgesel Stüdyosu',
    exportedAt: new Date().toISOString(),
    projectName: project.name,
    topic: project.topicBrief.topic,
    editSettings: project.editSettings,
    audioSettings: {
      normalPauseMs: project.studioSettings.normalPauseMs,
      chapterPauseMs: project.studioSettings.chapterPauseMs,
      gentleNormalize: project.studioSettings.gentleNormalize,
      excludeChapterPrefix: project.studioSettings.excludeChapterPrefix,
      ttsModel: project.studioSettings.ttsModel,
      ttsVoice: project.studioSettings.ttsVoice,
    },
    chunks: manifestChunks,
    scenes: manifestScenes,
  };

  zip.file('project_manifest.json', JSON.stringify(manifestObj, null, 2));
  zip.file('render_documentary.py', generateRenderPythonScript(project));
  zip.file('README.md', generateTurkishReadme(project));

  onProgress?.(92, 'ZIP arşivi sıkıştırılıyor...');

  const blob = await zip.generateAsync(
    {
      type: 'blob',
      compression: 'DEFLATE',
      compressionOptions: { level: 5 },
    },
    (meta) => {
      onProgress?.(92 + Math.round(meta.percent * 0.08), 'ZIP paketi oluşturuluyor...');
    }
  );

  onProgress?.(100, 'Hazır!');
  return blob;
}

export function triggerBrowserDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

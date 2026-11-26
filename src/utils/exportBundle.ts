import JSZip from 'jszip';
import { FIXED_DISSOLVE_SEC, TimelineScene, TranscriptSegment } from '../types/editor';
import { formatMMSS, formatZoomSpeedPct } from './timelineMath';
import { segmentsToSrt } from './mediaUtils';

export interface ExportTimelinePayload {
  audioFile: string;
  totalAudioDuration: number;
  zoomSpeedPerSec: number;
  dissolveDurationSec: number;
  resolution: '1920x1080';
  fps: 30;
  burnSubtitles: boolean;
  subtitleFile: string | null;
  scenes: Array<{
    orderNumber: number;
    filename: string;
    cleanTitle: string;
    startSec: number;
    endSec: number;
    durationSec: number;
    renderDurationSec: number;
    zoomDirection: 'uzaklas' | 'yakinlas';
    startScale: number;
    endScale: number;
    matchedExcerpt: string;
  }>;
}

export function buildTimelineJson(
  audioFileName: string,
  totalAudioDuration: number,
  zoomSpeedPerSec: number,
  scenes: TimelineScene[],
  burnSubtitles = false
): ExportTimelinePayload {
  return {
    audioFile: audioFileName,
    totalAudioDuration,
    zoomSpeedPerSec,
    dissolveDurationSec: FIXED_DISSOLVE_SEC,
    resolution: '1920x1080',
    fps: 30,
    burnSubtitles,
    subtitleFile: burnSubtitles ? 'subtitles.srt' : null,
    scenes: scenes.map((sc) => ({
      orderNumber: sc.orderNumber,
      filename: sc.filename,
      cleanTitle: sc.cleanTitle,
      startSec: sc.startSec,
      endSec: sc.endSec,
      durationSec: sc.durationSec,
      renderDurationSec: sc.renderDurationSec,
      zoomDirection: sc.zoomDirection,
      startScale: sc.startScale,
      endScale: sc.endScale,
      matchedExcerpt: sc.matchedExcerpt,
    })),
  };
}

export function generateRenderPy(): string {
  return `#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Belgesel Kurgu Asistani — 16:9 1080p Render Betigi
---------------------------------------------------
Ozellikler:
- Sabit hizli Ken Burns zoom (her klibin gercek render suresi L_i uzerinden hesaplanir;
  boylece 1 saniyelik dissolve gecisinde dahi zoom hizi birebir sabit kalir).
- 1440p (2560x1440) 4:4:4 on-olcekleme + gercek alt-piksel (sub-pixel) perspective zoom
  + Lanczos 1080p indirme ile sifir titresimli, Filmora akiciliginda 1920x1080 @ 30fps cikti.
- 10'ar kliplik bellek-dostu toplu (batched) xfade birlestirme (sifir senkron kaymasi).
- Istege bagli Turkce UTF-8 altyazi gomme (timeline.json icinde burnSubtitles=true ise
  subtitles.srt dosyasi sinematik okunakli stille videoya eklenir).
- Orijinal ses dosyasi ASLA yeniden kodlanmaz (-c:a copy).
  * .mp3 / .m4a / .aac -> belgesel_1080p.mp4 (+faststart)
  * .wav / .flac / .aiff -> belgesel_1080p.mov (kayipsiz PCM, Filmora ile tam uyumlu)
"""

import json
import shutil
import subprocess
import sys
import time
from pathlib import Path

BATCH_SIZE = 10
LOSSLESS_AUDIO_EXTS = {".wav", ".aif", ".aiff", ".flac"}


def fmt_time(seconds: float) -> str:
    s = max(0, int(round(seconds)))
    m, sec = divmod(s, 60)
    h, m = divmod(m, 60)
    if h > 0:
        return f"{h:02d}:{m:02d}:{sec:02d}"
    return f"{m:02d}:{sec:02d}"


def check_ffmpeg() -> str:
    ffmpeg_bin = shutil.which("ffmpeg")
    if not ffmpeg_bin:
        print("HATA: Sisteminizde FFmpeg bulunamadi.")
        print("Kurulum: Windows icin 'winget install Gyan.FFmpeg', macOS icin 'brew install ffmpeg'.")
        sys.exit(1)
    return ffmpeg_bin


def run_cmd(cmd: list[str], label: str, cwd: Path | None = None) -> None:
    proc = subprocess.run(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        cwd=str(cwd) if cwd else None,
    )
    if proc.returncode != 0:
        print(f"\\nHATA ({label}): FFmpeg cikis kodu {proc.returncode}")
        tail = "\\n".join(proc.stderr.strip().splitlines()[-20:])
        print(tail)
        sys.exit(1)


def render_single_clip(
    ffmpeg_bin: str,
    image_path: Path,
    out_path: Path,
    render_duration_sec: float,
    start_scale: float,
    end_scale: float,
    fps: int,
) -> None:
    frames = max(2, int(round(render_duration_sec * fps)))
    # FFmpeg'in zoompan filtresi x/y/w/h koordinatlarini her karede tam sayiya yuvarladigi
    # icin yavas belgesel zoomlarinda titreme (jitter) yapar. Bunun yerine goruntuyu tek sefer
    # 2560x1440 4:4:4 (yuv444p) olarak hazirlayip her karede alt-piksel (sub-pixel) perspective
    # zoom uyguluyor ve Lanczos ile 1920x1080'e indiriyoruz (sifir titreme, maksimum netlik).
    z_expr = f"({start_scale:.6f}+({end_scale - start_scale:.6f})*min(in/{frames - 1},1))"
    x0 = f"(W-W/{z_expr})/2"
    x1 = f"(W+W/{z_expr})/2"
    y0 = f"(H-H/{z_expr})/2"
    y2 = f"(H+H/{z_expr})/2"
    vf = (
        "scale=2560:1440:force_original_aspect_ratio=increase:flags=lanczos,"
        "crop=2560:1440,"
        "format=yuv444p,"
        f"loop=loop={frames - 1}:size=1:start=0,"
        f"setpts=N/({fps}*TB),"
        f"perspective=x0='{x0}':y0='{y0}':x1='{x1}':y1='{y0}':"
        f"x2='{x0}':y2='{y2}':x3='{x1}':y3='{y2}':"
        "interpolation=linear:sense=source:eval=frame,"
        "scale=1920:1080:flags=lanczos,"
        "setsar=1,format=yuv420p"
    )

    cmd = [
        ffmpeg_bin,
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        str(image_path),
        "-vf",
        vf,
        "-frames:v",
        str(frames),
        "-r",
        str(fps),
        "-c:v",
        "libx264",
        "-crf",
        "16",
        "-preset",
        "fast",
        "-pix_fmt",
        "yuv420p",
        "-video_track_timescale",
        "30000",
        "-an",
        str(out_path),
    ]
    run_cmd(cmd, f"Klip render: {image_path.name}")


def xfade_group(
    ffmpeg_bin: str,
    input_paths: list[Path],
    timeline_durations: list[float],
    dissolve_sec: float,
    out_path: Path,
    fps: int,
    label: str,
) -> None:
    if len(input_paths) == 1:
        shutil.copy2(input_paths[0], out_path)
        return

    cmd = [ffmpeg_bin, "-y", "-hide_banner", "-loglevel", "error"]
    for p in input_paths:
        cmd.extend(["-i", str(p)])

    filter_parts = []
    for idx in range(len(input_paths)):
        filter_parts.append(f"[{idx}:v]settb=1/30000,setpts=PTS-STARTPTS,fps={fps},format=yuv420p[v{idx}]")

    prev_label = "v0"
    cumulative_offset = 0.0
    for idx in range(1, len(input_paths)):
        cumulative_offset += timeline_durations[idx - 1]
        out_label = f"x{idx}" if idx < len(input_paths) - 1 else "vout"
        filter_parts.append(
            f"[{prev_label}][v{idx}]xfade=transition=fade:duration={dissolve_sec:.4f}:offset={cumulative_offset:.4f}[{out_label}]"
        )
        prev_label = out_label

    filter_complex = ";".join(filter_parts)

    cmd.extend([
        "-filter_complex",
        filter_complex,
        "-map",
        "[vout]",
        "-r",
        str(fps),
        "-c:v",
        "libx264",
        "-crf",
        "18",
        "-preset",
        "medium",
        "-pix_fmt",
        "yuv420p",
        "-video_track_timescale",
        "30000",
        "-an",
        str(out_path),
    ])
    run_cmd(cmd, label)


def hierarchical_xfade(
    ffmpeg_bin: str,
    clip_paths: list[Path],
    clip_timeline_durations: list[float],
    dissolve_sec: float,
    tmp_dir: Path,
    fps: int,
) -> Path:
    current_paths = clip_paths
    current_durs = clip_timeline_durations
    level = 1

    while len(current_paths) > 1:
        next_paths: list[Path] = []
        next_durs: list[float] = []
        total_batches = (len(current_paths) + BATCH_SIZE - 1) // BATCH_SIZE

        for b_idx in range(total_batches):
            start = b_idx * BATCH_SIZE
            end = min(len(current_paths), start + BATCH_SIZE)
            group_paths = current_paths[start:end]
            group_durs = current_durs[start:end]
            batch_out = tmp_dir / f"xfade_L{level}_B{b_idx + 1:03d}.mp4"

            print(
                f"  [Gecis Katmani {level}] Grup {b_idx + 1}/{total_batches} "
                f"({len(group_paths)} klip) 1.0 sn dissolve ile birlestiriliyor..."
            )
            xfade_group(
                ffmpeg_bin=ffmpeg_bin,
                input_paths=group_paths,
                timeline_durations=group_durs,
                dissolve_sec=dissolve_sec,
                out_path=batch_out,
                fps=fps,
                label=f"Xfade Katman {level} Grup {b_idx + 1}",
            )
            next_paths.append(batch_out)
            next_durs.append(sum(group_durs))

        current_paths = next_paths
        current_durs = next_durs
        level += 1

    return current_paths[0]


def burn_subtitles_onto_video(
    ffmpeg_bin: str,
    input_video: Path,
    subtitle_filename: str,
    out_video: Path,
    base_dir: Path,
    fps: int,
) -> None:
    """
    Burns UTF-8 Turkish SRT subtitles with crisp documentary styling.
    Runs with cwd=base_dir and relative subtitle filename so Windows drive letters
    (e.g. C:\\...) never break FFmpeg's subtitles filter escaping.
    """
    style = (
        "FontName=Arial,FontSize=20,"
        "PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,"
        "BackColour=&H96000000,BorderStyle=3,Outline=1,Shadow=0,"
        "Alignment=2,MarginL=80,MarginR=80,MarginV=36"
    )
    vf = f"subtitles='{subtitle_filename}':charenc=UTF-8:force_style='{style}'"

    cmd = [
        ffmpeg_bin,
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        str(input_video),
        "-vf",
        vf,
        "-r",
        str(fps),
        "-c:v",
        "libx264",
        "-crf",
        "18",
        "-preset",
        "medium",
        "-pix_fmt",
        "yuv420p",
        "-an",
        str(out_video),
    ]
    run_cmd(cmd, "Altyazi gomme (subtitles.srt)", cwd=base_dir)


def main() -> None:
    base_dir = Path(__file__).resolve().parent
    timeline_path = base_dir / "timeline.json"

    if not timeline_path.exists():
        print("HATA: timeline.json bulunamadi. render.py ile ayni klasorde olmali.")
        sys.exit(1)

    ffmpeg_bin = check_ffmpeg()

    with timeline_path.open("r", encoding="utf-8") as f:
        data = json.load(f)

    no_audio_flag = "--no-audio" in sys.argv[1:]
    audio_name = "" if no_audio_flag else (data.get("audioFile") or "").strip()
    audio_path = (base_dir / audio_name) if audio_name else None
    scenes = data["scenes"]
    fps = int(data.get("fps", 30))
    dissolve_sec = float(data.get("dissolveDurationSec", 1.0))
    zoom_speed = float(data.get("zoomSpeedPerSec", 0.0025))
    burn_subtitles = bool(data.get("burnSubtitles", False))
    subtitle_name = data.get("subtitleFile") or "subtitles.srt"
    subtitle_path = base_dir / subtitle_name

    if not scenes:
        print("HATA: timeline.json icinde hic sahne yok.")
        sys.exit(1)

    audio_missing_notice = None
    if audio_path is not None and not audio_path.exists():
        audio_missing_notice = audio_name
        audio_path = None
        audio_name = ""

    missing = []
    if burn_subtitles and not subtitle_path.exists():
        missing.append(f"Altyazi dosyasi: {subtitle_name}")
    for sc in scenes:
        img_p = base_dir / sc["filename"]
        if not img_p.exists():
            missing.append(f"Gorsel: {sc['filename']}")

    if missing:
        print("HATA: Asagidaki dosyalar render.py ile ayni klasorde bulunamadi:")
        for item in missing[:15]:
            print(f"  - {item}")
        if len(missing) > 15:
            print(f"  ... ve {len(missing) - 15} dosya daha.")
        sys.exit(1)

    total_scenes = len(scenes)
    total_dur = float(data.get("totalAudioDuration", sum(s["durationSec"] for s in scenes)))
    print("=" * 64)
    print("Belgesel Kurgu Asistani — 16:9 1080p Render Baslatiliyor")
    if audio_missing_notice:
        print(
            f"Bilgi       : '{audio_missing_notice}' klasorde bulunamadi -> "
            f"Ses olmadan 16:9 1080p goruntu uretilecek."
        )
    if audio_name:
        print(f"Ses Dosyasi : {audio_name} ({fmt_time(total_dur)}) [Dokunulmadan -c:a copy]")
    else:
        print(f"Ses Dosyasi : Yok (Sessiz 16:9 1080p goruntu · {fmt_time(total_dur)})")
    print(f"Gorsel Sayisi: {total_scenes} adet")
    print(f"Zoom Hizi   : %{zoom_speed * 100:.2f}/sn (Sabit Hiz, L_i = D_i + {dissolve_sec:.1f}s)")
    print(f"Cozunurluk  : 1920x1080 @ {fps}fps | Dissolve: {dissolve_sec:.1f} sn")
    print(f"Altyazi     : {'ACIK (' + subtitle_name + ')' if burn_subtitles else 'KAPALI'}")
    print("=" * 64)

    tmp_dir = base_dir / "_belgesel_render_tmp"
    if tmp_dir.exists():
        shutil.rmtree(tmp_dir)
    tmp_dir.mkdir(parents=True, exist_ok=True)

    started_at = time.time()

    try:
        clip_paths: list[Path] = []
        clip_timeline_durs: list[float] = []

        for idx, sc in enumerate(scenes):
            is_last = idx == total_scenes - 1
            d_i = float(sc["durationSec"])
            l_i = d_i if is_last else d_i + dissolve_sec
            zoom_delta = l_i * zoom_speed
            max_scale = min(1.0 + zoom_delta, 2.0)

            direction = sc.get("zoomDirection", "uzaklas")
            if direction == "yakinlas":
                start_scale, end_scale = 1.0, max_scale
            else:
                start_scale, end_scale = max_scale, 1.0

            clip_out = tmp_dir / f"clip_{idx + 1:04d}.mp4"
            img_path = base_dir / sc["filename"]

            elapsed = time.time() - started_at
            eta_str = ""
            if idx > 0:
                avg_per_clip = elapsed / idx
                eta_str = f" | Tahmini kalan: ~{fmt_time(avg_per_clip * (total_scenes - idx))}"

            dir_tr = "Yakinlas" if direction == "yakinlas" else "Uzaklas"
            print(
                f"[{idx + 1}/{total_scenes}] {sc['filename']} | "
                f"{dir_tr} %{start_scale * 100:.1f} -> %{end_scale * 100:.1f} "
                f"(D={d_i:.1f}s, L={l_i:.1f}s){eta_str}"
            )

            render_single_clip(
                ffmpeg_bin=ffmpeg_bin,
                image_path=img_path,
                out_path=clip_out,
                render_duration_sec=l_i,
                start_scale=start_scale,
                end_scale=end_scale,
                fps=fps,
            )
            clip_paths.append(clip_out)
            clip_timeline_durs.append(d_i)

        print("\\nGorsel klipleri 1.0 saniyelik dissolve ile birlestiriliyor...")
        merged_video = hierarchical_xfade(
            ffmpeg_bin=ffmpeg_bin,
            clip_paths=clip_paths,
            clip_timeline_durations=clip_timeline_durs,
            dissolve_sec=dissolve_sec,
            tmp_dir=tmp_dir,
            fps=fps,
        )

        video_for_mux = merged_video
        if burn_subtitles:
            print(f"\\nAltyazilar ({subtitle_name}) videoya isleniyor...")
            subtitled_video = tmp_dir / "merged_subtitled.mp4"
            burn_subtitles_onto_video(
                ffmpeg_bin=ffmpeg_bin,
                input_video=merged_video,
                subtitle_filename=subtitle_name,
                out_video=subtitled_video,
                base_dir=base_dir,
                fps=fps,
            )
            video_for_mux = subtitled_video

        if audio_path is None:
            final_output = base_dir / "belgesel_1080p.mp4"
            print("\\nSes dosyasi olmadan yalnizca 16:9 1080p goruntu kaydediliyor...")
            mux_cmd = [
                ffmpeg_bin,
                "-y",
                "-hide_banner",
                "-loglevel",
                "error",
                "-i",
                str(video_for_mux),
                "-c:v",
                "copy",
                "-an",
                "-movflags",
                "+faststart",
                str(final_output),
            ]
        elif audio_path.suffix.lower() in LOSSLESS_AUDIO_EXTS:
            final_output = base_dir / "belgesel_1080p.mov"
            print(
                "\\nBilgi: Ses dosyaniz kayipsiz PCM (.wav/.flac/.aiff) formatinda oldugu icin "
                "sesi hic sikistirmadan (-c:a copy) korumak adina Filmora uyumlu 'belgesel_1080p.mov' olusturuluyor..."
            )
            mux_cmd = [
                ffmpeg_bin,
                "-y",
                "-hide_banner",
                "-loglevel",
                "error",
                "-i",
                str(video_for_mux),
                "-i",
                str(audio_path),
                "-map",
                "0:v:0",
                "-map",
                "1:a:0",
                "-c:v",
                "copy",
                "-c:a",
                "copy",
                str(final_output),
            ]
        else:
            final_output = base_dir / "belgesel_1080p.mp4"
            print("\\nOrijinal ses dokunulmadan (-c:a copy) MP4 videoya ekleniyor...")
            mux_cmd = [
                ffmpeg_bin,
                "-y",
                "-hide_banner",
                "-loglevel",
                "error",
                "-i",
                str(video_for_mux),
                "-i",
                str(audio_path),
                "-map",
                "0:v:0",
                "-map",
                "1:a:0",
                "-c:v",
                "copy",
                "-c:a",
                "copy",
                "-movflags",
                "+faststart",
                str(final_output),
            ]

        run_cmd(mux_cmd, "Ses ve video birlestirme")

        total_elapsed = time.time() - started_at
        print("\\n" + "=" * 64)
        print(f"TAMAMLANDI! Cikti dosyasi: {final_output.name}")
        print(f"Toplam render suresi     : {fmt_time(total_elapsed)}")
        print("Simdi bu dosyayi dogrudan Wondershare Filmora zaman cizelgesine surukleyebilirsiniz.")
        print("=" * 64)

    finally:
        if tmp_dir.exists():
            shutil.rmtree(tmp_dir, ignore_errors=True)


if __name__ == "__main__":
    main()
`;
}

export function generateExportReadme(
  audioFileName: string,
  totalAudioDuration: number,
  sceneCount: number,
  zoomSpeedPerSec: number,
  burnSubtitles = false
): string {
  const cleanAudio = audioFileName.trim();
  const isWav = Boolean(cleanAudio) && /\.(wav|aif|aiff|flac)$/i.test(cleanAudio);
  const outName = isWav ? 'belgesel_1080p.mov' : 'belgesel_1080p.mp4';
  const fileCount = burnSubtitles ? 4 : 3;

  return `# Belgesel Kurgu Asistanı — Render Paketi

Bu paket, **Belgesel Kurgu Asistanı** ile hazırladığınız zaman çizelgesini bilgisayarınızda yüksek kalitede (**1920×1080 @ 30fps**, alt-piksel titreşimsiz sabit hızlı Ken Burns + **1.0 sn Dissolve**${cleanAudio ? ', orijinal ses dokunulmadan `-c:a copy`' : ''}) videoya dönüştürmek için gereken ${fileCount} hafif dosyayı içerir.

## Proje Özeti
- **Ses Dosyası:** ${cleanAudio ? `\`${cleanAudio}\` (${formatMMSS(totalAudioDuration)})` : `Belirtilmedi (Yalnızca 16:9 1080p görüntü · ${formatMMSS(totalAudioDuration)})`}
- **Görsel Sayısı:** ${sceneCount} adet
- **Genel Zoom Hızı:** ${formatZoomSpeedPct(zoomSpeedPerSec)} (tüm kliplerde ve 1 sn dissolve boyunca sabit hız)
- **Videoya Gömülü Altyazı:** ${burnSubtitles ? 'Açık (`subtitles.srt` dosyası UTF-8 Türkçe olarak videoya işlenir)' : 'Kapalı'}
- **Çıktı Dosyası:** \`${outName}\`${isWav ? ' *(Kayıpsız WAV sesi yeniden kodlamadan korumak için Filmora uyumlu MOV)*' : ''}

## 3 Adımda Video Oluşturma

1. **Dosyaları Medya Klasörüne Koyun:**
   Bu ZIP içindeki \`timeline.json\`, \`render.py\`${burnSubtitles ? ' ve `subtitles.srt`' : ''} dosyalarını, ${cleanAudio ? `orijinal ses dosyanızın (\`${cleanAudio}\`) ve ` : ''}tüm sıralı görsellerinizin bulunduğu **aynı klasörün içine** kopyalayın.

2. **FFmpeg ve Python 3'ün Kurulu Olduğundan Emin Olun:**
   - **Windows:** PowerShell'de \`winget install Gyan.FFmpeg\` (Python yoksa \`winget install Python.Python.3.12\`)
   - **macOS:** Terminal'de \`brew install ffmpeg\`

3. **Render Betiğini Çalıştırın:**
   Klasörde terminal / komut istemi açıp şu komutu yazın:
   \`\`\`bash
   python render.py
   \`\`\`
   *(macOS veya Linux'ta gerekirse \`python3 render.py\`. Klasörde ses dosyası yoksa veya \`python render.py --no-audio\` yazarsanız hata vermeden otomatik olarak sessiz 16:9 1080p \`belgesel_1080p.mp4\` üretir.)*

## Wondershare Filmora'ya Aktarma
İşlem bittiğinde klasörde oluşan **\`${outName}\`** dosyasını doğrudan Wondershare Filmora'ya sürükleyip bırakın. Görüntü 16:9 1080p, geçişler pürüzsüz ve orijinal belgesel sesiniz tek bir bit bile değişmeden hazır olacaktır.

## Otomatik Transkript Notu (Deepgram)
Uygulama içinde ses dosyalarını otomatik olarak Türkçe metne çevirmek için **Deepgram** (\`nova-3\` / \`nova-2\`) kullanılır. [console.deepgram.com](https://console.deepgram.com) adresinden kredi kartı gerekmeden ücretsiz $200 başlangıç kredili API anahtarı alıp uygulamadaki **Ayarlar** penceresine ekleyebilir veya dilerseniz Adım 1'de hazır \`.srt\` dosyanızı doğrudan yükleyebilirsiniz.
`;
}

export async function downloadKurguPaketiZip(
  audioFileName: string,
  totalAudioDuration: number,
  zoomSpeedPerSec: number,
  scenes: TimelineScene[],
  burnSubtitles = false,
  transcriptSegments: TranscriptSegment[] = []
): Promise<void> {
  const zip = new JSZip();
  const includeSubs = burnSubtitles && transcriptSegments.length > 0;

  const timelinePayload = buildTimelineJson(
    audioFileName,
    totalAudioDuration,
    zoomSpeedPerSec,
    scenes,
    includeSubs
  );

  zip.file('timeline.json', JSON.stringify(timelinePayload, null, 2));
  zip.file('render.py', generateRenderPy());
  if (includeSubs) {
    zip.file('subtitles.srt', segmentsToSrt(transcriptSegments));
  }
  zip.file(
    'README.md',
    generateExportReadme(
      audioFileName,
      totalAudioDuration,
      scenes.length,
      zoomSpeedPerSec,
      includeSubs
    )
  );

  const blob = await zip.generateAsync({ type: 'blob' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'kurgu_paketi.zip';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  window.setTimeout(() => URL.revokeObjectURL(url), 3000);
}

export function downloadTextFile(filename: string, content: string, mime = 'text/plain;charset=utf-8'): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  window.setTimeout(() => URL.revokeObjectURL(url), 2000);
}

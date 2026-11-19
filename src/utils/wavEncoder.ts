/**
 * Smart WAV / Raw PCM Audio Decoder for Gemini TTS.
 * - Gemini 3.8 unary TTS returns a complete RIFF WAV file (24kHz mono 16-bit).
 * - Other TTS endpoints or streaming modes return headerless raw PCM (audio/pcm;rate=24000 or audio/l16).
 * This module inspects the first 4 bytes ('RIFF') so it never double-wraps valid WAVs,
 * and cleanly wraps raw PCM with a standard 44-byte RIFF/WAV header.
 */

function base64ToUint8Array(base64: string): Uint8Array {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

function hasRiffWavHeader(bytes: Uint8Array): boolean {
  if (bytes.length < 44) return false;
  return (
    bytes[0] === 0x52 && // R
    bytes[1] === 0x49 && // I
    bytes[2] === 0x46 && // F
    bytes[3] === 0x46 && // F
    bytes[8] === 0x57 && // W
    bytes[9] === 0x41 && // A
    bytes[10] === 0x56 && // V
    bytes[11] === 0x45 // E
  );
}

function parseSampleRateFromMime(mimeType: string): number {
  const match = mimeType.match(/rate=(\d+)/i);
  if (match) {
    const parsed = parseInt(match[1], 10);
    if (parsed >= 8000 && parsed <= 96000) return parsed;
  }
  return 24000;
}

export function wrapPcm16ToWav(pcmBytes: Uint8Array, sampleRate = 24000, channels = 1): Uint8Array {
  const bitsPerSample = 16;
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  const blockAlign = (channels * bitsPerSample) / 8;
  const dataSize = pcmBytes.byteLength;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeStr = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) {
      view.setUint8(offset + i, s.charCodeAt(i));
    }
  };

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM fmt chunk size
  view.setUint16(20, 1, true); // AudioFormat = 1 (PCM)
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);

  new Uint8Array(buffer, 44).set(pcmBytes);
  return new Uint8Array(buffer);
}

export function extractWavDurationSec(wavBytes: Uint8Array): number {
  if (!hasRiffWavHeader(wavBytes)) return 0;
  const view = new DataView(wavBytes.buffer, wavBytes.byteOffset, wavBytes.byteLength);
  const byteRate = view.getUint32(28, true);
  if (!byteRate) return 0;

  // Locate the 'data' subchunk safely (handles extended WAV chunks too)
  let offset = 12;
  while (offset + 8 <= wavBytes.byteLength) {
    const id = String.fromCharCode(
      wavBytes[offset],
      wavBytes[offset + 1],
      wavBytes[offset + 2],
      wavBytes[offset + 3]
    );
    const size = view.getUint32(offset + 4, true);
    if (id === 'data') {
      return Number((size / byteRate).toFixed(2));
    }
    offset += 8 + size + (size % 2);
  }

  return Number(((wavBytes.byteLength - 44) / byteRate).toFixed(2));
}

export function decodeTtsAudioToWavBlob(
  audioBase64: string,
  mimeType = 'audio/wav'
): { blob: Blob; durationSec: number } {
  const rawBytes = base64ToUint8Array(audioBase64);

  let wavBytes: Uint8Array;
  if (hasRiffWavHeader(rawBytes)) {
    wavBytes = rawBytes;
  } else {
    const sampleRate = parseSampleRateFromMime(mimeType);
    wavBytes = wrapPcm16ToWav(rawBytes, sampleRate, 1);
  }

  const durationSec = extractWavDurationSec(wavBytes);
  const copy = new Uint8Array(wavBytes.byteLength);
  copy.set(wavBytes);
  const blob = new Blob([copy.buffer], { type: 'audio/wav' });
  return { blob, durationSec };
}

/**
 * Merges multiple WAV blobs (assumed compatible 24kHz mono 16-bit PCM) with silence pauses between chunks.
 */
export async function mergeWavBlobsWithPauses(
  items: Array<{ blob: Blob; isChapterStart: boolean }>,
  normalPauseMs: number,
  chapterPauseMs: number
): Promise<Blob> {
  const pcmSegments: Uint8Array[] = [];
  let sampleRate = 24000;
  let channels = 1;

  for (let i = 0; i < items.length; i++) {
    const arr = new Uint8Array(await items[i].blob.arrayBuffer());
    if (i > 0) {
      const pauseMs = items[i].isChapterStart ? chapterPauseMs : normalPauseMs;
      const silenceSamples = Math.max(0, Math.round((sampleRate * pauseMs) / 1000));
      pcmSegments.push(new Uint8Array(silenceSamples * channels * 2));
    }

    if (hasRiffWavHeader(arr)) {
      const view = new DataView(arr.buffer, arr.byteOffset, arr.byteLength);
      if (i === 0) {
        channels = view.getUint16(22, true) || 1;
        sampleRate = view.getUint32(24, true) || 24000;
      }
      // Find 'data' chunk
      let offset = 12;
      let found = false;
      while (offset + 8 <= arr.byteLength) {
        const id = String.fromCharCode(arr[offset], arr[offset + 1], arr[offset + 2], arr[offset + 3]);
        const size = view.getUint32(offset + 4, true);
        if (id === 'data') {
          pcmSegments.push(arr.subarray(offset + 8, Math.min(arr.byteLength, offset + 8 + size)));
          found = true;
          break;
        }
        offset += 8 + size + (size % 2);
      }
      if (!found) {
        pcmSegments.push(arr.subarray(44));
      }
    } else {
      pcmSegments.push(arr);
    }
  }

  const totalBytes = pcmSegments.reduce((acc, seg) => acc + seg.byteLength, 0);
  const mergedPcm = new Uint8Array(totalBytes);
  let cursor = 0;
  for (const seg of pcmSegments) {
    mergedPcm.set(seg, cursor);
    cursor += seg.byteLength;
  }

  const finalWav = wrapPcm16ToWav(mergedPcm, sampleRate, channels);
  const copy = new Uint8Array(finalWav.byteLength);
  copy.set(finalWav);
  return new Blob([copy.buffer], { type: 'audio/wav' });
}

export function formatDurationClock(sec?: number): string {
  if (!sec || !Number.isFinite(sec) || sec <= 0) return '00:00';
  const total = Math.round(sec);
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

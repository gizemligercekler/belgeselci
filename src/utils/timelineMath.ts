import {
  FIXED_DISSOLVE_SEC,
  MIN_SCENE_DURATION_SEC,
  TimelineScene,
  TimingPlanEntry,
  TranscriptSegment,
  UploadedImage,
  ZoomDirection,
} from '../types/editor';

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

export function formatMMSS(sec: number): string {
  const clamped = Math.max(0, Math.round(sec));
  const h = Math.floor(clamped / 3600);
  const m = Math.floor((clamped % 3600) / 60);
  const s = clamped % 60;
  if (h > 0) {
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function formatPct(scale: number): string {
  return `%${(scale * 100).toFixed(1)}`;
}

export function formatZoomSpeedPct(speedPerSec: number): string {
  return `%${(speedPerSec * 100).toFixed(2)}/sn`;
}

/**
 * Default strictly alternating zoom directions:
 * 1st (index 0): Uzaklaş (Zoom Out)
 * 2nd (index 1): Yakınlaş (Zoom In)
 * 3rd (index 2): Uzaklaş ...
 */
export function defaultZoomDirectionForIndex(index: number): ZoomDirection {
  return index % 2 === 0 ? 'uzaklas' : 'yakinlas';
}

/**
 * Rule A + Dissolve Constant Velocity Refinement:
 * Computes startScale & endScale over the actual rendered clip length L_i
 * (L_i = D_i + 1.0s for all non-final clips, L_{N-1} = D_{N-1} for final clip)
 * so the zoom speed remains 100% mathematically constant even during the 1-second dissolve.
 */
export function computeClipZoomScales(
  durationSec: number,
  isLastClip: boolean,
  zoomDirection: ZoomDirection,
  zoomSpeedPerSec: number
): { renderDurationSec: number; startScale: number; endScale: number } {
  const renderDurationSec = isLastClip
    ? round2(durationSec)
    : round2(durationSec + FIXED_DISSOLVE_SEC);

  const zoomDelta = renderDurationSec * zoomSpeedPerSec;
  const maxScale = round4(Math.min(1.0 + zoomDelta, 2.0));

  if (zoomDirection === 'yakinlas') {
    return {
      renderDurationSec,
      startScale: 1.0,
      endScale: maxScale,
    };
  }

  return {
    renderDurationSec,
    startScale: maxScale,
    endScale: 1.0,
  };
}

/**
 * Recalculates durationSec, renderDurationSec, startScale, and endScale across all scenes
 * whenever zoomSpeedPerSec or any scene duration/direction changes.
 */
export function recalculateAllScenes(
  scenes: TimelineScene[],
  zoomSpeedPerSec: number
): TimelineScene[] {
  const total = scenes.length;
  return scenes.map((sc, idx) => {
    const durationSec = round2(Math.max(0.5, sc.endSec - sc.startSec));
    const isLast = idx === total - 1;
    const { renderDurationSec, startScale, endScale } = computeClipZoomScales(
      durationSec,
      isLast,
      sc.zoomDirection,
      zoomSpeedPerSec
    );
    return {
      ...sc,
      durationSec,
      renderDurationSec,
      startScale,
      endScale,
    };
  });
}

/**
 * Rule B — Adjacent-Only Duration Adjustment (Zero Ripple to Later Images):
 * Changing image i's duration by delta ONLY shifts endSec[i] and startSec[i+1].
 * endSec[i+1] stays LOCKED, and images i+2..N-1 remain 100% untouched.
 */
export function adjustSceneDurationAdjacentOnly(
  scenes: TimelineScene[],
  index: number,
  requestedDurationSec: number,
  zoomSpeedPerSec: number,
  transcriptSegments: TranscriptSegment[]
): TimelineScene[] {
  if (index < 0 || index >= scenes.length - 1) {
    // Very last image is locked to totalAudioDuration
    return scenes;
  }

  const curr = scenes[index];
  const next = scenes[index + 1];
  const combinedDuration = round2(next.endSec - curr.startSec);

  // Enforce minimum safe duration of 2.0s on both i and i+1 (safe fallback if combined < 4s)
  const effectiveMin = Math.min(MIN_SCENE_DURATION_SEC, round2(combinedDuration / 2));
  const maxAllowed = round2(Math.max(effectiveMin, combinedDuration - effectiveMin));
  const clampedNewDur = round2(Math.max(effectiveMin, Math.min(maxAllowed, requestedDurationSec)));

  if (Math.abs(clampedNewDur - curr.durationSec) < 0.005) {
    return scenes;
  }

  const newBoundary = round2(curr.startSec + clampedNewDur);
  const nextNewDur = round2(next.endSec - newBoundary);

  const updated = scenes.map((sc, idx) => {
    if (idx === index) {
      return {
        ...sc,
        endSec: newBoundary,
        durationSec: clampedNewDur,
      };
    }
    if (idx === index + 1) {
      return {
        ...sc,
        startSec: newBoundary,
        // endSec stays strictly LOCKED!
        durationSec: nextNewDur,
        matchedExcerpt:
          getExcerptAtTimestamp(transcriptSegments, newBoundary, sc.endSec) || sc.matchedExcerpt,
      };
    }
    return sc;
  });

  return recalculateAllScenes(updated, zoomSpeedPerSec);
}

/**
 * Extracts a concise Turkish transcript excerpt starting near startSec.
 */
export function getExcerptAtTimestamp(
  segments: TranscriptSegment[],
  startSec: number,
  endSec: number
): string {
  if (!segments || segments.length === 0) return '';
  const overlapping = segments.filter(
    (seg) => seg.endSec > startSec + 0.2 && seg.startSec < endSec
  );
  if (overlapping.length === 0) {
    // Find nearest segment to startSec
    let best = segments[0];
    let bestDist = Math.abs(best.startSec - startSec);
    for (const s of segments) {
      const d = Math.abs(s.startSec - startSec);
      if (d < bestDist) {
        best = s;
        bestDist = d;
      }
    }
    return best.text.slice(0, 150);
  }
  const combined = overlapping
    .slice(0, 2)
    .map((s) => s.text)
    .join(' ');
  return combined.length > 150 ? `${combined.slice(0, 147)}...` : combined;
}

/**
 * Normalizes AI alignment results into a strictly monotonic, zero-gap, zero-overlap
 * TimelineScene array where scene 0 starts at 0.0 and final scene ends at totalAudioDuration.
 */
export function buildValidatedTimeline(
  images: UploadedImage[],
  rawAlignments: Array<{ index?: number; startSec?: number; matchedExcerpt?: string }>,
  totalAudioDuration: number,
  zoomSpeedPerSec: number,
  transcriptSegments: TranscriptSegment[]
): TimelineScene[] {
  const n = images.length;
  if (n === 0) return [];

  const safeTotal = round2(Math.max(n * 0.5, totalAudioDuration));
  const minStep = safeTotal >= n * MIN_SCENE_DURATION_SEC ? MIN_SCENE_DURATION_SEC : round2(safeTotal / n);

  // Build map from index -> alignment
  const byIdx = new Map<number, { startSec?: number; matchedExcerpt?: string }>();
  for (let i = 0; i < rawAlignments.length; i++) {
    const item = rawAlignments[i];
    const targetIdx =
      typeof item.index === 'number' && item.index >= 0 && item.index < n ? item.index : i;
    if (!byIdx.has(targetIdx)) {
      byIdx.set(targetIdx, item);
    }
  }

  // Extract raw starts & enforce strict monotonicity [0 .. safeTotal - minStep]
  const starts: number[] = new Array(n).fill(0);
  starts[0] = 0;

  for (let i = 1; i < n; i++) {
    const raw = byIdx.get(i)?.startSec;
    const minAllowed = round2(starts[i - 1] + minStep);
    const maxAllowed = round2(safeTotal - (n - i) * minStep);

    let candidate =
      typeof raw === 'number' && Number.isFinite(raw)
        ? raw
        : round2((i / n) * safeTotal);

    if (candidate < minAllowed) candidate = minAllowed;
    if (candidate > maxAllowed) candidate = maxAllowed;
    starts[i] = round2(candidate);
  }

  const rawScenes: TimelineScene[] = images.map((img, idx) => {
    const startSec = starts[idx];
    const endSec = idx < n - 1 ? starts[idx + 1] : safeTotal;
    const durationSec = round2(Math.max(0.5, endSec - startSec));
    const aiExcerpt = byIdx.get(idx)?.matchedExcerpt?.trim();
    const fallbackExcerpt = getExcerptAtTimestamp(transcriptSegments, startSec, endSec);

    return {
      id: `scene_${idx + 1}_${img.orderNumber}`,
      orderNumber: img.orderNumber,
      filename: img.filename,
      cleanTitle: img.cleanTitle,
      startSec,
      endSec,
      durationSec,
      renderDurationSec: durationSec,
      zoomDirection: defaultZoomDirectionForIndex(idx),
      startScale: 1.0,
      endScale: 1.0,
      matchedExcerpt: aiExcerpt || fallbackExcerpt || img.cleanTitle,
    };
  });

  return recalculateAllScenes(rawScenes, zoomSpeedPerSec);
}

/**
 * Resolves how each uploaded image maps to an entry in the user's .txt timing plan
 * (by exact orderNumber first, then positional fallback when entry count matches image count).
 */
export function matchImagesToTimingPlan(
  images: Array<Pick<UploadedImage, 'id' | 'orderNumber' | 'filename' | 'cleanTitle'>>,
  entries: TimingPlanEntry[]
): Array<TimingPlanEntry | null> {
  if (entries.length === 0) return images.map(() => null);

  const byOrder = new Map<number, TimingPlanEntry>();
  for (const entry of entries) {
    if (!byOrder.has(entry.orderNumber)) {
      byOrder.set(entry.orderNumber, entry);
    }
  }

  const exactMatches = images.map((img) => byOrder.get(img.orderNumber) ?? null);
  const exactCount = exactMatches.filter(Boolean).length;

  // If all images matched by orderNumber, return exact map; otherwise allow clean 1:1 positional match when counts match
  if (exactCount === images.length) return exactMatches;
  if (entries.length === images.length) {
    return images.map((img, idx) => byOrder.get(img.orderNumber) ?? entries[idx] ?? null);
  }
  return exactMatches;
}

/**
 * Builds a validated, zero-gap, constant-zoom-speed TimelineScene array directly from the user's
 * uploaded .txt timing plan while keeping every scene's requested start/end duration faithful.
 */
export function buildTimelineFromTimingPlan(
  images: Array<Pick<UploadedImage, 'id' | 'orderNumber' | 'filename' | 'cleanTitle'>>,
  entries: TimingPlanEntry[],
  totalAudioDuration: number,
  zoomSpeedPerSec: number,
  transcriptSegments: TranscriptSegment[]
): TimelineScene[] {
  const n = images.length;
  if (n === 0) return [];

  const matched = matchImagesToTimingPlan(images, entries);
  const planTotalEnd = entries.reduce((max, e) => Math.max(max, e.endSec), 0);
  const safeTotal = round2(Math.max(n * 0.5, totalAudioDuration || planTotalEnd));
  const minStep = safeTotal >= n * MIN_SCENE_DURATION_SEC ? MIN_SCENE_DURATION_SEC : round2(safeTotal / n);

  const starts: number[] = new Array(n).fill(0);
  starts[0] = 0;

  for (let i = 1; i < n; i++) {
    const prevEntry = matched[i - 1];
    const currEntry = matched[i];
    const minAllowed = round2(starts[i - 1] + minStep);
    const maxAllowed = round2(safeTotal - (n - i) * minStep);

    let candidate: number;
    if (currEntry && Number.isFinite(currEntry.startSec)) {
      candidate = currEntry.startSec;
    } else if (prevEntry && Number.isFinite(prevEntry.durationSec)) {
      candidate = starts[i - 1] + prevEntry.durationSec;
    } else {
      candidate = round2((i / n) * safeTotal);
    }

    if (candidate < minAllowed) candidate = minAllowed;
    if (candidate > maxAllowed) candidate = maxAllowed;
    starts[i] = round2(candidate);
  }

  const rawScenes: TimelineScene[] = images.map((img, idx) => {
    const startSec = starts[idx];
    const endSec = idx < n - 1 ? starts[idx + 1] : safeTotal;
    const durationSec = round2(Math.max(0.5, endSec - startSec));
    const planEntry = matched[idx];
    const transcriptExcerpt = getExcerptAtTimestamp(transcriptSegments, startSec, endSec);

    return {
      id: `scene_${idx + 1}_${img.orderNumber}`,
      orderNumber: img.orderNumber,
      filename: img.filename,
      cleanTitle: img.cleanTitle,
      startSec,
      endSec,
      durationSec,
      renderDurationSec: durationSec,
      zoomDirection: defaultZoomDirectionForIndex(idx),
      startScale: 1.0,
      endScale: 1.0,
      matchedExcerpt: transcriptExcerpt || planEntry?.title || img.cleanTitle,
    };
  });

  return recalculateAllScenes(rawScenes, zoomSpeedPerSec);
}

import { ProjectRecord } from '../types/studio';

const DB_NAME = 'belgesel_studyosu_db';
const DB_VERSION = 1;
const STORE_PROJECTS = 'projects';
const STORE_BLOBS = 'blobs';
const ACTIVE_PROJECT_KEY = 'belgesel_studyosu_active_project_id';

export interface MediaBlobRecord {
  id: string;
  projectId: string;
  kind: 'audio' | 'visual' | 'music';
  mimeType: string;
  blob: Blob;
  updatedAt: number;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_PROJECTS)) {
        db.createObjectStore(STORE_PROJECTS, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE_BLOBS)) {
        const blobStore = db.createObjectStore(STORE_BLOBS, { keyPath: 'id' });
        blobStore.createIndex('projectId', 'projectId', { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB açılamadı.'));
  });
}

export function getActiveProjectId(): string | null {
  try {
    return localStorage.getItem(ACTIVE_PROJECT_KEY);
  } catch {
    return null;
  }
}

export function setActiveProjectId(id: string): void {
  try {
    localStorage.setItem(ACTIVE_PROJECT_KEY, id);
  } catch {
    // Ignore storage quota errors
  }
}

export async function listProjects(): Promise<ProjectRecord[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_PROJECTS, 'readonly');
    const store = tx.objectStore(STORE_PROJECTS);
    const req = store.getAll();
    req.onsuccess = () => {
      const items = (req.result as ProjectRecord[]) || [];
      items.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      resolve(items);
    };
    req.onerror = () => reject(req.error);
  });
}

export async function saveProject(project: ProjectRecord): Promise<void> {
  const db = await openDb();
  const payload: ProjectRecord = { ...project, updatedAt: Date.now() };
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_PROJECTS, 'readwrite');
    tx.objectStore(STORE_PROJECTS).put(payload);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function deleteProjectWithBlobs(projectId: string): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction([STORE_PROJECTS, STORE_BLOBS], 'readwrite');
    tx.objectStore(STORE_PROJECTS).delete(projectId);
    const blobStore = tx.objectStore(STORE_BLOBS);
    const idx = blobStore.index('projectId');
    const cursorReq = idx.openCursor(IDBKeyRange.only(projectId));
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (cursor) {
        cursor.delete();
        cursor.continue();
      }
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function saveMediaBlob(record: MediaBlobRecord): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_BLOBS, 'readwrite');
    tx.objectStore(STORE_BLOBS).put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getMediaBlob(blobId: string): Promise<MediaBlobRecord | null> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_BLOBS, 'readonly');
    const req = tx.objectStore(STORE_BLOBS).get(blobId);
    req.onsuccess = () => resolve((req.result as MediaBlobRecord) || null);
    req.onerror = () => reject(req.error);
  });
}

export async function deleteMediaBlob(blobId: string): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_BLOBS, 'readwrite');
    tx.objectStore(STORE_BLOBS).delete(blobId);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getProjectBlobs(projectId: string): Promise<MediaBlobRecord[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_BLOBS, 'readonly');
    const idx = tx.objectStore(STORE_BLOBS).index('projectId');
    const req = idx.getAll(IDBKeyRange.only(projectId));
    req.onsuccess = () => resolve((req.result as MediaBlobRecord[]) || []);
    req.onerror = () => reject(req.error);
  });
}

async function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

async function dataUrlToBlob(dataUrl: string): Promise<Blob> {
  const res = await fetch(dataUrl);
  return res.blob();
}

export interface ProjectJsonBackup {
  schemaVersion: 1;
  exportedAt: string;
  project: ProjectRecord;
  embeddedMedia?: Array<{
    id: string;
    kind: 'audio' | 'visual' | 'music';
    mimeType: string;
    dataUrl: string;
  }>;
}

export async function exportProjectToJsonString(
  project: ProjectRecord,
  includeMedia = false
): Promise<string> {
  // Sanitize API keys out of exported JSON backup by default? Keep user settings cleanly without leaking keys if empty
  const backup: ProjectJsonBackup = {
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    project,
  };

  if (includeMedia) {
    const blobs = await getProjectBlobs(project.id);
    backup.embeddedMedia = [];
    for (const b of blobs) {
      backup.embeddedMedia.push({
        id: b.id,
        kind: b.kind,
        mimeType: b.mimeType,
        dataUrl: await blobToDataUrl(b.blob),
      });
    }
  }

  return JSON.stringify(backup, null, 2);
}

export async function importProjectFromJsonString(jsonStr: string): Promise<ProjectRecord> {
  const parsed = JSON.parse(jsonStr) as ProjectJsonBackup | ProjectRecord;
  const projectData: ProjectRecord =
    'project' in parsed && parsed.project ? parsed.project : (parsed as ProjectRecord);

  if (!projectData || typeof projectData !== 'object' || !projectData.name) {
    throw new Error('Geçersiz proje JSON dosyası.');
  }

  // Assign a fresh ID to avoid overwriting an existing project unintentionally
  const newProjectId = `proj_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const idMap = new Map<string, string>();

  const embedded = 'embeddedMedia' in parsed && Array.isArray(parsed.embeddedMedia) ? parsed.embeddedMedia : [];

  for (const item of embedded) {
    const newBlobId = `blob_${newProjectId}_${Math.random().toString(36).slice(2, 8)}`;
    idMap.set(item.id, newBlobId);
    const blob = await dataUrlToBlob(item.dataUrl);
    await saveMediaBlob({
      id: newBlobId,
      projectId: newProjectId,
      kind: item.kind,
      mimeType: item.mimeType || blob.type,
      blob,
      updatedAt: Date.now(),
    });
  }

  const importedProject: ProjectRecord = {
    ...projectData,
    id: newProjectId,
    updatedAt: Date.now(),
    chunks: (projectData.chunks || []).map((c) => ({
      ...c,
      audioBlobId: c.audioBlobId ? idMap.get(c.audioBlobId) : undefined,
      status: c.audioBlobId && idMap.has(c.audioBlobId) ? 'cached' : 'idle',
    })),
    scenes: (projectData.scenes || []).map((s) => ({
      ...s,
      visualBlobId: s.visualBlobId ? idMap.get(s.visualBlobId) : undefined,
      status:
        (s.visualBlobId && idMap.has(s.visualBlobId)) || s.remoteVideoUrl ? 'ready' : 'idle',
    })),
    editSettings: {
      ...projectData.editSettings,
      bgMusicBlobId: projectData.editSettings?.bgMusicBlobId
        ? idMap.get(projectData.editSettings.bgMusicBlobId)
        : undefined,
    },
  };

  await saveProject(importedProject);
  return importedProject;
}

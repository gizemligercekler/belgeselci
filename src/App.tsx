import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, AlertCircle, CheckCircle2, X } from 'lucide-react';
import { ProjectRecord, StudioSettings, WizardStep } from './types/studio';
import { createEmptyProject, populateDemoData } from './data/defaults';
import {
  deleteProjectWithBlobs,
  getActiveProjectId,
  listProjects,
  saveProject,
  setActiveProjectId,
} from './utils/storageDb';
import { fetchServerHealth, ServerHealthStatus } from './services/geminiService';
import { preprocessTurkishScript } from './utils/turkishTTSPreprocessor';
import { TopBar } from './components/TopBar';
import { SettingsDrawer } from './components/SettingsDrawer';
import { ProjectsModal } from './components/ProjectsModal';
import { ReadmeModal } from './components/ReadmeModal';
import { Step1Topic } from './components/steps/Step1Topic';
import { Step2Script } from './components/steps/Step2Script';
import { Step3TtsStudio } from './components/steps/Step3TtsStudio';
import { Step4Storyboard } from './components/steps/Step4Storyboard';
import { Step5EditPreview } from './components/steps/Step5EditPreview';
import { Step6Export } from './components/steps/Step6Export';

interface ToastItem {
  id: number;
  message: string;
  tone: 'info' | 'error';
}

export default function App() {
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [activeId, setActiveId] = useState<string>('');
  const [hydrating, setHydrating] = useState(true);

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [projectsOpen, setProjectsOpen] = useState(false);
  const [readmeOpen, setReadmeOpen] = useState(false);
  const [serverHealth, setServerHealth] = useState<ServerHealthStatus>({
    ok: true,
    hasServerGeminiKey: false,
    hasServerPexelsKey: false,
  });
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const saveTimerRef = useRef<number | null>(null);

  const notify = useCallback((message: string, tone: 'info' | 'error' = 'info') => {
    const id = Date.now() + Math.random();
    setToasts((prev) => [...prev.slice(-3), { id, message, tone }]);
    window.setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, tone === 'error' ? 6500 : 3800);
  }, []);

  // Hydrate projects from IndexedDB & fetch server health
  useEffect(() => {
    let cancelled = false;

    const init = async () => {
      try {
        const [stored, health] = await Promise.all([listProjects(), fetchServerHealth()]);
        if (cancelled) return;
        setServerHealth(health);

        if (stored.length > 0) {
          setProjects(stored);
          const remembered = getActiveProjectId();
          const chosen = stored.find((p) => p.id === remembered) || stored[0];
          setActiveId(chosen.id);
          setActiveProjectId(chosen.id);
        } else {
          const initial = createEmptyProject('Yeni Belgesel Projesi');
          await saveProject(initial);
          if (cancelled) return;
          setProjects([initial]);
          setActiveId(initial.id);
          setActiveProjectId(initial.id);
        }
      } catch (err) {
        const fallback = createEmptyProject('Yeni Belgesel Projesi');
        setProjects([fallback]);
        setActiveId(fallback.id);
        notify(`Yerel depolama başlatılırken uyarı: ${(err as Error).message}`, 'error');
      } finally {
        if (!cancelled) setHydrating(false);
      }
    };

    void init();
    return () => {
      cancelled = true;
    };
  }, [notify]);

  const activeProject = useMemo(
    () => projects.find((p) => p.id === activeId) || projects[0] || null,
    [projects, activeId]
  );

  // Debounced auto-save to IndexedDB
  const persistProject = useCallback((updated: ProjectRecord) => {
    if (saveTimerRef.current) {
      window.clearTimeout(saveTimerRef.current);
    }
    saveTimerRef.current = window.setTimeout(() => {
      void saveProject(updated);
    }, 300);
  }, []);

  const updateActiveProject = useCallback(
    (updater: (prev: ProjectRecord) => ProjectRecord) => {
      setProjects((prevList) =>
        prevList.map((proj) => {
          if (proj.id !== activeId) return proj;
          const next = { ...updater(proj), updatedAt: Date.now() };
          persistProject(next);
          return next;
        })
      );
    },
    [activeId, persistProject]
  );

  const handleSelectStep = (step: WizardStep) => {
    updateActiveProject((prev) => ({ ...prev, activeStep: step }));
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleLoadDemo = async () => {
    if (!activeProject) return;
    const populated = populateDemoData(activeProject);
    const chunks = await preprocessTurkishScript(populated.rawScript, {
      excludeChapterPrefix: populated.studioSettings.excludeChapterPrefix,
      speakBolumTag: populated.studioSettings.speakBolumTag ?? true,
      maxChunkSize: populated.studioSettings.maxChunkSize,
      model: populated.studioSettings.ttsModel,
      voice: populated.studioSettings.ttsVoice,
      style: populated.studioSettings.ttsStylePrompt,
    });
    const finalDemo: ProjectRecord = {
      ...populated,
      chunks,
      activeStep: 2,
    };
    setProjects((prev) => prev.map((p) => (p.id === activeProject.id ? finalDemo : p)));
    await saveProject(finalDemo);
    notify(
      '2 bölümlük Türkçe demo belgeseli yüklendi ("BÖLÜM iki: KAVRAM KARMAŞASI..." ve En\'âm:38 etiketi dahil).'
    );
  };

  const handleSettingsChange = (nextSettings: StudioSettings) => {
    updateActiveProject((prev) => ({
      ...prev,
      studioSettings: nextSettings,
    }));
  };

  const handleCreateProject = async (name: string) => {
    const fresh = createEmptyProject(name);
    // Carry over user's API keys & tier preferences from current active project for convenience
    if (activeProject) {
      fresh.studioSettings = { ...activeProject.studioSettings };
    }
    await saveProject(fresh);
    setProjects((prev) => [fresh, ...prev]);
    setActiveId(fresh.id);
    setActiveProjectId(fresh.id);
    notify(`"${fresh.name}" projesi oluşturuldu.`);
  };

  const handleSelectProject = (id: string) => {
    setActiveId(id);
    setActiveProjectId(id);
  };

  const handleDeleteProject = async (id: string) => {
    if (projects.length <= 1) return;
    await deleteProjectWithBlobs(id);
    const remaining = projects.filter((p) => p.id !== id);
    setProjects(remaining);
    if (activeId === id && remaining[0]) {
      setActiveId(remaining[0].id);
      setActiveProjectId(remaining[0].id);
    }
    notify('Proje ve ilişkili medya dosyaları silindi.');
  };

  const handleImportedProject = (imported: ProjectRecord) => {
    setProjects((prev) => [imported, ...prev]);
    setActiveId(imported.id);
    setActiveProjectId(imported.id);
  };

  const completedSteps: Record<WizardStep, boolean> = useMemo(() => {
    if (!activeProject) {
      return { 1: false, 2: false, 3: false, 4: false, 5: false, 6: false };
    }
    return {
      1: Boolean(activeProject.topicBrief.topic.trim() || activeProject.rawScript.trim()),
      2: Boolean(activeProject.rawScript.trim()),
      3: activeProject.chunks.some((c) => Boolean(c.audioBlobId)),
      4: activeProject.scenes.some((s) => Boolean(s.visualBlobId || s.remoteVideoUrl)),
      5: activeProject.scenes.length > 0,
      6: false,
    };
  }, [activeProject]);

  if (hydrating || !activeProject) {
    return (
      <div className="min-h-screen bg-[#0B0F17] flex items-center justify-center text-slate-300 gap-3 text-sm">
        <Loader2 className="w-5 h-5 animate-spin text-[#D99B26]" />
        <span>Belgesel Stüdyosu hazırlanıyor...</span>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#0B0F17] text-[#E6EAF2] flex flex-col">
      <TopBar
        project={activeProject}
        activeStep={activeProject.activeStep}
        onSelectStep={handleSelectStep}
        onRenameProject={(newName) =>
          updateActiveProject((prev) => ({ ...prev, name: newName }))
        }
        onOpenProjects={() => setProjectsOpen(true)}
        onOpenReadme={() => setReadmeOpen(true)}
        onOpenSettings={() => setSettingsOpen(true)}
        completedSteps={completedSteps}
      />

      <main className="flex-1 max-w-[1440px] w-full mx-auto px-6 py-8">
        {activeProject.activeStep === 1 && (
          <Step1Topic
            project={activeProject}
            onUpdateProject={updateActiveProject}
            onLoadDemo={() => void handleLoadDemo()}
            onNextStep={() => handleSelectStep(2)}
            onNotify={notify}
          />
        )}

        {activeProject.activeStep === 2 && (
          <Step2Script
            project={activeProject}
            onUpdateProject={updateActiveProject}
            onNextStep={() => handleSelectStep(3)}
            onNotify={notify}
          />
        )}

        {activeProject.activeStep === 3 && (
          <Step3TtsStudio
            project={activeProject}
            onUpdateProject={updateActiveProject}
            onNextStep={() => handleSelectStep(4)}
            onNotify={notify}
          />
        )}

        {activeProject.activeStep === 4 && (
          <Step4Storyboard
            project={activeProject}
            onUpdateProject={updateActiveProject}
            onNextStep={() => handleSelectStep(5)}
            onOpenSettings={() => setSettingsOpen(true)}
            onNotify={notify}
          />
        )}

        {activeProject.activeStep === 5 && (
          <Step5EditPreview
            project={activeProject}
            onUpdateProject={updateActiveProject}
            onNextStep={() => handleSelectStep(6)}
            onNotify={notify}
          />
        )}

        {activeProject.activeStep === 6 && (
          <Step6Export project={activeProject} onNotify={notify} />
        )}
      </main>

      {/* Modals & Drawers */}
      <SettingsDrawer
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        settings={activeProject.studioSettings}
        onChange={handleSettingsChange}
        serverHealth={serverHealth}
      />

      <ProjectsModal
        open={projectsOpen}
        onClose={() => setProjectsOpen(false)}
        projects={projects}
        activeProjectId={activeProject.id}
        onSelectProject={handleSelectProject}
        onCreateProject={(name) => void handleCreateProject(name)}
        onDeleteProject={(id) => void handleDeleteProject(id)}
        onImportedProject={handleImportedProject}
        onNotify={notify}
      />

      <ReadmeModal
        open={readmeOpen}
        onClose={() => setReadmeOpen(false)}
        project={activeProject}
      />

      {/* Toast Notifications */}
      {toasts.length > 0 && (
        <div className="fixed bottom-5 right-5 z-50 flex flex-col gap-2 max-w-md w-[calc(100vw-2.5rem)]">
          {toasts.map((t) => (
            <div
              key={t.id}
              className={`flex items-start gap-2.5 px-4 py-3 rounded-xl border shadow-xl text-xs leading-relaxed backdrop-blur-md ${
                t.tone === 'error'
                  ? 'bg-[#261216]/95 border-red-800/70 text-red-200'
                  : 'bg-[#161E2E]/95 border-slate-700/80 text-slate-100'
              }`}
            >
              {t.tone === 'error' ? (
                <AlertCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
              ) : (
                <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
              )}
              <span className="flex-1">{t.message}</span>
              <button
                type="button"
                onClick={() => setToasts((prev) => prev.filter((item) => item.id !== t.id))}
                className="text-slate-400 hover:text-white cursor-pointer"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

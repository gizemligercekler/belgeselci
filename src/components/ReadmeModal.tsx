import React, { useState } from 'react';
import { Check, Copy, Download, X } from 'lucide-react';
import { ProjectRecord } from '../types/studio';
import { generateTurkishReadme, triggerBrowserDownload } from '../utils/renderScriptGenerator';

interface ReadmeModalProps {
  open: boolean;
  onClose: () => void;
  project: ProjectRecord;
}

export const ReadmeModal: React.FC<ReadmeModalProps> = ({ open, onClose, project }) => {
  const [copied, setCopied] = useState(false);

  if (!open) return null;

  const readmeContent = generateTurkishReadme(project);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(readmeContent);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDownload = () => {
    const blob = new Blob([readmeContent], { type: 'text/markdown;charset=utf-8' });
    triggerBrowserDownload(blob, 'README.md');
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-xs">
      <div className="w-full max-w-3xl bg-[#111722] border border-slate-800 rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[85vh]">
        <div className="px-6 py-4 border-b border-slate-800 flex items-center justify-between gap-4">
          <div>
            <h2 className="font-editorial text-xl font-semibold text-slate-100">
              Kullanım Kılavuzu &amp; Yerel Render Rehberi
            </h2>
            <p className="text-xs text-slate-400 mt-0.5">
              ZIP paketine otomatik eklenen güncel Türkçe README.md içeriği
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleCopy}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs text-slate-200 bg-slate-800 hover:bg-slate-700 rounded-lg cursor-pointer"
            >
              {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
              <span>{copied ? 'Kopyalandı' : 'Kopyala'}</span>
            </button>
            <button
              type="button"
              onClick={handleDownload}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-[#0B0F17] bg-[#D99B26] hover:bg-[#E8AF3C] rounded-lg cursor-pointer"
            >
              <Download className="w-3.5 h-3.5" />
              <span>README.md İndir</span>
            </button>
            <button
              type="button"
              onClick={onClose}
              className="p-2 text-slate-400 hover:text-white rounded-lg hover:bg-slate-800/70 cursor-pointer"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-6 bg-[#0B0F17]">
          <pre className="whitespace-pre-wrap font-sans text-sm leading-relaxed text-slate-300">
            {readmeContent}
          </pre>
        </div>
      </div>
    </div>
  );
};

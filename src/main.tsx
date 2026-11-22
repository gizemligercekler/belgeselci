import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import './index.css';

interface ErrorBoundaryState {
  hasError: boolean;
  message: string;
}

class StudioErrorBoundary extends React.Component<
  { children: React.ReactNode },
  ErrorBoundaryState
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, message: '' };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return {
      hasError: true,
      message: error?.message || 'Beklenmeyen bir arayüz hatası oluştu.',
    };
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-[#0B0F17] text-slate-200 flex items-center justify-center p-6">
          <div className="max-w-md w-full bg-[#131924] border border-slate-800 rounded-2xl p-6 space-y-4">
            <h1 className="font-editorial text-xl font-semibold text-slate-100">
              Stüdyo Arayüzünde Bir Hata Oluştu
            </h1>
            <p className="text-xs text-slate-400 leading-relaxed font-mono break-words">
              {this.state.message}
            </p>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="px-4 py-2 text-xs font-semibold text-[#0B0F17] bg-[#D99B26] hover:bg-[#E8AF3C] rounded-lg cursor-pointer"
            >
              Sayfayı Yenile
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

createRoot(document.getElementById('root')!).render(
  <StudioErrorBoundary>
    <App />
  </StudioErrorBoundary>
);

import React from 'react';

const buildVersion = (import.meta as any).env?.VITE_UI_BUILD_VERSION || 'dev';

export default function App() {
  return (
    <div style={{ fontFamily: 'Arial, sans-serif', padding: 24 }}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: 12,
          marginBottom: 16,
        }}
      >
        <h1 style={{ margin: 0 }}>Greenhouse Resume Builder</h1>
        <span
          aria-label="build version"
          title={`Build ${buildVersion}`}
          style={{
            fontSize: 12,
            color: '#475569',
            background: '#f1f5f9',
            border: '1px solid #cbd5e1',
            borderRadius: 9999,
            padding: '4px 8px',
            whiteSpace: 'nowrap',
          }}
        >
          v{buildVersion}
        </span>
      </div>
      <p>Upload your resume and target job description to tailor your application materials.</p>
    </div>
  );
}

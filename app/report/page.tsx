'use client';
import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';

function ReportViewer() {
  const params = useSearchParams();
  const filePath = params.get('path');

  if (!filePath) {
    return (
      <div style={{ color: '#f87171', padding: 40, fontFamily: 'monospace' }}>
        Missing <code>?path=</code> parameter
      </div>
    );
  }

  const src = `/api/file?path=${encodeURIComponent(filePath)}`;

  return (
    <iframe
      src={src}
      style={{ width: '100%', height: '100vh', border: 'none', background: '#fff' }}
      title="Report"
      sandbox="allow-scripts allow-same-origin"
    />
  );
}

export default function ReportPage() {
  return (
    <Suspense fallback={<div style={{ color: '#94a3b8', padding: 40 }}>Loading…</div>}>
      <ReportViewer />
    </Suspense>
  );
}

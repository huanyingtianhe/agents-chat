import { ImageResponse } from 'next/og';

export const runtime = 'edge';

export const size = {
  width: 1200,
  height: 630,
};

export const contentType = 'image/png';

export default function OpenGraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '64px',
          background: 'linear-gradient(135deg, #111827 0%, #1f2937 55%, #0f172a 100%)',
          color: '#f8fafc',
          fontFamily: 'Inter, Segoe UI, Arial, sans-serif',
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: '20px', maxWidth: '760px' }}>
          <div
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '12px',
              width: 'fit-content',
              padding: '12px 18px',
              borderRadius: '999px',
              background: 'rgba(255,255,255,0.08)',
              border: '1px solid rgba(255,255,255,0.12)',
              fontSize: '22px',
              fontWeight: 700,
              letterSpacing: '-0.02em',
            }}
          >
            <span>🤖</span>
            <span>Agents Chat</span>
          </div>
          <div style={{ fontSize: '72px', fontWeight: 800, lineHeight: 1, letterSpacing: '-0.05em' }}>
            Chat with ACP agents
          </div>
          <div style={{ fontSize: '28px', lineHeight: 1.4, color: 'rgba(248,250,252,0.82)', maxWidth: '680px' }}>
            GitHub Copilot CLI, Claude Code, and scheduler-driven workflows in one place.
          </div>
        </div>
        <div
          style={{
            width: '220px',
            height: '220px',
            borderRadius: '32px',
            background: 'linear-gradient(180deg, rgba(255,255,255,0.12), rgba(255,255,255,0.04))',
            border: '1px solid rgba(255,255,255,0.14)',
            boxShadow: '0 24px 60px rgba(0,0,0,0.35)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <svg width="132" height="132" viewBox="0 0 100 100" fill="none" aria-hidden="true">
            <rect x="15" y="30" width="70" height="55" rx="12" fill="#6366f1" />
            <rect x="35" y="10" width="30" height="25" rx="8" fill="#818cf8" />
            <circle cx="36" cy="52" r="8" fill="#fff" />
            <circle cx="64" cy="52" r="8" fill="#fff" />
            <circle cx="36" cy="52" r="4" fill="#1e1b4b" />
            <circle cx="64" cy="52" r="4" fill="#1e1b4b" />
            <rect x="38" y="68" width="24" height="6" rx="3" fill="#c7d2fe" />
            <rect x="45" y="5" width="10" height="10" rx="5" fill="#a5b4fc" />
            <rect x="5" y="45" width="12" height="8" rx="4" fill="#818cf8" />
            <rect x="83" y="45" width="12" height="8" rx="4" fill="#818cf8" />
          </svg>
        </div>
      </div>
    ),
    size,
  );
}
import { ImageResponse } from 'next/og';

export const runtime = 'nodejs';

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
          justifyContent: 'center',
          background: 'radial-gradient(circle at 30% 20%, #374151 0%, #1f2937 38%, #0b1220 100%)',
          color: '#f8fafc',
          fontFamily: 'Inter, Segoe UI, Arial, sans-serif',
        }}
      >
        <div
          style={{
            width: '620px',
            height: '560px',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '26px',
            borderRadius: '36px',
            background: 'linear-gradient(160deg, rgba(30,41,59,0.86), rgba(15,23,42,0.94))',
            border: '1px solid rgba(255,255,255,0.14)',
            boxShadow: '0 30px 70px rgba(0,0,0,0.38)',
            textAlign: 'center',
            padding: '44px 52px',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: '164px',
              height: '164px',
              borderRadius: '34px',
              background: 'linear-gradient(180deg, rgba(129,140,248,0.36), rgba(99,102,241,0.25))',
              border: '1px solid rgba(165,180,252,0.45)',
            }}
          >
            <svg width="108" height="108" viewBox="0 0 100 100" fill="none" aria-hidden="true">
              <rect x="15" y="30" width="70" height="55" rx="12" fill="#6366f1" />
              <rect x="35" y="10" width="30" height="25" rx="8" fill="#818cf8" />
              <circle cx="36" cy="52" r="8" fill="#fff" />
              <circle cx="64" cy="52" r="8" fill="#fff" />
              <circle cx="36" cy="52" r="4" fill="#1e1b4b" />
              <circle cx="64" cy="52" r="4" fill="#1e1b4b" />
              <rect x="38" y="68" width="24" height="6" rx="3" fill="#c7d2fe" />
            </svg>
          </div>
          <div style={{ fontSize: '72px', fontWeight: 800, lineHeight: 1, letterSpacing: '-0.04em' }}>
            Agents Chat
          </div>
          <div style={{ fontSize: '30px', lineHeight: 1.35, color: 'rgba(248,250,252,0.86)', maxWidth: '520px' }}>
            Chat with multiple agents: GitHub Copilot CLI, Claude Code, and more.
          </div>
        </div>
      </div>
    ),
    size,
  );
}
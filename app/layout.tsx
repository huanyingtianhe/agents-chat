import './globals.css';
import './features/composer/components/ChatComposer.css';
import './features/chat/components/FailedSendControls.css';
import './features/chat/components/ChatSidebarList.css';
import './features/messages/components/MessageList.css';
import './features/layout/components/ChatShell.css';
import './features/agents/components/AgentsPanel.css';
import './features/nodes/components/NodesPanel.css';
import './features/files/components/FileWorkspacePanel.css';
import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import Providers from './providers';

const metadataBase = new URL(process.env.NEXTAUTH_URL || 'http://localhost:3010');

export const metadata: Metadata = {
  metadataBase,
  title: 'Agents Chat',
  description: 'Chat with multiple agents (GitHub Copilot CLI, Claude Code, etc.)',
  icons: {
    icon: [
      { url: '/favicon.svg', type: 'image/svg+xml' },
    ],
    apple: '/favicon.svg',
  },
  openGraph: {
    title: 'Agents Chat',
    description: 'Chat with multiple agents (GitHub Copilot CLI, Claude Code, etc.)',
    images: [{
      url: '/opengraph-image',
      width: 1200,
      height: 630,
      alt: 'Agents Chat preview',
    }],
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Agents Chat',
    description: 'Chat with multiple agents (GitHub Copilot CLI, Claude Code, etc.)',
    images: [{
      url: '/opengraph-image',
      width: 1200,
      height: 630,
      alt: 'Agents Chat preview',
    }],
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  interactiveWidget: 'resizes-content',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
      </head>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}

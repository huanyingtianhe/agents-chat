import './globals.css';
import './features/composer/components/ChatComposer.css';
import './features/chat/components/FailedSendControls.css';
import './features/chat/components/ChatSidebarList.css';
import './features/messages/components/MessageList.css';
import './features/layout/components/ChatShell.css';
import './features/agents/components/AgentsPanel.css';
import './features/nodes/components/NodesPanel.css';
import './features/files/components/FileWorkspacePanel.css';
import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import Providers from './providers';

export const metadata: Metadata = {
  title: 'Agents Chat',
  description: 'Chat with ACP agents (GitHub Copilot CLI, Claude Code, etc.)',
  icons: { icon: '/favicon.svg' },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🤖</text></svg>" />
      </head>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}

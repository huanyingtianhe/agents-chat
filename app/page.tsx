'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSession, signOut } from 'next-auth/react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/* ────────── Helpers ────────── */

// Detect file paths ending in .html/.htm in text and wrap them with report links
const HTML_FILE_RE = /(?:[A-Za-z]:\\|\/|~\/)[^\s"'<>*?|]+\.html?/gi;

function linkifyHtmlPaths(text: string): (string | { href: string; label: string })[] {
  const parts: (string | { href: string; label: string })[] = [];
  let last = 0;
  for (const m of text.matchAll(HTML_FILE_RE)) {
    const idx = m.index!;
    if (idx > last) parts.push(text.slice(last, idx));
    parts.push({ href: `/api/file?path=${encodeURIComponent(m[0])}`, label: m[0] });
    last = idx + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

// Custom ReactMarkdown components to linkify HTML file paths in code blocks and paragraphs
const mdComponents = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  code: (props: any) => {
    const { children, className, ...rest } = props;
    const text = String(children || '');
    if (HTML_FILE_RE.test(text) && !className) {
      HTML_FILE_RE.lastIndex = 0;
      const segments = linkifyHtmlPaths(text);
      return (
        <code {...rest} className={className}>
          {segments.map((s, i) =>
            typeof s === 'string' ? s : <a key={i} href={s.href} target="_blank" rel="noopener noreferrer" className="htmlFileLink">{s.label}</a>
          )}
        </code>
      );
    }
    return <code {...rest} className={className}>{children}</code>;
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  p: (props: any) => {
    const { children, ...rest } = props;
    // Process text children to linkify HTML paths
    const processed = Array.isArray(children) ? children : [children];
    const result = processed.flatMap((child: unknown, ci: number) => {
      if (typeof child !== 'string') return [child];
      if (!HTML_FILE_RE.test(child)) { HTML_FILE_RE.lastIndex = 0; return [child]; }
      HTML_FILE_RE.lastIndex = 0;
      const segments = linkifyHtmlPaths(child);
      return segments.map((s, si) =>
        typeof s === 'string' ? s : <a key={`${ci}-${si}`} href={s.href} target="_blank" rel="noopener noreferrer" className="htmlFileLink">{s.label}</a>
      );
    });
    return <p {...rest}>{result}</p>;
  },
};

/* ────────── Types ────────── */

type Agent = {
  id: string;
  name: string;
  command: string;
  args?: string[];
  cwd: string;
  yolo: boolean;
};

type PtyPhase = 'booting' | 'loading-environment' | 'idle-ready' | 'thinking' | 'replying';

type ContentPart =
  | { kind: 'thinking'; text: string }
  | { kind: 'tool'; toolName: string; args?: string; result?: string; done: boolean }
  | { kind: 'text'; text: string };

type ChatMessage = {
  id: string;
  type: 'user' | 'agent' | 'system';
  content: string;
  agentId?: string;
  ts: number;
  pending?: boolean;
  round?: number;
  relation?: string;
  summary?: boolean;
  statusText?: string;
  ptyPhase?: PtyPhase;
  parts?: ContentPart[];
};

type OrchestrationMode = 'discussion' | 'pipeline';

type SessionRunContext = {
  agentId: string;
  pendingId: string;
  orchestrationId: string;
  kind: 'worker' | 'summary';
  currentText: string;
  round?: number;
  relation?: string;
  ptyTurnId?: string;
  ptySendStarted?: boolean;
};

type OrchestrationState = {
  id: string;
  mode: OrchestrationMode;
  agentIds: string[];
  originalTask: string;
  results: Record<string, string>;
  nextIndex: number;
  summaryStarted: boolean;
  round: number;
  maxRounds: number;
};

/* ────────── Storage keys (UI prefs only — chat data is in SQLite) ────────── */

const STORAGE_CHAT_INPUT = 'acp_chat_input_v1';
const STORAGE_SIDEBAR_COLLAPSED = 'acp_chat_sidebar_collapsed_v1';
const STORAGE_INPUT_HISTORY = 'acp_input_history_v1';
const STORAGE_THEME = 'acp_chat_theme_v1';

const THEMES = {
  aurora: {
    label: 'Aurora',
    emoji: '🌌',
    values: {
      '--bg': '#07111f',
      '--bg-accent': 'radial-gradient(circle at top left, rgba(34,211,238,0.22), transparent 28%), radial-gradient(circle at top right, rgba(168,85,247,0.18), transparent 32%), linear-gradient(180deg, #09101d 0%, #07111f 100%)',
      '--header-bg': 'rgba(8, 14, 27, 0.88)',
      '--panel-bg': 'rgba(9, 15, 29, 0.78)',
      '--panel-strong': '#101a30',
      '--panel-soft': '#131f39',
      '--border': 'rgba(103, 232, 249, 0.16)',
      '--border-strong': 'rgba(103, 232, 249, 0.3)',
      '--text': '#e8f4ff',
      '--text-soft': '#9fb4d9',
      '--muted': '#7083a8',
      '--accent': '#45d7ff',
      '--accent-2': '#9b6bff',
      '--accent-soft': 'rgba(69, 215, 255, 0.12)',
      '--accent-strong': 'rgba(69, 215, 255, 0.22)',
      '--message-user': 'linear-gradient(135deg, rgba(69, 215, 255, 0.14), rgba(155, 107, 255, 0.14))',
      '--message-agent': 'rgba(9, 15, 29, 0.9)',
      '--summary-glow': 'rgba(168, 85, 247, 0.16)',
      '--input-bg': '#13203a',
      '--code-bg': '#0b1426',
      '--success': '#86efac',
      '--danger': '#ef4444',
      '--shadow': '0 20px 60px rgba(2, 8, 23, 0.45)',
    },
  },
  sunset: {
    label: 'Sunset',
    emoji: '🌇',
    values: {
      '--bg': '#160b12',
      '--bg-accent': 'radial-gradient(circle at top left, rgba(251,146,60,0.25), transparent 32%), radial-gradient(circle at top right, rgba(244,114,182,0.18), transparent 30%), linear-gradient(180deg, #1a0d16 0%, #120911 100%)',
      '--header-bg': 'rgba(28, 12, 20, 0.88)',
      '--panel-bg': 'rgba(24, 11, 19, 0.82)',
      '--panel-strong': '#2b1220',
      '--panel-soft': '#341625',
      '--border': 'rgba(251,146,60,0.16)',
      '--border-strong': 'rgba(244,114,182,0.28)',
      '--text': '#fff2f2',
      '--text-soft': '#f0b6bb',
      '--muted': '#bf8c94',
      '--accent': '#fb923c',
      '--accent-2': '#f472b6',
      '--accent-soft': 'rgba(251, 146, 60, 0.12)',
      '--accent-strong': 'rgba(244, 114, 182, 0.2)',
      '--message-user': 'linear-gradient(135deg, rgba(251,146,60,0.14), rgba(244,114,182,0.14))',
      '--message-agent': 'rgba(29, 13, 22, 0.9)',
      '--summary-glow': 'rgba(251,146,60,0.16)',
      '--input-bg': '#321726',
      '--code-bg': '#210d18',
      '--success': '#a7f3d0',
      '--danger': '#f87171',
      '--shadow': '0 22px 60px rgba(18, 5, 10, 0.45)',
    },
  },
  forest: {
    label: 'Forest',
    emoji: '🌲',
    values: {
      '--bg': '#081410',
      '--bg-accent': 'radial-gradient(circle at top left, rgba(16,185,129,0.2), transparent 28%), radial-gradient(circle at bottom right, rgba(132,204,22,0.16), transparent 24%), linear-gradient(180deg, #0a1611 0%, #07110d 100%)',
      '--header-bg': 'rgba(8, 19, 15, 0.88)',
      '--panel-bg': 'rgba(10, 22, 17, 0.8)',
      '--panel-strong': '#11271d',
      '--panel-soft': '#173126',
      '--border': 'rgba(74, 222, 128, 0.14)',
      '--border-strong': 'rgba(52, 211, 153, 0.28)',
      '--text': '#ecfff4',
      '--text-soft': '#b5d9c4',
      '--muted': '#7ca191',
      '--accent': '#34d399',
      '--accent-2': '#84cc16',
      '--accent-soft': 'rgba(52, 211, 153, 0.11)',
      '--accent-strong': 'rgba(132, 204, 22, 0.18)',
      '--message-user': 'linear-gradient(135deg, rgba(52,211,153,0.13), rgba(132,204,22,0.13))',
      '--message-agent': 'rgba(10, 22, 17, 0.9)',
      '--summary-glow': 'rgba(52,211,153,0.16)',
      '--input-bg': '#173126',
      '--code-bg': '#0d1b14',
      '--success': '#bbf7d0',
      '--danger': '#f87171',
      '--shadow': '0 20px 60px rgba(3, 10, 7, 0.48)',
    },
  },
  pearl: {
    label: 'Pearl',
    emoji: '☁️',
    values: {
      '--bg': '#eef2f8',
      '--bg-accent': 'radial-gradient(circle at top left, rgba(59,130,246,0.12), transparent 28%), radial-gradient(circle at top right, rgba(236,72,153,0.08), transparent 24%), linear-gradient(180deg, #f8fbff 0%, #edf2f8 100%)',
      '--header-bg': 'rgba(255, 255, 255, 0.86)',
      '--panel-bg': 'rgba(255, 255, 255, 0.72)',
      '--panel-strong': '#ffffff',
      '--panel-soft': '#f4f7fb',
      '--border': 'rgba(15, 23, 42, 0.08)',
      '--border-strong': 'rgba(59, 130, 246, 0.2)',
      '--text': '#132238',
      '--text-soft': '#52627a',
      '--muted': '#748196',
      '--accent': '#2563eb',
      '--accent-2': '#ec4899',
      '--accent-soft': 'rgba(37, 99, 235, 0.08)',
      '--accent-strong': 'rgba(236, 72, 153, 0.12)',
      '--message-user': 'linear-gradient(135deg, rgba(37,99,235,0.08), rgba(236,72,153,0.08))',
      '--message-agent': 'rgba(255,255,255,0.86)',
      '--summary-glow': 'rgba(37,99,235,0.12)',
      '--input-bg': '#ffffff',
      '--code-bg': '#f3f6fb',
      '--success': '#16a34a',
      '--danger': '#dc2626',
      '--shadow': '0 20px 50px rgba(148, 163, 184, 0.18)',
    },
  },
  velvet: {
    label: 'Velvet',
    emoji: '🪄',
    values: {
      '--bg': '#120b1d',
      '--bg-accent': 'radial-gradient(circle at top left, rgba(217,70,239,0.22), transparent 30%), radial-gradient(circle at bottom right, rgba(59,130,246,0.16), transparent 26%), linear-gradient(180deg, #160d23 0%, #0f0918 100%)',
      '--header-bg': 'rgba(18, 10, 30, 0.9)',
      '--panel-bg': 'rgba(19, 11, 31, 0.82)',
      '--panel-strong': '#1a102b',
      '--panel-soft': '#23153a',
      '--border': 'rgba(217, 70, 239, 0.16)',
      '--border-strong': 'rgba(96, 165, 250, 0.22)',
      '--text': '#f7ecff',
      '--text-soft': '#cbb9df',
      '--muted': '#8d7aa6',
      '--accent': '#d946ef',
      '--accent-2': '#60a5fa',
      '--accent-soft': 'rgba(217, 70, 239, 0.12)',
      '--accent-strong': 'rgba(96, 165, 250, 0.14)',
      '--message-user': 'linear-gradient(135deg, rgba(217,70,239,0.14), rgba(96,165,250,0.12))',
      '--message-agent': 'rgba(20, 11, 31, 0.92)',
      '--summary-glow': 'rgba(217,70,239,0.14)',
      '--input-bg': '#23153a',
      '--code-bg': '#150e24',
      '--success': '#86efac',
      '--danger': '#fb7185',
      '--shadow': '0 24px 64px rgba(10, 6, 18, 0.5)',
    },
  },
} as const;

type ThemeId = keyof typeof THEMES;

/* ────────── Helpers ────────── */

function mapTurnPhase(phase: string): PtyPhase | undefined {
  switch (phase) {
    case 'booting': return 'loading-environment';
    case 'thinking': return 'thinking';
    case 'tool_exec': return 'thinking';
    case 'replying': return 'replying';
    case 'done': return 'idle-ready';
    default: return undefined;
  }
}

function makeId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function formatMessageTime(ts: number) {
  if (!ts) return '';
  return new Intl.DateTimeFormat('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date(ts));
}

function getMentionedAgentIds(text: string, agents: Agent[]) {
  const matches = [...text.matchAll(/@(\S+)/g)];
  const seen = new Set<string>();
  const selected: string[] = [];
  for (const match of matches) {
    const rawId = match[1];
    const agent = agents.find((a) => a.id.toLowerCase() === rawId.toLowerCase());
    if (agent && !seen.has(agent.id)) {
      seen.add(agent.id);
      selected.push(agent.id);
    }
  }
  return selected;
}

function parseAgents(text: string, agents: Agent[]) {
  const agentIds = getMentionedAgentIds(text, agents);
  if (agentIds.length === 0) {
    const fallback = agents[0] || { id: 'main', name: 'Main' };
    return { agentIds: [fallback.id], message: text };
  }
  const message = text.replace(/(?:^|\s)@(\S+)/g, '').trim();
  return { agentIds, message: message || text };
}

/* ────────── ACP API helper ────────── */

/** Extract the current (last) session ID — handles both string and string[] from SQLite. */
function lastSessionId(val: unknown): string | null {
  if (Array.isArray(val)) return val.length > 0 ? val[val.length - 1] : null;
  if (typeof val === 'string' && val) return val;
  return null;
}

async function acpApi(body: Record<string, unknown>) {
  const res = await fetch('/api/acp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

/* ────────── Page Component ────────── */

export default function Page() {
  const { data: session, status: authStatus } = useSession();
  const isAdmin = (session?.user as any)?.role === 'admin';
  // Derive a stable userId for multi-user session isolation
  const userId = (session?.user as any)?.email || (session?.user as any)?.name || 'anonymous';

  // Wrapper that injects userId into every ACP API call
  const acp = useCallback((body: Record<string, unknown>) => {
    return acpApi({ ...body, userId });
  }, [userId]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([
    { id: 'welcome', type: 'system', content: 'Welcome to Agents Chat. Messages auto-route to the default agent, or type @agent to target one or more agents.', ts: 0 },
  ]);
  const [input, setInput] = useState('');
  const [mounted, setMounted] = useState(false);
  const [mentionSelectedIndex, setMentionSelectedIndex] = useState(0);
  const [orchestrationMode, setOrchestrationMode] = useState<OrchestrationMode>('discussion');
  const [discussionRounds, setDiscussionRounds] = useState(2);
  const [selectedAgentFilter, setSelectedAgentFilter] = useState<string | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [expandedMessages, setExpandedMessages] = useState<Record<string, boolean>>({});
  const [isSending, setIsSending] = useState(false);
  const [chatName, setChatName] = useState('New Chat');
  const [chatCounter, setChatCounter] = useState(1);
  const [currentChatId, setCurrentChatId] = useState<string>('chat-1');
  const [showAgentsPanel, setShowAgentsPanel] = useState(false);
  const [chatHistory, setChatHistory] = useState<{ id: string; name: string; ts: number; agentSessions?: Record<string, string> }[]>([]);
  const [agentsLoading, setAgentsLoading] = useState(true);
  const [themeId, setThemeId] = useState<ThemeId>('aurora');
  const [showThemeMenu, setShowThemeMenu] = useState(false);
  const [showChatsPanel, setShowChatsPanel] = useState(false);

  // Add agent form
  const [showAddAgent, setShowAddAgent] = useState(false);
  const [newAgentForm, setNewAgentForm] = useState({ id: '', name: '', command: '', args: '', cwd: '', yolo: true });
  const [addAgentLoading, setAddAgentLoading] = useState(false);

  // Agent settings
  const [showAgentSettings, setShowAgentSettings] = useState(false);
  const [settingsAgentId, setSettingsAgentId] = useState<string | null>(null);
  const [settingsAgentConfig, setSettingsAgentConfig] = useState<Agent | null>(null);
  const [agentSettingsLoading, setAgentSettingsLoading] = useState(false);

  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const currentChatIdRef = useRef(currentChatId);
  currentChatIdRef.current = currentChatId;
  const chatNameRef = useRef(chatName);
  chatNameRef.current = chatName;
  const sessionRunsRef = useRef<Record<string, SessionRunContext>>({});
  const orchestrationsRef = useRef<Record<string, OrchestrationState>>({});
  const chatContainerRef = useRef<HTMLDivElement | null>(null);
  const themeMenuRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const inputHistoryRef = useRef<string[]>([]);
  const inputHistoryIndexRef = useRef(-1);
  const inputDraftRef = useRef('');
  const needsContextRestoreRef = useRef(false);

  /* ── Derived ── */

  const filteredAgents = useMemo(() => {
    const match = input.match(/@(\S*)$/);
    if (!match) return [];
    const q = match[1].toLowerCase();
    return agents.filter((a) => a.id.toLowerCase().includes(q) || a.name?.toLowerCase().includes(q));
  }, [input, agents]);

  const mentionedAgentIds = useMemo(() => getMentionedAgentIds(input, agents), [input, agents]);
  const orchestrationEnabled = mentionedAgentIds.length > 1;

  const agentSidebarItems = useMemo(() => {
    return agents.map((agent) => {
      const running = messages.some((m) => m.agentId === agent.id && m.pending);
      return { ...agent, running };
    });
  }, [agents, messages]);

  const activeTheme = THEMES[themeId];
  const themeStyle = activeTheme.values as React.CSSProperties;
  const mobilePanelOpen = showChatsPanel || showAgentsPanel;

  const visibleMessages = useMemo(() => {
    if (!selectedAgentFilter) return messages;
    return messages.filter((m) => m.type !== 'agent' || m.agentId === selectedAgentFilter);
  }, [messages, selectedAgentFilter]);

  /* ── Effects ── */

  useEffect(() => { setMentionSelectedIndex(0); }, [input, agents]);

  useEffect(() => {
    setMounted(true);
    const savedInput = window.localStorage.getItem(STORAGE_CHAT_INPUT);
    const savedCollapsed = window.localStorage.getItem(STORAGE_SIDEBAR_COLLAPSED);

    if (savedInput) setInput(savedInput);
    if (savedCollapsed != null) setSidebarCollapsed(savedCollapsed === '1');

    // Load chat history + last active chat from server (SQLite is source of truth)
    fetch('/api/chats').then(r => r.json()).then(data => {
      if (data.ok && Array.isArray(data.chats)) setChatHistory(data.chats);
      const lastChatId = data.lastChatId as string | null;
      if (lastChatId) {
        setCurrentChatId(lastChatId);
        // Load that chat's messages from server
        fetch(`/api/chats?id=${encodeURIComponent(lastChatId)}`)
          .then(r => r.json())
          .then(chatData => {
            if (chatData.ok && chatData.chat) {
              const msgs = chatData.chat.messages || [];
              setMessages(msgs.length > 0 ? msgs : [{ id: 'welcome', type: 'system', content: 'Welcome to Agents Chat. Messages auto-route to the default agent, or type @agent to target a specific one.', ts: 0 }]);
              setChatName(chatData.chat.name || lastChatId);
              needsContextRestoreRef.current = true;
            }
          })
          .catch(() => { /* ignore */ });
      }
    }).catch(() => { /* ignore */ });

    try {
      const savedInputHistory = window.localStorage.getItem(STORAGE_INPUT_HISTORY);
      if (savedInputHistory) inputHistoryRef.current = JSON.parse(savedInputHistory) || [];
    } catch { /* ignore */ }
    try {
      const savedTheme = window.localStorage.getItem(STORAGE_THEME);
      if (savedTheme && savedTheme in THEMES) setThemeId(savedTheme as ThemeId);
    } catch { /* ignore */ }
    void loadAgents();
  }, []);

  useEffect(() => {
    const el = chatContainerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  useEffect(() => {
    const el = composerRef.current;
    if (!el) return;
    const singleLineHeight = 28;
    const maxHeight = 180;

    el.style.height = `${singleLineHeight}px`;
    const nextHeight = Math.min(Math.max(el.scrollHeight, singleLineHeight), maxHeight);
    el.style.height = `${nextHeight}px`;
    el.style.overflowY = el.scrollHeight > maxHeight ? 'auto' : 'hidden';
  }, [input]);

  // Resume agent sessions once after auth state is determined
  const sessionResumedRef = useRef(false);
  useEffect(() => {
    if (!mounted || authStatus === 'loading') return;
    if (sessionResumedRef.current) return;
    sessionResumedRef.current = true;
    const activeChatId = currentChatIdRef.current;
    if (!activeChatId || activeChatId === 'chat-1') return;
    needsContextRestoreRef.current = true;
    fetch(`/api/chats?id=${encodeURIComponent(activeChatId)}`)
      .then(r => r.json())
      .then(async (data: any) => {
        if (data.ok && data.chat) {
          const sessions = data.chat.agentSessions || {};
          const entries = Object.entries(sessions)
            .map(([agentId, raw]) => [agentId, lastSessionId(raw)] as [string, string | null])
            .filter(([, sid]) => !!sid) as [string, string][];
          if (entries.length > 0) {
            const results = await Promise.allSettled(
              entries.map(([agentId, sessionId]) =>
                acp({ action: 'resume-session', agentId, sessionId, chatId: activeChatId })
              )
            );
            const allLoaded = results.every(
              r => r.status === 'fulfilled' && (r as any).value?.loaded === true
            );
            if (allLoaded) {
              needsContextRestoreRef.current = false;
            }
            // Handle recovered messages and pending user messages from session/load replay
            for (const r of results) {
              if (r.status !== 'fulfilled') continue;
              const val = (r as any).value;
              // Append recovered agent messages that were in ACP but missing from our DB
              if (val?.recoveredMessages?.length > 0) {
                for (const rm of val.recoveredMessages) {
                  addMessage({ type: 'agent', content: rm.content, agentId: rm.agentId, ts: rm.ts });
                }
                addMessage({ type: 'system', content: `✅ Recovered ${val.recoveredMessages.length} message(s) from previous session.` });
              }
              // Auto-resend pending user message that was never answered
              if (val?.pendingUserMessage) {
                const agentId = entries[0]?.[0];
                if (agentId) {
                  addMessage({ type: 'system', content: '🔄 Re-sending unanswered message from previous session...' });
                  setIsSending(true);
                  const orchestrationId = `orch-${makeId()}`;
                  void dispatchToAgent(agentId, val.pendingUserMessage, orchestrationId, 'worker');
                }
              }
            }
          }
        }
      })
      .catch(() => { /* ignore */ });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mounted, authStatus, acp]);

  useEffect(() => {
    if (!mounted) return;
    window.localStorage.setItem(STORAGE_CHAT_INPUT, input);
  }, [input, mounted]);

  useEffect(() => {
    if (!mounted) return;
    window.localStorage.setItem(STORAGE_SIDEBAR_COLLAPSED, sidebarCollapsed ? '1' : '0');
  }, [sidebarCollapsed, mounted]);

  useEffect(() => {
    if (!mounted) return;
    window.localStorage.setItem(STORAGE_THEME, themeId);
  }, [themeId, mounted]);

  useEffect(() => {
    if (!showThemeMenu) return;
    function handlePointerDown(event: MouseEvent) {
      if (!themeMenuRef.current?.contains(event.target as Node)) {
        setShowThemeMenu(false);
      }
    }
    window.addEventListener('mousedown', handlePointerDown);
    return () => window.removeEventListener('mousedown', handlePointerDown);
  }, [showThemeMenu]);

  /* ── Core functions ── */

  function addMessage(msg: Omit<ChatMessage, 'id' | 'ts'> & { id?: string; ts?: number }) {
    const next: ChatMessage = { id: msg.id || makeId(), ts: msg.ts || Date.now(), ...msg };
    messagesRef.current = [...messagesRef.current, next];
    setMessages(messagesRef.current);
    return next.id;
  }

  function updateMessage(id: string, patch: Partial<ChatMessage>) {
    messagesRef.current = messagesRef.current.map((m) => (m.id === id ? { ...m, ...patch } : m));
    setMessages(messagesRef.current);
  }

  async function loadAgents() {
    setAgentsLoading(true);
    try {
      const data = await acp({ action: 'list-agents' });
      if (data.ok && Array.isArray(data.agents)) {
        setAgents(data.agents);
      }
    } catch (err) {
      console.error('Failed to load agents', err);
    } finally {
      setAgentsLoading(false);
    }
  }

  /* ── ACP Send & Poll ── */

  async function sendAcpPrompt(runKey: string, agentId: string, pendingId: string, content: string) {
    const run = sessionRunsRef.current[runKey];
    if (!run || run.ptySendStarted) return false;

    run.ptySendStarted = true;
    updateMessage(pendingId, { statusText: 'Connecting', pending: true, ptyPhase: 'loading-environment' });

    // Include chat history only when session needs context restoration
    // (after restart, imported chat, etc.)
    const sendBody: Record<string, unknown> = { action: 'send', agentId, text: content, chatId: currentChatId };
    if (needsContextRestoreRef.current) {
      sendBody.chatHistory = messages
        .filter(m => m.type === 'user' || m.type === 'agent')
        .slice(-20)
        .map(m => ({ type: m.type, content: m.content, agentId: (m as any).agentId }));
      needsContextRestoreRef.current = false;
    }
    const sendResult = await acp(sendBody);
    const current = sessionRunsRef.current[runKey];
    if (!current) return false;

    // Handle send failures (e.g. turn_in_progress, session errors)
    if (sendResult && !sendResult.ok) {
      updateMessage(pendingId, {
        content: `⚠️ ${sendResult.error || 'Send failed'}`,
        pending: false,
      });
      finalizeRun(runKey);
      return false;
    }

    current.ptyTurnId = sendResult?.turn?.id;

    if (sendResult?.phase === 'booting') {
      updateMessage(pendingId, { statusText: 'Starting environment', ptyPhase: 'loading-environment', pending: true });
    }

    void pollAcpAgent(agentId);
    return true;
  }

  async function dispatchToAgent(
    agentId: string,
    content: string,
    orchestrationId: string,
    kind: 'worker' | 'summary' = 'worker',
    options?: { round?: number; relation?: string; summary?: boolean },
  ) {
    const pendingId = `pending-${makeId()}`;
    addMessage({
      id: pendingId,
      type: 'agent',
      content: '',
      agentId,
      pending: true,
      round: options?.round,
      relation: options?.relation,
      summary: options?.summary,
    });

    const runKey = `acp:${agentId}`;
    sessionRunsRef.current[runKey] = {
      agentId, pendingId, orchestrationId, kind,
      currentText: '',
      round: options?.round,
      relation: options?.relation,
    };

    await sendAcpPrompt(runKey, agentId, pendingId, content);
    return runKey;
  }

  function finalizeRun(runKey: string) {
    const run = sessionRunsRef.current[runKey];
    if (!run) return;

    setIsSending(false);
    updateMessage(run.pendingId, { pending: false, statusText: undefined, ptyPhase: undefined });
    const orchestration = orchestrationsRef.current[run.orchestrationId];
    if (orchestration && run.kind === 'worker') {
      orchestration.results[run.agentId] = run.currentText || '';
      void maybeAdvanceOrchestration(run.orchestrationId);
    }
    delete sessionRunsRef.current[runKey];
  }

  async function pollAcpAgent(agentId: string) {
    const runKey = `acp:${agentId}`;
    let consecutiveErrors = 0;
    const MAX_ERRORS = 10;
    const POLL_TIMEOUT = 10 * 60_000; // 10 min safety timeout
    let lastActivity = Date.now();

    while (sessionRunsRef.current[runKey]) {
      const current = sessionRunsRef.current[runKey];
      if (!current) break;

      // Safety timeout — don't poll forever (resets on each successful poll)
      if (Date.now() - lastActivity > POLL_TIMEOUT) {
        updateMessage(current.pendingId, {
          content: current.currentText || '⚠️ Response timed out',
          pending: false,
        });
        finalizeRun(runKey);
        return;
      }

      let result: any;
      try {
        result = await acp({ action: 'poll', agentId });
      } catch (err) {
        consecutiveErrors++;
        if (consecutiveErrors >= MAX_ERRORS) {
          updateMessage(current.pendingId, {
            content: current.currentText || `⚠️ Lost connection to agent (${err instanceof Error ? err.message : 'network error'})`,
            pending: false,
          });
          finalizeRun(runKey);
          return;
        }
        await new Promise((r) => setTimeout(r, 1000 * consecutiveErrors));
        continue;
      }
      consecutiveErrors = 0;
      lastActivity = Date.now();

      const turn = result?.activeTurn as {
        fullText?: string;
        done?: boolean;
        phase?: string;
        statusText?: string;
        error?: string;
        events?: { type: string; ts: number; toolName?: string; toolCallId?: string; toolArgs?: string; toolResult?: string; text?: string }[];
      } | null;

      if (turn) {
        const ptyPhase = mapTurnPhase(turn.phase || '');
        const phaseStatusMap: Record<string, string> = {
          thinking: 'Thinking',
          tool_exec: 'Executing tool',
          replying: 'Generating response',
          booting: 'Starting environment',
        };
        const statusText = turn.statusText || phaseStatusMap[turn.phase || ''] || '';

        // Build content parts from events in chronological order
        const parts: ContentPart[] = [];
        const toolMap = new Map<string, ContentPart & { kind: 'tool' }>();
        if (turn.events) {
          for (const evt of turn.events) {
            if (evt.type === 'thinking' && evt.text) {
              const last = parts[parts.length - 1];
              if (last && last.kind === 'thinking') {
                last.text += evt.text;
              } else {
                parts.push({ kind: 'thinking', text: evt.text });
              }
            } else if (evt.type === 'tool_start' && evt.toolName) {
              const tp: ContentPart & { kind: 'tool' } = { kind: 'tool', toolName: evt.toolName, args: evt.toolArgs, done: false };
              if (evt.toolCallId) toolMap.set(evt.toolCallId, tp);
              parts.push(tp);
            } else if (evt.type === 'tool_complete') {
              const existing = evt.toolCallId ? toolMap.get(evt.toolCallId) : null;
              if (existing) {
                existing.result = evt.toolResult;
                existing.done = true;
              } else {
                parts.push({ kind: 'tool', toolName: evt.toolName || 'tool', result: evt.toolResult, done: true });
              }
            } else if (evt.type === 'text_chunk' && evt.text) {
              const last = parts[parts.length - 1];
              if (last && last.kind === 'text') {
                last.text += evt.text;
              } else {
                parts.push({ kind: 'text', text: evt.text });
              }
            }
          }
        }

        const serverText = (turn.fullText || '').trim();
        const effectiveStatus = statusText || '';

        if (turn.done) {
          updateMessage(current.pendingId, {
            content: serverText || (turn.error ? `⚠️ ${turn.error}` : ''),
            pending: false,
            parts: parts.length ? parts : undefined,
          });
          await acp({ action: 'turn-clear', agentId }).catch(() => null);
          finalizeRun(runKey);
          // Auto-save chat to persist agent sessions after each turn
          void saveCurrentChatToHistory();
          return;
        } else {
          const patch: Partial<ChatMessage> = {
            pending: true,
            ptyPhase: mapTurnPhase(turn.phase || ''),
            statusText: effectiveStatus,
            parts: parts.length ? parts : undefined,
          };
          if (serverText) {
            patch.content = serverText;
            current.currentText = serverText;
          }
          updateMessage(current.pendingId, patch);
        }
      }

      await new Promise((r) => setTimeout(r, 800));
    }
  }

  /* ── Orchestration ── */

  async function maybeAdvanceOrchestration(orchestrationId: string) {
    const state = orchestrationsRef.current[orchestrationId];
    if (!state || state.summaryStarted) return;

    if (state.mode === 'discussion') {
      const allDone = state.agentIds.every((id) => typeof state.results[id] === 'string');
      if (!allDone) return;

      if (state.round < state.maxRounds) {
        const prev = { ...state.results };
        state.results = {};
        state.round += 1;
        await Promise.all(state.agentIds.map((id) => {
          const others = state.agentIds.filter((x) => x !== id)
            .map((x) => `## ${x}'s perspective\n${prev[x] || '(no result)'}`).join('\n\n');
          const prompt = [
            `You are in round ${state.round} of a multi-agent discussion.`,
            `Original task: ${state.originalTask}`, '',
            `Below are other agents' perspectives from the previous round. Please respond:`,
            '1. State which points you agree with and from whom',
            '2. State which points you disagree with or want to revise',
            '3. Provide your updated perspective for this round', '', others,
          ].join('\n');
          return dispatchToAgent(id, prompt, orchestrationId, 'worker', {
            round: state.round, relation: `Responding to round ${state.round - 1} perspectives`,
          });
        }));
        return;
      }

      state.summaryStarted = true;
      const summaryPrompt = [
        'You are the final coordinator. Please summarize the conclusions from this multi-agent discussion.',
        `Original task: ${state.originalTask}`, `Total rounds: ${state.maxRounds}`, '',
        ...state.agentIds.map((id) => `## ${id}\n${state.results[id] || '(no result)'}`), '',
        'Please output:', '1. Consensus reached', '2. Remaining disagreements', '3. Final recommended plan',
      ].join('\n');
      const summaryAgent = state.agentIds[0] || 'main';
      await dispatchToAgent(summaryAgent, summaryPrompt, orchestrationId, 'summary', { relation: 'Final conclusion', summary: true });
      return;
    }

    if (state.mode === 'pipeline') {
      if (state.nextIndex < state.agentIds.length) {
        const prevId = state.agentIds[state.nextIndex - 1];
        const nextId = state.agentIds[state.nextIndex];
        const context = state.agentIds.slice(0, state.nextIndex)
          .map((id) => `## ${id}\n${state.results[id] || '(no result)'}`).join('\n\n');
        const prompt = [
          'You are participating in a multi-agent pipeline task.',
          `Original task: ${state.originalTask}`,
          prevId ? 'Please continue based on the previous agent output.' : 'Please provide your initial result.',
          context ? `\nExisting context:\n${context}` : '',
        ].filter(Boolean).join('\n');
        state.nextIndex += 1;
        await dispatchToAgent(nextId, prompt, orchestrationId, 'worker', {
          round: state.nextIndex + 1, relation: prevId ? `Based on ${prevId}'s output` : 'Pipeline initial step',
        });
        return;
      }

      state.summaryStarted = true;
      const summaryPrompt = [
        'You are the final coordinator. Please summarize the results of this serial multi-agent pipeline.',
        `Original task: ${state.originalTask}`, '',
        ...state.agentIds.map((id) => `## ${id}\n${state.results[id] || '(no result)'}`), '',
        'Please output the final conclusion and next steps.',
      ].join('\n');
      const summaryAgent = state.agentIds[0] || 'main';
      await dispatchToAgent(summaryAgent, summaryPrompt, orchestrationId, 'summary', { relation: 'Final conclusion', summary: true });
    }
  }

  /* ── Send handler ── */

  async function handleSend() {
    const text = input.trim();
    if (!text || agents.length === 0) return;

    const { agentIds, message } = parseAgents(text, agents);
    const useOrchestration = agentIds.length > 1;
    const orchestrationId = `orch-${makeId()}`;

    if (useOrchestration) {
      orchestrationsRef.current[orchestrationId] = {
        id: orchestrationId, mode: orchestrationMode, agentIds,
        originalTask: message || text, results: {},
        nextIndex: orchestrationMode === 'pipeline' ? 1 : 0,
        summaryStarted: false,
        round: orchestrationMode === 'discussion' ? 1 : 0,
        maxRounds: orchestrationMode === 'discussion' ? discussionRounds : 1,
      };
    }

    setIsSending(true);
    addMessage({ type: 'user', content: text });
    setInput('');

    // Persist user message to SQLite immediately (don't wait for agent response)
    void saveCurrentChatToHistory();

    // Save to input history
    const hist = inputHistoryRef.current;
    if (hist[hist.length - 1] !== text) hist.push(text);
    if (hist.length > 100) hist.splice(0, hist.length - 100);
    inputHistoryIndexRef.current = -1;
    inputDraftRef.current = '';
    try { window.localStorage.setItem(STORAGE_INPUT_HISTORY, JSON.stringify(hist)); } catch { /* ignore */ }

    try {
      const effectiveMessage = message || text;

      if (!useOrchestration) {
        await dispatchToAgent(agentIds[0], effectiveMessage, orchestrationId, 'worker');
        return;
      }
      if (orchestrationMode === 'discussion') {
        await Promise.all(agentIds.map((id) => dispatchToAgent(id, effectiveMessage, orchestrationId, 'worker', { round: 1, relation: 'Round 1 independent perspective' })));
      } else {
        await dispatchToAgent(agentIds[0], effectiveMessage, orchestrationId, 'worker', { round: 1, relation: 'Pipeline initial step' });
      }
    } catch (err) {
      setIsSending(false);
      addMessage({ type: 'system', content: `Send failed: ${err instanceof Error ? err.message : String(err)}` });
    }
  }

  async function handleStop() {
    // Interrupt all active agent runs
    const activeRuns = { ...sessionRunsRef.current };
    const agentIds = new Set<string>();
    for (const run of Object.values(activeRuns)) {
      agentIds.add(run.agentId);
    }

    for (const agentId of agentIds) {
      try {
        await acp({ action: 'interrupt', agentId });
      } catch { /* ignore */ }
    }

    // Finalize all pending runs
    for (const [runKey, run] of Object.entries(activeRuns)) {
      updateMessage(run.pendingId, {
        content: run.currentText || '⏹ Stopped',
        pending: false,
        statusText: undefined,
        ptyPhase: undefined,
      });
      delete sessionRunsRef.current[runKey];
    }

    // Clear orchestrations
    orchestrationsRef.current = {};
    setIsSending(false);
    addMessage({ type: 'system', content: '⏹ Conversation stopped.' });
  }

  /* ── Agent settings ── */

  async function openAgentSettings(agentId: string) {
    setSettingsAgentId(agentId);
    setSettingsAgentConfig(null);
    setShowAgentSettings(true);
    setAgentSettingsLoading(true);
    try {
      const data = await acp({ action: 'get-agent-config', agentId });
      if (data.ok) setSettingsAgentConfig(data.agent);
    } catch (err) {
      console.error('Failed to load agent config', err);
    } finally {
      setAgentSettingsLoading(false);
    }
  }

  async function saveAgentSettings() {
    if (!settingsAgentId || !settingsAgentConfig) return;
    setAgentSettingsLoading(true);
    try {
      const data = await acp({
        action: 'update-agent-config', agentId: settingsAgentId,
        updates: {
          name: settingsAgentConfig.name,
          command: settingsAgentConfig.command,
          args: settingsAgentConfig.args,
          cwd: settingsAgentConfig.cwd,
          yolo: settingsAgentConfig.yolo,
        },
      });
      if (data.ok) {
        setShowAgentSettings(false);
        await loadAgents();
        addMessage({ type: 'system', content: data.restarted ? `⚙️ ${settingsAgentConfig.name} settings updated, restarting...` : `⚙️ ${settingsAgentConfig.name} settings saved` });
      }
    } catch (err) {
      console.error('Failed to save agent settings', err);
    } finally {
      setAgentSettingsLoading(false);
    }
  }

  /* ── Create agent ── */

  async function createAgent() {
    const { id, name, command, args, cwd, yolo } = newAgentForm;
    const trimmedId = id.trim();
    if (!trimmedId) return;
    setAddAgentLoading(true);
    try {
      const data = await acp({
        action: 'create-agent',
        agent: {
          id: trimmedId,
          name: name.trim() || trimmedId,
          command: command.trim() || 'copilot.exe',
          args: args.trim() ? args.trim().split(/\s+/) : ['--acp'],
          cwd: cwd.trim(),
          yolo,
        },
      });
      if (data.ok) {
        await loadAgents();
        addMessage({ type: 'system', content: `✅ Agent "${name.trim() || trimmedId}" created` });
        setShowAddAgent(false);
        setNewAgentForm({ id: '', name: '', command: '', args: '', cwd: '', yolo: true });
      } else {
        addMessage({ type: 'system', content: `❌ Failed: ${data.error}` });
      }
    } catch {
      addMessage({ type: 'system', content: '❌ Failed to create agent' });
    } finally {
      setAddAgentLoading(false);
    }
  }

  /* ── New chat ── */

  async function saveCurrentChatToHistory() {
    const currentMessages = messagesRef.current;
    const currentId = currentChatIdRef.current;
    const currentName = chatNameRef.current;
    const userMsgs = currentMessages.filter(m => m.type === 'user');
    const name = userMsgs.length > 0 ? userMsgs[0].content.slice(0, 50) : currentName;
    const persistable = currentMessages.filter(m => !m.pending && !(m.type === 'system' && m.ts !== 0));

    // Get current agent session IDs from SQLite (each chat stores its own sessions)
    let agentSessions: Record<string, string> = {};
    try {
      const existing = await fetch(`/api/chats?id=${encodeURIComponent(currentId)}`).then(r => r.json());
      if (existing.ok && existing.chat?.agentSessions) {
        agentSessions = existing.chat.agentSessions;
      }
    } catch { /* ignore */ }

    const chatData = { id: currentId, name, ts: Date.now(), messages: persistable, agentSessions };

    // Save to server
    try {
      await fetch('/api/chats', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat: chatData }),
      });
    } catch { /* ignore */ }

    setChatHistory(prev => {
      const existing = prev.find(c => c.id === currentId);
      const entry = { id: currentId, name, ts: Date.now(), agentSessions };
      if (existing) {
        return prev.map(c => c.id === currentId ? entry : c);
      } else {
        return [entry, ...prev];
      }
    });
  }

  function clearChatMessages() {
    const initial: ChatMessage[] = [{ id: 'welcome', type: 'system', content: 'Welcome to Agents Chat. Messages auto-route to the default agent, or type @agent to target a specific one.', ts: 0 }];
    setMessages(initial);
    setExpandedMessages({});
    setInput('');
    setSelectedAgentFilter(null);
  }

  async function loadChat(chatId: string) {
    if (chatId === currentChatId) {
      setShowChatsPanel(false);
      return;
    }

    // Save current chat first
    await saveCurrentChatToHistory();

    // Load target chat from server
    let targetMessages: ChatMessage[] = [];
    let targetName = chatHistory.find(c => c.id === chatId)?.name || chatId;
    let agentSessions: Record<string, string> = {};
    try {
      const res = await fetch(`/api/chats?id=${encodeURIComponent(chatId)}`);
      const data = await res.json();
      if (data.ok && data.chat) {
        targetMessages = data.chat.messages || [];
        targetName = data.chat.name || targetName;
        agentSessions = data.chat.agentSessions || {};
      }
    } catch { /* ignore */ }

    // If chat has no messages (e.g. newly created), use the welcome message
    if (targetMessages.length === 0) {
      targetMessages = [{ id: 'welcome', type: 'system', content: 'Welcome to Agents Chat. Messages auto-route to the default agent, or type @agent to target a specific one.', ts: 0 }];
    }

    setMessages(targetMessages);
    setChatName(targetName);
    setCurrentChatId(chatId);
    setExpandedMessages({});
    setInput('');
    setSelectedAgentFilter(null);
    sessionRunsRef.current = {};
    orchestrationsRef.current = {};

    // Persist last active chat to server
    void fetch('/api/chats', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'set-last-chat', chatId }),
    }).catch(() => { /* ignore */ });

    // Resume agent sessions via session/load. If session/load succeeds,
    // no history injection is needed. If it fails and falls back to session/new,
    // the first turn will inject chat history as context.
    const hasAnySessions = Object.values(agentSessions).some(s => !!lastSessionId(s));
    needsContextRestoreRef.current = true;
    if (hasAnySessions) {
      const sessionEntries = Object.entries(agentSessions)
        .map(([agentId, raw]) => [agentId, lastSessionId(raw)] as [string, string | null])
        .filter(([, sid]) => !!sid) as [string, string][];
      const resumeResults = await Promise.allSettled(
        sessionEntries.map(([agentId, sessionId]) =>
          acp({ action: 'resume-session', agentId, sessionId, chatId })
        )
      );
      // If all sessions were successfully loaded via session/load, skip history injection
      const allLoaded = resumeResults.every(
        r => r.status === 'fulfilled' && r.value?.loaded === true
      );
      if (allLoaded) {
        needsContextRestoreRef.current = false;
      }
      // Handle recovered messages and pending user messages
      for (const r of resumeResults) {
        if (r.status !== 'fulfilled') continue;
        const val = r.value;
        if (val?.recoveredMessages?.length > 0) {
          for (const rm of val.recoveredMessages) {
            addMessage({ type: 'agent', content: rm.content, agentId: rm.agentId, ts: rm.ts });
          }
          addMessage({ type: 'system', content: `✅ Recovered ${val.recoveredMessages.length} message(s) from previous session.` });
        }
        if (val?.pendingUserMessage) {
          const agentId = sessionEntries[0]?.[0];
          if (agentId) {
            addMessage({ type: 'system', content: '🔄 Re-sending unanswered message from previous session...' });
            setIsSending(true);
            const orchestrationId = `orch-${makeId()}`;
            void dispatchToAgent(agentId, val.pendingUserMessage, orchestrationId, 'worker');
          }
        }
      }
    }

    setShowChatsPanel(false);
    setShowAgentsPanel(false);
  }

  async function createNewChat() {
    // Save current chat to history
    await saveCurrentChatToHistory();

    const newCount = chatCounter + 1;
    const newName = 'New Chat';
    // Use timestamp-based ID to avoid collisions after reload
    const newId = `chat-${Date.now()}-${newCount}`;

    clearChatMessages();
    setChatName(newName);
    setChatCounter(newCount);
    setCurrentChatId(newId);

    // Persist last active chat to server
    void fetch('/api/chats', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'set-last-chat', chatId: newId }),
    }).catch(() => { /* ignore */ });

    // Register the new chat in history immediately so it persists
    const newEntry = { id: newId, name: newName, ts: Date.now() };
    setChatHistory(prev => {
      if (prev.some(c => c.id === newId)) return prev;
      return [newEntry, ...prev];
    });
    try {
      await fetch('/api/chats', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat: { ...newEntry, messages: [], agentSessions: {} } }),
      });
    } catch { /* ignore */ }

    const errors: string[] = [];
    for (const agent of agents) {
      try {
        const data = await acp({ action: 'new-session', agentId: agent.id, chatId: newId });
        if (!data.ok) errors.push(`${agent.id}: ${data.error || 'failed'}`);
      } catch (err) {
        errors.push(`${agent.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    sessionRunsRef.current = {};
    orchestrationsRef.current = {};

    if (errors.length) {
      addMessage({ type: 'system', content: `⚠️ New chat created with errors: ${errors.join(', ')}` });
    } else {
      addMessage({ type: 'system', content: `✅ New chat "${newName}" created. All agent sessions reset.` });
    }

    setShowChatsPanel(false);
    setShowAgentsPanel(false);

    // Reload chat list from server to ensure old chats are visible
    fetch('/api/chats').then(r => r.json()).then(data => {
      if (data.ok && Array.isArray(data.chats)) setChatHistory(data.chats);
    }).catch(() => { /* ignore */ });
  }

  async function shareCurrentChat(chatId: string) {
    // Ensure latest messages are saved first
    await saveCurrentChatToHistory();
    try {
      const res = await fetch('/api/share', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatId }),
      });
      const data = await res.json();
      if (data.ok && data.url) {
        const fullUrl = `${window.location.origin}${data.url}`;
        await navigator.clipboard.writeText(fullUrl);
        addMessage({ type: 'system', content: `🔗 Share link copied to clipboard: ${fullUrl}` });
      } else {
        addMessage({ type: 'system', content: `❌ Share failed: ${data.error || 'unknown error'}` });
      }
    } catch {
      addMessage({ type: 'system', content: '❌ Failed to create share link' });
    }
  }

  async function deleteChatById(chatId: string) {
    if (chatId === currentChatId) return; // Can't delete active chat
    try {
      await fetch(`/api/chats?id=${encodeURIComponent(chatId)}`, { method: 'DELETE' });
      setChatHistory(prev => prev.filter(c => c.id !== chatId));
    } catch { /* ignore */ }
  }

  function selectMention(agentId: string) {
    const atIndex = input.lastIndexOf('@');
    setInput(`${input.slice(0, atIndex)}@${agentId} `);
    setMentionSelectedIndex(0);
  }

  /* ────────── Render ────────── */

  return (
    <main className="page" style={themeStyle} data-theme={themeId} suppressHydrationWarning>
      <header className="header">
        <div className="headerLeft">
          <h1>🤖 Agents Chat</h1>
        </div>
        <div className="headerRight">
          <button className={`ghostButton mobileOnlyButton ${showChatsPanel ? 'activeGhost' : ''}`} onClick={() => { setShowChatsPanel((p) => !p); setShowAgentsPanel(false); }} title="Chats">💬</button>
          <div className="themeMenuWrap" ref={themeMenuRef}>
            <button
              type="button"
              className={`ghostButton themeMenuButton ${showThemeMenu ? 'activeGhost' : ''}`}
              onClick={() => setShowThemeMenu((v) => !v)}
              aria-haspopup="menu"
              aria-expanded={showThemeMenu}
              title={`Theme: ${activeTheme.label}`}
            >
              <span>{activeTheme.emoji}</span>
            </button>
            {showThemeMenu && (
              <div className="themeDropdown" role="menu" aria-label="Theme list">
                {Object.entries(THEMES).map(([id, theme]) => (
                  <button
                    key={id}
                    type="button"
                    role="menuitemradio"
                    aria-checked={themeId === id}
                    className={`themeOption ${themeId === id ? 'activeThemeOption' : ''}`}
                    onClick={() => {
                      setThemeId(id as ThemeId);
                      setShowThemeMenu(false);
                    }}
                  >
                    <span className="themeOptionMain">
                      <span className="themeChipEmoji">{theme.emoji}</span>
                      <span>{theme.label}</span>
                    </span>
                    {themeId === id ? <span className="themeCheck">✓</span> : null}
                  </button>
                ))}
              </div>
            )}
          </div>
          <button className={`ghostButton ${showAgentsPanel ? 'activeGhost' : ''}`} onClick={() => { setShowAgentsPanel((p) => !p); setShowChatsPanel(false); }} title="Agents">🤖</button>
          {session?.user && (
            <div className="userChip">
              <span className="userAvatar">{(session.user.name || '?')[0].toUpperCase()}</span>
              <span className="userName">{session.user.name}{isAdmin ? ' ★' : ''}</span>
              <button className="logoutBtn" onClick={() => void signOut()} title="Sign out">↗</button>
            </div>
          )}
        </div>
      </header>

      {mobilePanelOpen ? <div className="mobilePanelBackdrop" onClick={() => { setShowChatsPanel(false); setShowAgentsPanel(false); }} /> : null}

      <div className={`chatLayout ${sidebarCollapsed ? 'sidebarCollapsed' : ''} ${showAgentsPanel ? 'agentsSidebarOpen' : ''}`}>
        {/* ── Left sidebar: chats ── */}
        <aside className={`participantsSidebar ${showChatsPanel ? 'mobilePanelVisible' : ''}`}>
          <div className="participantsHeader">
            <span className="participantsHeaderLabel" onClick={() => setSidebarCollapsed((p) => !p)}>
              Chats
            </span>
          </div>
          {!sidebarCollapsed && (
            <div className="participantsList">
              <button className="newChatButton" onClick={() => void createNewChat()} disabled={isSending}>+ New Chat</button>
              {(() => {
                const allChats = chatHistory.some(c => c.id === currentChatId)
                  ? chatHistory
                  : [{ id: currentChatId, name: chatName, ts: Date.now() }, ...chatHistory];
                // Deduplicate by id (keep first occurrence)
                const seen = new Set<string>();
                const uniqueChats = allChats.filter(c => { if (seen.has(c.id)) return false; seen.add(c.id); return true; });
                return uniqueChats.map((chat) => {
                  const isActive = chat.id === currentChatId;
                  return (
                    <div key={chat.id} className={`chatHistoryRow ${isActive ? 'active' : ''}`}>
                      <button className={`chatHistoryItem ${isActive ? 'active' : ''}`} title={chat.name} onClick={() => isActive ? undefined : loadChat(chat.id)}>
                        <span className="chatHistoryIcon">{isActive ? '💬' : '📝'}</span>
                        <span className="chatHistoryText">
                          <span className="chatHistoryName">{isActive ? chatName : chat.name}</span>
                          <span className="chatHistoryMeta" suppressHydrationWarning>
                            {isActive
                              ? `${messages.filter((m) => m.type === 'user').length} messages`
                              : (mounted ? new Date(chat.ts).toLocaleDateString() : '')}
                          </span>
                        </span>
                      </button>
                      <button className="chatShareBtn" title="Share chat" onClick={(e) => { e.stopPropagation(); void shareCurrentChat(chat.id); }}>🔗</button>
                      {!isActive && <button className="chatDeleteBtn" title="Delete chat" onClick={(e) => { e.stopPropagation(); void deleteChatById(chat.id); }}>🗑️</button>}
                    </div>
                  );
                });
              })()}
            </div>
          )}
        </aside>

        {/* ── Main chat area ── */}
        <div className="chatMain">
          <section className="chatContainer" ref={chatContainerRef}>
            {visibleMessages.map((message) => (
              <div key={message.id} className={`message ${message.type} ${message.summary ? 'summaryCard' : ''}`}>
                {message.type !== 'user' && (
                  <div className="messageHeader">
                    <span className="agentName">{message.type === 'system' ? 'System' : (agents.find((a) => a.id === message.agentId)?.name || message.agentId || 'agent')}</span>
                    {message.round ? <span className="messageMetaTag">Round {message.round}</span> : null}
                    {message.relation ? <span className="messageMetaTag">{message.relation}</span> : null}
                    <span suppressHydrationWarning>{mounted ? formatMessageTime(message.ts) : ''}</span>
                  </div>
                )}
                {message.pending && !message.content && !(message.parts && message.parts.length > 0) ? (
                  <div className="thinkingWrap">
                    <span className="thinkingText">{message.statusText || 'Thinking'}</span>
                    <span className="thinkingDots"><span /><span /><span /></span>
                  </div>
                ) : (() => {
                  const hasParts = message.parts && message.parts.length > 0;
                  const isLong = (message.content || '').length > 400 || (message.content || '').split('\n').length > 12;
                  const isCollapsed = expandedMessages[message.id] === false;
                  return (
                    <>
                      {message.pending && message.statusText && !hasParts ? <div className="ptyStatusBadge">{message.statusText}</div> : null}
                      {hasParts ? (() => {
                        const totalText = message.parts!.filter(p => p.kind === 'text').map(p => p.text).join('');
                        const partsLong = totalText.length > 400 || totalText.split('\n').length > 12 || message.parts!.length > 6;
                        return (<>
                        <div className={`partsStream ${partsLong && isCollapsed && !message.pending ? 'collapsed' : ''}`}>
                          {message.parts!.map((part, pi) => {
                            if (part.kind === 'thinking') {
                              return (
                                <div key={pi} className="thinkingPart">
                                  <div className="thinkingPartText">{part.text}</div>
                                </div>
                              );
                            }
                            if (part.kind === 'tool') {
                              return (
                                <details key={pi} className="toolCallItem" open={!part.done}>
                                  <summary className={`toolCallSummary ${part.done ? 'complete' : 'running'}`}>
                                    <span className="toolCallIcon">{part.done ? '✅' : '⏳'}</span>
                                    <span className="toolCallName">{part.toolName}</span>
                                  </summary>
                                  {part.args && <pre className="toolCallDetail">{part.args.length > 500 ? part.args.slice(0, 500) + '…' : part.args}</pre>}
                                  {part.result && <pre className="toolCallDetail toolCallResult">{part.result.length > 500 ? part.result.slice(0, 500) + '…' : part.result}</pre>}
                                </details>
                              );
                            }
                            if (part.kind === 'text') {
                              return (
                                <div key={pi} className={`messageContent markdownBody ${message.pending ? 'pending' : ''}`}>
                                  <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>{part.text}</ReactMarkdown>
                                </div>
                              );
                            }
                            return null;
                          })}
                          {message.pending && (
                            <div className="streamingIndicator">
                              <span className="streamingPulse" />
                              <span>{message.statusText || 'Generating'}</span>
                            </div>
                          )}
                        </div>
                        {partsLong && !message.pending && (
                          <button className="collapseToggle" onClick={() => setExpandedMessages((prev) => ({ ...prev, [message.id]: prev[message.id] === false ? true : false }))}>
                            {isCollapsed ? 'Expand' : 'Collapse'}
                          </button>
                        )}
                        </>);
                      })() : (
                        <>
                          <div className={`messageContent markdownBody ${message.pending ? 'pending' : ''} ${isLong && isCollapsed ? 'collapsed' : ''}`}>
                            <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>{message.content}</ReactMarkdown>
                          </div>
                          {message.pending && message.content && (
                            <div className="streamingIndicator">
                              <span className="streamingPulse" />
                              <span>{message.statusText || 'Generating'}</span>
                            </div>
                          )}
                          {isLong && (
                            <button className="collapseToggle" onClick={() => setExpandedMessages((prev) => ({ ...prev, [message.id]: prev[message.id] === false ? true : false }))}>
                              {isCollapsed ? 'Expand' : 'Collapse'}
                            </button>
                          )}
                        </>
                      )}
                    </>
                  );
                })()}
              </div>
            ))}
          </section>

          <section className="chatInputDock">
            <div className="composerStack">
              {filteredAgents.length > 0 && (
                <div className="mentionDropdown">
                  {filteredAgents.map((agent, idx) => (
                    <button key={agent.id} className={`mentionItem ${mentionSelectedIndex === idx ? 'selected' : ''}`} onClick={() => selectMention(agent.id)}>
                      <span className="mentionId">@{agent.id}</span>
                      <span className="mentionDesc">{agent.name || ''}</span>
                    </button>
                  ))}
                </div>
              )}
              <div className="inputArea">
                <div className="composerShell">
                  {mentionedAgentIds.length > 0 ? (
                    <div className="targetPills">
                      {mentionedAgentIds.map((agentId) => (
                        <span key={agentId} className="targetPill">@{agentId}</span>
                      ))}
                      {orchestrationEnabled && (
                        <>
                          <button
                            type="button"
                            className={`targetPill orchPill ${orchestrationMode === 'pipeline' ? 'orchPillActive' : ''}`}
                            onClick={() => setOrchestrationMode('pipeline')}
                            title="Pipeline: agents run sequentially, each receives the previous agent's output"
                          >
                            🔀 Pipeline
                          </button>
                          <button
                            type="button"
                            className={`targetPill orchPill ${orchestrationMode === 'discussion' ? 'orchPillActive' : ''}`}
                            onClick={() => setOrchestrationMode('discussion')}
                            title="Discussion: agents run in parallel, then a summary is generated"
                          >
                            💬 Discussion
                          </button>
                          {orchestrationMode === 'discussion' && (
                            <select
                              className="orchRoundsSelect"
                              value={discussionRounds}
                              onChange={(e) => setDiscussionRounds(Number(e.target.value))}
                              title="Number of discussion rounds"
                            >
                              {[1, 2, 3, 4, 5].map((n) => (
                                <option key={n} value={n}>{n} {n === 1 ? 'round' : 'rounds'}</option>
                              ))}
                            </select>
                          )}
                        </>
                      )}
                    </div>
                  ) : null}
                  <div className="composerRow">
                    <textarea
                      ref={composerRef}
                      className="composerTextarea"
                      value={input}
                      onChange={(e) => setInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (filteredAgents.length > 0) {
                          if (e.key === 'ArrowDown') { e.preventDefault(); setMentionSelectedIndex((p) => (p + 1) % filteredAgents.length); return; }
                          if (e.key === 'ArrowUp') { e.preventDefault(); setMentionSelectedIndex((p) => (p - 1 + filteredAgents.length) % filteredAgents.length); return; }
                          if (e.key === 'Enter' || e.key === 'Tab') {
                            e.preventDefault();
                            const sel = filteredAgents[mentionSelectedIndex] || filteredAgents[0];
                            if (sel) selectMention(sel.id);
                            return;
                          }
                          if (e.key === 'Escape') { e.preventDefault(); setInput((p) => p.replace(/@(\S*)$/, '')); return; }
                        }
                        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (isSending) { void handleStop(); } else { void handleSend(); } }
                        if (filteredAgents.length === 0) {
                          const caretStart = e.currentTarget.selectionStart ?? 0;
                          const caretEnd = e.currentTarget.selectionEnd ?? 0;
                          const singleLine = !input.includes('\n');
                          if (e.key === 'ArrowUp' && singleLine && caretStart === 0 && caretEnd === 0) {
                            e.preventDefault();
                            const hist = inputHistoryRef.current;
                            if (hist.length === 0) return;
                            if (inputHistoryIndexRef.current === -1) inputDraftRef.current = input;
                            const newIdx = inputHistoryIndexRef.current === -1 ? hist.length - 1 : Math.max(0, inputHistoryIndexRef.current - 1);
                            inputHistoryIndexRef.current = newIdx;
                            setInput(hist[newIdx]);
                            return;
                          }
                          if (e.key === 'ArrowDown' && singleLine && caretStart === input.length && caretEnd === input.length) {
                            e.preventDefault();
                            const hist = inputHistoryRef.current;
                            if (inputHistoryIndexRef.current === -1) return;
                            const newIdx = inputHistoryIndexRef.current + 1;
                            if (newIdx >= hist.length) {
                              inputHistoryIndexRef.current = -1;
                              setInput(inputDraftRef.current);
                            } else {
                              inputHistoryIndexRef.current = newIdx;
                              setInput(hist[newIdx]);
                            }
                            return;
                          }
                        }
                      }}
                      placeholder="Message Agents Chat"
                      rows={1}
                      spellCheck={false}
                    />
                    <div className="composerActions composerInlineActions">
                      {isSending
                        ? <button className="sendButton stopButton" onClick={() => void handleStop()} aria-label="Stop generation">⏹</button>
                        : <button className="sendButton" onClick={() => void handleSend()} disabled={agents.length === 0 || !input.trim()} aria-label="Send message">
                            <span className="sendButtonIcon">↑</span>
                          </button>
                      }
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </section>
        </div>

        {/* ── Right sidebar: agents ── */}
        {showAgentsPanel && (
          <aside className={`agentsSidebar ${showAgentsPanel ? 'mobilePanelVisible' : ''}`}>
            <div className="agentsSidebarHeader">
              <span>Agents</span>
              <div style={{ display: 'flex', gap: '4px' }}>
                {isAdmin && <button className="sidebarToggle" onClick={() => setShowAddAgent(true)} title="Add new agent">+</button>}
                <button className="sidebarToggle" onClick={() => setShowAgentsPanel(false)}>→</button>
              </div>
            </div>
            <div className="agentsSidebarSection">
              {agentSidebarItems.map((agent) => (
                <button key={agent.id} className="agentListItem" style={isAdmin ? undefined : { cursor: 'default' }} onClick={() => isAdmin && openAgentSettings(agent.id)} title={isAdmin ? `${agent.name} — Click for settings` : agent.name}>
                  <span className="agentListAvatar">{(agent.name || agent.id).slice(0, 1).toUpperCase()}</span>
                  <span className="agentListInfo">
                    <span className="agentListName">{agent.name || agent.id}</span>
                    <span className="agentListId">@{agent.id}</span>
                  </span>
                  <span className={`agentListStatus ${agent.running ? 'running' : ''}`}>{agent.running ? '●' : '○'}</span>
                </button>
              ))}
              {agentSidebarItems.length === 0 && (
                <div className="muted" style={{ padding: 20, textAlign: 'center' }}>
                  {agentsLoading ? 'Loading...' : 'No agents configured'}
                </div>
              )}
            </div>
          </aside>
        )}
      </div>

      {/* ── Status bar ── */}
      <footer className="statusBar">
        <div className="statusGroup">
          <span className={`statusDot ${agents.length > 0 ? 'connected' : ''}`} />
          <span>{agents.length} agent{agents.length !== 1 ? 's' : ''} configured</span>
        </div>
        <span>{messages.filter((m) => m.type === 'user').length} messages</span>
      </footer>

      {/* ── Agent settings modal (admin only) ── */}
      {isAdmin && showAgentSettings && settingsAgentConfig && (
        <div className="modalOverlay" onClick={() => setShowAgentSettings(false)}>
          <div className="modal agentSettingsModal" onClick={(e) => e.stopPropagation()}>
            <h2>⚙️ {settingsAgentConfig.name}</h2>
            <label>
              <span>Name</span>
              <input value={settingsAgentConfig.name} onChange={(e) => setSettingsAgentConfig((c) => c ? { ...c, name: e.target.value } : c)} />
            </label>
            <label>
              <span>Command</span>
              <input value={settingsAgentConfig.command} onChange={(e) => setSettingsAgentConfig((c) => c ? { ...c, command: e.target.value } : c)} />
              <span className="fieldHint">Path to the ACP executable</span>
            </label>
            <label>
              <span>Arguments</span>
              <input value={(settingsAgentConfig.args || []).join(' ')} onChange={(e) => setSettingsAgentConfig((c) => c ? { ...c, args: e.target.value.split(/\s+/).filter(Boolean) } : c)} />
              <span className="fieldHint">Space-separated args (e.g. --acp --yolo)</span>
            </label>
            <label>
              <span>Working Directory</span>
              <input value={settingsAgentConfig.cwd} onChange={(e) => setSettingsAgentConfig((c) => c ? { ...c, cwd: e.target.value } : c)} />
            </label>
            <label className="checkboxLabel">
              <input type="checkbox" checked={settingsAgentConfig.yolo} onChange={(e) => setSettingsAgentConfig((c) => c ? { ...c, yolo: e.target.checked } : c)} />
              <span>YOLO mode (auto-approve)</span>
            </label>
            <div className="modalActions">
              <button onClick={() => void saveAgentSettings()} disabled={agentSettingsLoading}>{agentSettingsLoading ? 'Saving...' : 'Save'}</button>
              <button className="secondary" onClick={() => setShowAgentSettings(false)}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {isAdmin && showAgentSettings && !settingsAgentConfig && agentSettingsLoading && (
        <div className="modalOverlay" onClick={() => setShowAgentSettings(false)}>
          <div className="modal agentSettingsModal" onClick={(e) => e.stopPropagation()}>
            <div style={{ textAlign: 'center', padding: '20px', color: '#8a90a2' }}>Loading...</div>
          </div>
        </div>
      )}

      {/* ── Add agent modal ── */}
      {isAdmin && showAddAgent && (
        <div className="modalOverlay" onClick={() => setShowAddAgent(false)}>
          <div className="modal agentSettingsModal" onClick={(e) => e.stopPropagation()}>
            <h2>➕ Add New Agent</h2>
            <label>
              <span>Agent ID</span>
              <input value={newAgentForm.id} onChange={(e) => setNewAgentForm((f) => ({ ...f, id: e.target.value }))} placeholder="unique-agent-id" />
              <span className="fieldHint">Unique identifier, lowercase with hyphens</span>
            </label>
            <label>
              <span>Display Name</span>
              <input value={newAgentForm.name} onChange={(e) => setNewAgentForm((f) => ({ ...f, name: e.target.value }))} placeholder="My Agent" />
            </label>
            <label>
              <span>Command</span>
              <input value={newAgentForm.command} onChange={(e) => setNewAgentForm((f) => ({ ...f, command: e.target.value }))} placeholder="copilot.exe" />
              <span className="fieldHint">Path to the ACP executable</span>
            </label>
            <label>
              <span>Arguments</span>
              <input value={newAgentForm.args} onChange={(e) => setNewAgentForm((f) => ({ ...f, args: e.target.value }))} placeholder="--acp" />
              <span className="fieldHint">Space-separated args</span>
            </label>
            <label>
              <span>Working Directory</span>
              <input value={newAgentForm.cwd} onChange={(e) => setNewAgentForm((f) => ({ ...f, cwd: e.target.value }))} placeholder="C:\path\to\project" />
            </label>
            <label className="checkboxLabel">
              <input type="checkbox" checked={newAgentForm.yolo} onChange={(e) => setNewAgentForm((f) => ({ ...f, yolo: e.target.checked }))} />
              <span>YOLO mode (auto-approve)</span>
            </label>
            <div className="modalActions">
              <button onClick={() => void createAgent()} disabled={addAgentLoading || !newAgentForm.id.trim()}>
                {addAgentLoading ? 'Creating...' : 'Create Agent'}
              </button>
              <button className="secondary" onClick={() => setShowAddAgent(false)}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      <style jsx>{`
        .page {
          height: 100vh;
          min-height: 100vh;
          overflow: hidden;
          display: flex;
          flex-direction: column;
          background: var(--bg-accent);
          color: var(--text);
          transition: background 220ms ease, color 220ms ease;
        }
        .header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 16px;
          padding: 16px 24px;
          border-bottom: 1px solid var(--border);
          background: var(--header-bg);
          backdrop-filter: blur(18px);
          box-shadow: var(--shadow);
        }
        .headerLeft {
          display: flex;
          align-items: center;
          gap: 14px;
          min-width: 0;
        }
        .headerRight {
          display: flex;
          align-items: center;
          gap: 12px;
          flex-wrap: wrap;
          justify-content: flex-end;
        }
        h1 {
          margin: 0;
          font-size: 20px;
          color: var(--accent);
          letter-spacing: -0.03em;
        }
        .userChip {
          display: flex;
          align-items: center;
          gap: 6px;
          padding: 4px 8px 4px 4px;
          border-radius: 20px;
          background: var(--panel-strong);
          border: 1px solid var(--border);
          font-size: 12px;
          color: var(--text-soft);
        }
        .userAvatar {
          width: 24px;
          height: 24px;
          border-radius: 50%;
          background: var(--accent);
          color: #fff;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 12px;
          font-weight: 700;
        }
        .userName {
          max-width: 100px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .logoutBtn {
          background: none;
          border: none;
          color: var(--muted);
          cursor: pointer;
          padding: 2px;
          font-size: 14px;
          line-height: 1;
          transition: color 150ms;
        }
        .logoutBtn:hover {
          color: var(--accent);
        }
        .themeMenuWrap {
          position: relative;
        }
        .themeMenuButton {
          min-width: unset;
          padding: 6px 10px;
        }
        .themeDropdown {
          position: absolute;
          top: calc(100% + 10px);
          right: 0;
          min-width: 220px;
          padding: 8px;
          border-radius: 16px;
          border: 1px solid var(--border);
          background: var(--panel-strong);
          box-shadow: var(--shadow);
          display: grid;
          gap: 6px;
          z-index: 20;
        }
        .themeOption {
          width: 100%;
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 10px;
          padding: 10px 12px;
          border-radius: 12px;
          border: 1px solid transparent;
          background: transparent;
          color: var(--text-soft);
          cursor: pointer;
          transition: all 160ms ease;
        }
        .themeOption:hover {
          background: var(--accent-soft);
          color: var(--text);
          border-color: var(--border);
        }
        .activeThemeOption {
          background: linear-gradient(135deg, var(--accent-soft), var(--accent-strong));
          color: var(--text);
          border-color: var(--border-strong);
        }
        .themeOptionMain {
          display: inline-flex;
          align-items: center;
          gap: 8px;
        }
        .themeChipEmoji {
          font-size: 14px;
          line-height: 1;
        }
        .themeCheck {
          color: var(--accent);
          font-weight: 700;
        }
        .mobileOnlyButton {
          display: none;
        }
        .mobilePanelBackdrop {
          display: none;
        }
        .ghostButton,
        .inputArea button,
        .modalActions button,
        .mentionItem {
          cursor: pointer;
          border: 1px solid var(--border);
          background: var(--panel-soft);
          color: var(--text);
          border-radius: 12px;
          transition: all 160ms ease;
        }
        .ghostButton {
          padding: 10px 14px;
        }
        .ghostButton:hover,
        .mentionItem:hover,
        .inputArea button:hover,
        .modalActions button:hover {
          border-color: var(--border-strong);
          background: var(--accent-soft);
        }
        .activeGhost {
          color: var(--accent) !important;
          border-color: var(--border-strong) !important;
          background: linear-gradient(135deg, var(--accent-soft), var(--accent-strong)) !important;
        }
        .chatLayout {
          flex: 1;
          min-height: 0;
          overflow: hidden;
          display: grid;
          grid-template-columns: 280px minmax(0, 1fr);
          transition: grid-template-columns 0.2s ease;
        }
        .chatLayout.agentsSidebarOpen {
          grid-template-columns: 280px minmax(0, 1fr) 260px;
        }
        .chatLayout.sidebarCollapsed {
          grid-template-columns: 76px minmax(0, 1fr);
        }
        .chatLayout.sidebarCollapsed.agentsSidebarOpen {
          grid-template-columns: 76px minmax(0, 1fr) 260px;
        }
        .participantsSidebar {
          border-right: 1px solid var(--border);
          background: var(--panel-bg);
          backdrop-filter: blur(16px);
          padding: 16px 12px;
          min-height: 0;
          overflow-y: auto;
          overflow-x: hidden;
        }
        .participantsHeader {
          color: var(--text);
          font-weight: 700;
          margin-bottom: 12px;
          padding: 0 8px;
          display: flex;
          align-items: center;
          gap: 8px;
        }
        .participantsHeaderLabel {
          cursor: pointer;
          font-size: 13px;
          user-select: none;
          transition: color 160ms ease;
        }
        .participantsHeaderLabel:hover {
          color: var(--accent);
        }
        .participantsList {
          display: grid;
          gap: 8px;
        }
        .newChatButton {
          width: 100%;
          padding: 10px 12px;
          border-radius: 12px;
          border: 1px dashed var(--border-strong);
          background: transparent;
          color: var(--text-soft);
          font-size: 12px;
          font-weight: 700;
          cursor: pointer;
          transition: all 0.15s;
        }
        .newChatButton:hover {
          color: var(--accent);
          background: var(--accent-soft);
        }
        .newChatButton:disabled {
          opacity: 0.4;
          cursor: not-allowed;
        }
        .chatHistoryItem {
          display: flex;
          align-items: center;
          gap: 10px;
          width: 100%;
          text-align: left;
          padding: 10px 12px;
          border-radius: 14px;
          border: 1px solid transparent;
          background: transparent;
          color: var(--text-soft);
          cursor: pointer;
          transition: all 0.12s ease;
        }
        .chatHistoryItem:hover,
        .chatHistoryItem.active {
          background: var(--panel-soft);
          border-color: var(--border);
          color: var(--text);
        }
        .chatHistoryItem.active {
          border-color: var(--border-strong);
          box-shadow: inset 0 0 0 1px var(--accent-soft);
        }
        .chatHistoryIcon { font-size: 16px; flex: 0 0 auto; }
        .chatHistoryText { display: flex; flex-direction: column; min-width: 0; gap: 1px; }
        .chatHistoryName { font-size: 13px; font-weight: 600; color: inherit; word-break: break-word; }
        .chatHistoryMeta { font-size: 11px; color: var(--muted); }
        .chatHistoryRow {
          display: flex;
          align-items: center;
          gap: 2px;
          border-radius: 14px;
        }
        .chatHistoryRow .chatHistoryItem { flex: 1; min-width: 0; }
        .chatHistoryRow.active { background: var(--panel-soft); border: 1px solid var(--border-strong); box-shadow: inset 0 0 0 1px var(--accent-soft); border-radius: 14px; }
        .chatHistoryRow.active .chatHistoryItem { border-color: transparent; box-shadow: none; background: transparent; }
        .chatShareBtn {
          flex: 0 0 auto;
          width: 28px;
          height: 28px;
          border-radius: 8px;
          border: 1px solid transparent;
          background: transparent;
          color: var(--muted);
          cursor: pointer;
          font-size: 16px;
          display: flex;
          align-items: center;
          justify-content: center;
          transition: all 0.12s ease;
          margin-right: 2px;
        }
        .chatShareBtn:hover {
          color: var(--accent);
          background: var(--accent-soft);
          border-color: var(--border);
        }
        .chatDeleteBtn {
          flex: 0 0 auto;
          width: 28px;
          height: 28px;
          border-radius: 8px;
          border: 1px solid transparent;
          background: transparent;
          color: var(--muted);
          cursor: pointer;
          font-size: 14px;
          display: flex;
          align-items: center;
          justify-content: center;
          transition: all 0.12s ease;
          margin-right: 2px;
        }
        .chatDeleteBtn:hover {
          color: #e53e3e;
          background: rgba(229, 62, 62, 0.1);
          border-color: rgba(229, 62, 62, 0.3);
        }
        .agentsSidebar {
          border-left: 1px solid var(--border);
          background: var(--panel-bg);
          backdrop-filter: blur(16px);
          min-height: 0;
          overflow-y: auto;
          padding: 0;
        }
        .agentsSidebarHeader {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 16px 12px 8px;
          color: var(--text);
          font-weight: 700;
          font-size: 14px;
        }
        .agentsSidebarSection {
          padding: 4px 12px 12px;
        }
        .agentListItem {
          display: flex;
          align-items: center;
          gap: 10px;
          width: 100%;
          text-align: left;
          padding: 9px 10px;
          border-radius: 12px;
          border: 1px solid transparent;
          background: transparent;
          color: var(--text-soft);
          cursor: pointer;
          transition: all 0.12s ease;
          margin-bottom: 4px;
        }
        .agentListItem:hover {
          background: var(--panel-soft);
          border-color: var(--border);
          color: var(--text);
        }
        .agentListAvatar {
          width: 34px;
          height: 34px;
          border-radius: 999px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          background: linear-gradient(135deg, var(--accent), var(--accent-2));
          color: #fff;
          font-weight: 700;
          font-size: 13px;
          flex: 0 0 auto;
          box-shadow: 0 8px 18px rgba(0,0,0,0.18);
        }
        .agentListInfo { display: flex; flex-direction: column; min-width: 0; flex: 1; }
        .agentListName { font-size: 13px; font-weight: 600; color: inherit; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .agentListId { font-size: 11px; color: var(--muted); }
        .agentListStatus { font-size: 12px; color: var(--muted); flex: 0 0 auto; }
        .agentListStatus.running { color: var(--success); }
        .chatMain {
          min-width: 0;
          min-height: 0;
          height: 100%;
          overflow: hidden;
          display: grid;
          grid-template-rows: minmax(0, 1fr) auto;
        }
        .chatContainer {
          min-height: 0;
          overflow-y: auto;
          overflow-x: hidden;
          padding: 24px;
          display: flex;
          flex-direction: column;
          gap: 16px;
        }
        .chatInputDock {
          position: relative;
          border-top: 1px solid var(--border);
          background: var(--header-bg);
          backdrop-filter: blur(18px);
          padding: 16px 24px;
          min-width: 0;
        }
        .message {
          max-width: 80%;
          padding: 14px 16px;
          border-radius: 18px;
          line-height: 1.58;
          border: 1px solid var(--border);
          box-shadow: 0 14px 30px rgba(0,0,0,0.08);
        }
        .message.user {
          align-self: flex-end;
          background: var(--message-user);
          border-color: var(--border-strong);
        }
        .message.agent,
        .message.system {
          align-self: flex-start;
          background: var(--message-agent);
          border-left: 3px solid var(--accent);
        }
        .message.summaryCard {
          border-left: 3px solid var(--accent-2);
          box-shadow: 0 0 0 1px var(--summary-glow), 0 14px 34px var(--summary-glow);
        }
        .messageHeader {
          display: flex;
          gap: 8px;
          align-items: center;
          flex-wrap: wrap;
          font-size: 12px;
          color: var(--text-soft);
          margin-bottom: 8px;
        }
        .messageMetaTag {
          display: inline-flex;
          align-items: center;
          padding: 2px 8px;
          border-radius: 999px;
          background: var(--panel-soft);
          border: 1px solid var(--border);
          color: var(--text-soft);
        }
        .agentName {
          font-weight: 700;
          color: var(--accent);
        }
        .messageContent {
          white-space: pre-wrap;
          word-break: break-word;
        }
        .markdownBody :global(*) { max-width: 100%; }
        .markdownBody :global(p) { margin: 0 0 0.75em; }
        .markdownBody :global(p:last-child) { margin-bottom: 0; }
        .markdownBody :global(ul),
        .markdownBody :global(ol) { margin: 0.5em 0 0.75em 1.25em; padding: 0; }
        .markdownBody :global(li) { margin: 0.25em 0; }
        .markdownBody :global(code) {
          font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
          font-size: 0.92em;
          background: var(--code-bg);
          border: 1px solid var(--border);
          border-radius: 6px;
          padding: 0.12em 0.35em;
        }
        .markdownBody :global(pre) {
          background: var(--code-bg);
          border: 1px solid var(--border);
          border-radius: 14px;
          padding: 12px 14px;
          overflow-x: auto;
          margin: 0.75em 0;
        }
        .markdownBody :global(pre code) { background: transparent; border: 0; padding: 0; }
        .markdownBody :global(blockquote) { margin: 0.75em 0; padding: 0.1em 0 0.1em 0.9em; border-left: 3px solid var(--accent); color: var(--text-soft); }
        .markdownBody :global(h1),
        .markdownBody :global(h2),
        .markdownBody :global(h3),
        .markdownBody :global(h4) { margin: 0.8em 0 0.45em; line-height: 1.3; }
        .markdownBody :global(table) { width: 100%; border-collapse: collapse; margin: 0.75em 0; font-size: 0.95em; }
        .markdownBody :global(th),
        .markdownBody :global(td) { border: 1px solid var(--border); padding: 8px 10px; text-align: left; vertical-align: top; }
        .markdownBody :global(th) { background: var(--panel-soft); }
        .markdownBody :global(a) { color: var(--accent); text-decoration: underline; }
        .markdownBody :global(hr) { border: 0; border-top: 1px solid var(--border); margin: 1em 0; }
        .messageContent.collapsed {
          max-height: 220px;
          overflow: hidden;
          position: relative;
        }
        .messageContent.collapsed::after {
          content: '';
          position: absolute;
          left: 0; right: 0; bottom: 0;
          height: 64px;
          background: linear-gradient(to bottom, rgba(0, 0, 0, 0), var(--message-agent));
          pointer-events: none;
        }
        .collapseToggle {
          margin-top: 10px;
          padding: 6px 10px;
          border-radius: 10px;
          border: 1px solid var(--border);
          background: var(--panel-soft);
          color: var(--accent);
          cursor: pointer;
          font-size: 12px;
          transition: all 160ms ease;
        }
        .collapseToggle:hover { border-color: var(--border-strong); background: var(--accent-soft); }
        .messageContent.pending { opacity: 0.78; }
        .partsStream { display: flex; flex-direction: column; gap: 6px; }
        .partsStream.collapsed { max-height: 300px; overflow: hidden; position: relative; }
        .partsStream.collapsed::after { content: ''; position: absolute; bottom: 0; left: 0; right: 0; height: 60px; background: linear-gradient(transparent, var(--message-agent)); pointer-events: none; }
        .thinkingPart { background: rgba(127, 127, 127, 0.08); border-left: 3px solid var(--border-strong); border-radius: 8px; overflow: hidden; }
        .thinkingPartText { padding: 6px 10px; font-size: 0.82rem; color: var(--text-soft); white-space: pre-wrap; font-style: italic; }
        .htmlFileLink { color: var(--accent); text-decoration: underline; cursor: pointer; word-break: break-all; }
        .htmlFileLink:hover { opacity: 0.85; }
        .toolCallItem { background: rgba(127,127,127,0.06); border: 1px solid var(--border); border-radius: 10px; overflow: hidden; }
        .toolCallSummary { cursor: pointer; padding: 6px 10px; display: flex; align-items: center; gap: 6px; font-size: 0.82rem; color: var(--text); user-select: none; }
        .toolCallSummary.running { color: var(--accent); }
        .toolCallSummary.complete { color: var(--success); }
        .toolCallIcon { font-size: 0.9rem; }
        .toolCallName { font-family: 'Fira Code', 'Cascadia Code', monospace; font-weight: 500; }
        .toolCallDetail { margin: 0; padding: 6px 10px 8px; font-size: 0.75rem; color: var(--text-soft); white-space: pre-wrap; word-break: break-all; max-height: 200px; overflow-y: auto; border-top: 1px solid var(--border); background: rgba(127,127,127,0.04); }
        .toolCallResult { color: var(--success); }
        .ptyStatusBadge {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          margin-bottom: 10px;
          padding: 4px 10px;
          border-radius: 999px;
          background: var(--accent-soft);
          border: 1px solid var(--border-strong);
          color: var(--accent);
          font-size: 12px;
        }
        .streamingIndicator {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          margin-top: 8px;
          padding: 4px 12px;
          border-radius: 999px;
          background: rgba(34, 197, 94, 0.08);
          border: 1px solid rgba(34, 197, 94, 0.2);
          color: var(--success);
          font-size: 12px;
        }
        .streamingPulse {
          width: 7px; height: 7px;
          border-radius: 999px;
          background: var(--success);
          animation: streamPulse 1.4s ease-in-out infinite;
          flex-shrink: 0;
        }
        @keyframes streamPulse {
          0%, 100% { opacity: 1; transform: scale(1); }
          50% { opacity: 0.35; transform: scale(0.75); }
        }
        .thinkingWrap {
          display: inline-flex;
          align-items: center;
          gap: 10px;
          color: var(--text-soft);
          min-height: 24px;
        }
        .thinkingText { letter-spacing: 0.02em; }
        .thinkingDots { display: inline-flex; align-items: center; gap: 6px; }
        .thinkingDots span {
          width: 8px; height: 8px;
          border-radius: 999px;
          background: linear-gradient(135deg, var(--accent), var(--accent-2));
          box-shadow: 0 0 10px color-mix(in srgb, var(--accent) 35%, transparent);
          animation: thinkingBounce 1.2s infinite ease-in-out;
        }
        .thinkingDots span:nth-child(2) { animation-delay: 0.15s; }
        .thinkingDots span:nth-child(3) { animation-delay: 0.3s; }
        @keyframes thinkingBounce {
          0%, 80%, 100% { transform: translateY(0) scale(0.75); opacity: 0.45; }
          40% { transform: translateY(-3px) scale(1); opacity: 1; }
        }
        .composerStack {
          position: relative;
          width: 100%;
        }
        .mentionDropdown {
          position: absolute;
          left: 0;
          right: 0;
          bottom: calc(100% + 10px);
          background: var(--panel-strong);
          border: 1px solid var(--border);
          border-radius: 18px;
          overflow: hidden;
          box-shadow: var(--shadow);
        }
        .mentionItem {
          width: 100%;
          text-align: left;
          padding: 11px 14px;
          border-radius: 0;
          border: 0;
          border-bottom: 1px solid var(--border);
          display: flex;
          gap: 10px;
          background: var(--panel-strong);
        }
        .mentionItem.selected { background: var(--accent-soft); outline: none; }
        .mentionItem:last-child { border-bottom: 0; }
        .mentionId { color: var(--accent); font-weight: 700; }
        .mentionDesc { color: var(--muted); }
        .inputArea {
          display: block;
        }
        .composerShell {
          min-width: 0;
          display: flex;
          flex-direction: column;
          gap: 10px;
          padding: 10px 12px;
          background: var(--panel-soft);
          border: 1px solid var(--border);
          border-radius: 22px;
          box-shadow: 0 10px 26px rgba(0, 0, 0, 0.06);
          transition: border-color 160ms ease, box-shadow 160ms ease, transform 160ms ease;
        }
        .composerShell:focus-within {
          border-color: var(--border-strong);
          box-shadow: 0 0 0 1px var(--accent-soft), 0 14px 30px rgba(0, 0, 0, 0.08);
          transform: translateY(-1px);
        }
        .orchPill {
          cursor: pointer;
          border-color: var(--border);
          background: transparent;
          color: var(--muted);
          transition: all 180ms cubic-bezier(0.4, 0, 0.2, 1);
        }
        .orchPill:hover {
          color: var(--accent);
          border-color: var(--accent);
          background: var(--accent-soft);
        }
        .orchPill.orchPillActive {
          background: linear-gradient(135deg, var(--accent), var(--accent-2));
          color: #fff;
          border-color: color-mix(in srgb, var(--accent) 40%, transparent);
          box-shadow: 0 3px 10px color-mix(in srgb, var(--accent) 22%, transparent);
        }
        .orchPill.orchPillActive:hover {
          filter: brightness(1.08);
        }
        .orchRoundsSelect {
          padding: 4px 8px;
          border-radius: 999px;
          border: 1px solid var(--border-strong);
          background: var(--accent-soft);
          color: var(--accent);
          font-size: 12px;
          font-weight: 700;
          cursor: pointer;
          transition: all 160ms ease;
        }
        .orchRoundsSelect:hover {
          border-color: var(--accent);
          box-shadow: 0 0 0 2px var(--accent-soft);
        }
        .composerRow {
          display: flex;
          align-items: flex-end;
          gap: 10px;
          min-width: 0;
        }
        .composerTextarea {
          flex: 1;
          width: 100%;
          min-height: 24px;
          max-height: 180px;
          resize: none;
          overflow-y: hidden;
          padding: 8px 0 7px;
          margin: 0;
          background: transparent;
          border: 0;
          color: var(--text);
          outline: none;
          line-height: 1.5;
          font-size: 15px;
          font-family: 'Segoe UI Variable', 'Segoe UI', system-ui, sans-serif;
        }
        .composerTextarea::placeholder {
          color: var(--muted);
        }
        .composerActions,
        .targetPills {
          display: flex;
          align-items: center;
          gap: 8px;
          flex-wrap: wrap;
        }
        .composerActions {
          margin-left: auto;
          flex: 0 0 auto;
        }
        .composerInlineActions {
          align-self: flex-end;
          margin-bottom: 1px;
        }
        .targetPill {
          display: inline-flex;
          align-items: center;
          padding: 5px 10px;
          border-radius: 999px;
          border: 1px solid var(--border-strong);
          background: var(--accent-soft);
          color: var(--accent);
          font-size: 12px;
          line-height: 1;
          font-weight: 700;
        }
        .composerHint {
          display: none;
        }
        .sendButton,
        .modalActions button {
          padding: 12px 18px;
        }
        .sendButton {
          width: 38px;
          min-width: 38px;
          height: 38px;
          padding: 0 !important;
          border-radius: 999px !important;
          border: 1px solid color-mix(in srgb, var(--accent) 30%, transparent) !important;
          background: linear-gradient(135deg, var(--accent), var(--accent-2)) !important;
          color: white !important;
          box-shadow: 0 8px 18px color-mix(in srgb, var(--accent) 18%, transparent), inset 0 1px 0 rgba(255,255,255,0.22);
          font-weight: 700;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          align-self: flex-end;
        }
        .sendButton:hover:not(:disabled) {
          transform: translateY(-1px);
          filter: saturate(1.04) brightness(1.03);
        }
        .sendButton:disabled {
          opacity: 0.45;
          cursor: not-allowed;
          box-shadow: none;
          filter: grayscale(0.08);
        }
        .sendButtonIcon {
          font-size: 18px;
          line-height: 1;
        }
        .stopButton {
          background: linear-gradient(135deg, var(--danger), color-mix(in srgb, var(--danger) 76%, black 24%)) !important;
          border-color: color-mix(in srgb, var(--danger) 58%, transparent) !important;
          color: #fff !important;
        }
        .stopButton:hover { filter: brightness(1.08); }
        .statusBar {
          display: flex;
          justify-content: space-between;
          gap: 12px;
          padding: 10px 24px;
          border-top: 1px solid var(--border);
          background: var(--header-bg);
          color: var(--text-soft);
          font-size: 12px;
          backdrop-filter: blur(18px);
        }
        .statusGroup { display: flex; align-items: center; gap: 8px; }
        .statusDot {
          width: 8px; height: 8px;
          border-radius: 999px;
          display: inline-block;
          background: var(--danger);
        }
        .statusDot.connected { background: var(--success); }
        .muted { color: var(--muted); }
        .modalOverlay {
          position: fixed;
          inset: 0;
          background: rgba(0, 0, 0, 0.62);
          display: grid;
          place-items: center;
          padding: 16px;
          z-index: 100;
          backdrop-filter: blur(10px);
        }
        .modal {
          width: min(520px, 100%);
          background: var(--panel-strong);
          border: 1px solid var(--border);
          border-radius: 20px;
          padding: 20px;
          box-shadow: var(--shadow);
        }
        .modal h2 { margin-top: 0; color: var(--accent); }
        .modal label { display: block; margin-bottom: 14px; }
        .modal label span { display: block; margin-bottom: 6px; color: var(--text-soft); }
        .modal input {
          width: 100%;
          padding: 12px 14px;
          background: var(--input-bg);
          border: 1px solid var(--border);
          border-radius: 12px;
          color: var(--text);
        }
        .modal select {
          width: 100%;
          padding: 12px 14px;
          background: var(--input-bg);
          border: 1px solid var(--border);
          border-radius: 12px;
          color: var(--text);
        }
        .modalActions { display: flex; gap: 10px; justify-content: flex-end; }
        .modalActions .secondary { background: transparent; }
        .agentSettingsModal { width: min(580px, 100%); }
        .fieldHint { font-size: 12px; color: var(--muted); margin-top: 4px; }
        .checkboxLabel {
          display: flex !important;
          flex-direction: row !important;
          align-items: center;
          gap: 10px;
          margin-bottom: 18px;
          cursor: pointer;
        }
        .checkboxLabel input[type="checkbox"] {
          width: 18px; height: 18px;
          accent-color: var(--accent);
          cursor: pointer;
          flex-shrink: 0;
        }
        .checkboxLabel span { margin-bottom: 0 !important; }

        @media (max-width: 1100px) {
          .header {
            align-items: flex-start;
            flex-direction: column;
            padding: 14px 16px;
          }
          .headerLeft,
          .headerRight {
            width: 100%;
          }
          .headerRight {
            justify-content: space-between;
          }
          .themeMenuWrap {
            flex: none;
            min-width: 0;
          }
          .themeMenuButton {
            min-width: 0;
            width: auto;
          }
          .themeDropdown {
            left: 0;
            right: auto;
            min-width: min(260px, 100%);
          }
          .chatContainer {
            padding: 18px 16px;
          }
          .chatInputDock {
            padding: 14px 16px;
          }
          .statusBar {
            padding: 10px 16px;
          }
        }

        @media (max-width: 900px) {
          .mobileOnlyButton {
            display: inline-flex;
          }
          .mobilePanelBackdrop {
            display: block;
            position: fixed;
            inset: 0;
            background: rgba(0, 0, 0, 0.42);
            backdrop-filter: blur(3px);
            z-index: 11;
          }
          .chatLayout,
          .chatLayout.agentsSidebarOpen,
          .chatLayout.sidebarCollapsed,
          .chatLayout.sidebarCollapsed.agentsSidebarOpen {
            grid-template-columns: minmax(0, 1fr);
          }
          .participantsSidebar,
          .agentsSidebar {
            display: block;
            position: fixed;
            top: 0;
            bottom: 0;
            width: min(84vw, 320px);
            z-index: 12;
            box-shadow: var(--shadow);
            transition: transform 180ms ease;
          }
          .participantsSidebar {
            left: 0;
            transform: translateX(-105%);
            border-right: 1px solid var(--border);
          }
          .agentsSidebar {
            right: 0;
            transform: translateX(105%);
            border-left: 1px solid var(--border);
          }
          .participantsSidebar.mobilePanelVisible,
          .agentsSidebar.mobilePanelVisible {
            transform: translateX(0);
          }
          .participantsHeader,
          .agentsSidebarHeader {
            position: sticky;
            top: 0;
            background: var(--panel-strong);
            backdrop-filter: blur(16px);
            z-index: 1;
          }
          .message {
            max-width: 100%;
            padding: 12px 14px;
            border-radius: 16px;
          }
          .chatContainer {
            padding: 14px 12px;
            gap: 12px;
          }
          .chatInputDock {
            padding: 12px;
          }
          .composerStack {
            max-width: none;
          }
          .composerShell {
            border-radius: 24px;
          }
          .sendButton {
            width: 40px;
            min-width: 40px;
            height: 40px;
            min-height: 40px;
          }
          .mentionDropdown {
            left: 0;
            right: 0;
            bottom: calc(100% + 8px);
          }
          .statusBar {
            flex-wrap: wrap;
            gap: 6px 12px;
            padding: 8px 12px calc(8px + env(safe-area-inset-bottom));
          }
          .modalOverlay {
            padding: 12px;
          }
          .modal,
          .agentSettingsModal {
            width: 100%;
            max-height: calc(100vh - 24px);
            overflow-y: auto;
            padding: 16px;
            border-radius: 18px;
          }
        }

        @media (max-width: 560px) {
          .header {
            gap: 12px;
          }
          h1 {
            font-size: 18px;
          }
          .headerRight {
            gap: 8px;
          }
          .mobileOnlyButton {
            min-height: 42px;
          }
          .ghostButton,
          .themeMenuButton {
            min-height: unset;
            padding: 6px 10px;
            font-size: 14px;
          }
          .inputArea {
            display: block;
          }
          .composerShell {
            width: 100%;
            padding: 10px 12px;
            border-radius: 20px;
          }
          .composerRow {
            gap: 8px;
          }
          .composerTextarea {
            min-height: 22px;
            padding: 7px 0 6px;
          }
          .composerActions {
            justify-content: flex-end;
          }
          .messageHeader {
            gap: 6px;
            font-size: 11px;
          }
          .chatHistoryItem,
          .agentListItem {
            padding: 10px;
          }
        }
      `}</style>
    </main>
  );
}

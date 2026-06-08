'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { signOut, useSession } from 'next-auth/react';
import { acpApi } from './chatApi';
import { getDefaultAgentId, getExistingAgentId, getMentionedAgentIds, SCHEDULER_AGENT_ID } from './chatHelpers';
import { useAgentRegistry } from './runtime/useAgentRegistry';
import { useChatRuntime } from './runtime/useChatRuntime';
import { useComposerState } from './runtime/useComposerState';
import { useSlashCommands } from './runtime/useSlashCommands';
import { usePageUIState } from './runtime/usePageUIState';
import { useAgentPanelState } from '../agents/hooks/useAgentPanelState';
import { AgentsPanel } from '../agents/components/AgentsPanel';
import { useNodePanelState } from '../nodes/hooks/useNodePanelState';
import { NodesPanel } from '../nodes/components/NodesPanel';
import { SchedulesPanel } from '../scheduler/components/SchedulesPanel';
import { ChatComposer } from '../composer/components/ChatComposer';
import { ComposerTargetControls } from '../composer/components/ComposerTargetControls';
import { useFileWorkspaceState } from '../files/hooks/useFileWorkspaceState';
import { useFileComments, type UseFileCommentsResult } from '../files/hooks/useFileComments';
import { FileWorkspacePanel } from '../files/components/FileWorkspacePanel';
import { ChatSidebarList } from './components/ChatSidebarList';
import type { FailedSendState } from './components/FailedSendControls';
import { MessageList } from '../messages/components/MessageList';
import { WorkflowPicker } from '../orchestration/components/WorkflowPicker';
import { PlanProgressBar, selectActiveWorkflowOrchestration } from '../orchestration/components/PlanProgressBar';
import { detectWorkflowFollowUp } from '../orchestration/workflowFollowUp';
import { WorkflowFollowUpCard } from '../orchestration/components/WorkflowFollowUpCard';
import { ChatShell } from '../layout/components/ChatShell';
import { PageHeader } from '../layout/components/PageHeader';
import { StatusBar } from '../layout/components/StatusBar';
import { ThemeMenu } from '../layout/components/ThemeMenu';
import { ShareDialog as ShareDialogComponent } from '../layout/components/ShareDialog';
import { ImageLightbox } from '../layout/components/ImageLightbox';
import { SelectPicker } from '../ui/SelectPicker';

const CHAT_ACTION_MENU_WIDTH = 132;
const CHAT_ACTION_MENU_HEIGHT = 124;

export function ChatPageClient() {
  const { data: session, status: authStatus } = useSession();
  const isAdmin = (session?.user as any)?.role === 'admin';
  const userId = (session?.user as any)?.email || (session?.user as any)?.name || 'anonymous';
  const acp = useCallback((body: Record<string, unknown>) => acpApi({ ...body, userId }), [userId]);
  const composer = useComposerState();
  const { input, inputRef, composerRef, fileInputRef, inputHistoryIndexRef, inputDraftRef, pastedLinksRef, attachments, attachmentError, isDraggingAttachment, mounted, setInputProgrammatic, composerInputHandler, addFilesToComposer, removeAttachment, clearAttachments, handleAttachmentPaste, handleComposerDragOver, handleComposerDragLeave, handleComposerDrop } = composer;
  const ui = usePageUIState({ mounted });
  const { themeId, setThemeId, normalizedThemeId, themeStyle, sidebarCollapsed, setSidebarCollapsed, sidebarWidth, sidebarDragRef, lightboxImage, setLightboxImage, showChatsPanel, setShowChatsPanel, openChatMenuId, setOpenChatMenuId, chatMenuButtonRefs, renamingChatId, setRenamingChatId, renameValue, setRenameValue, mentionSelectedIndex, setMentionSelectedIndex } = ui;
  const registry = useAgentRegistry({ acp });
  const { agents, agentsLoading, lastUsedAgent, chatLastUsedAgents, lastUsedAgentScope, rememberLastUsedAgent, reloadAgents } = registry;
  const agentsRef = useRef(agents); agentsRef.current = agents;
  const agentsLoadingRef = useRef(agentsLoading); agentsLoadingRef.current = agentsLoading;
  // Resolve which agent the composer should pre-fill for a given chat, based
  // on scope: per-user (any chat) or per-chat (only matching chat). No
  // fallback between the two — by design, scope='chat' on a chat with no
  // entry yields null so the chat primary/default agent wins.
  const effectiveLastUsedAgentFor = useCallback((chatId: string | null): string | null => {
    if (lastUsedAgentScope === 'chat') return chatId ? (chatLastUsedAgents[chatId] || null) : null;
    return lastUsedAgent;
  }, [lastUsedAgentScope, lastUsedAgent, chatLastUsedAgents]);
  const effectiveLastUsedAgentRef = useRef(effectiveLastUsedAgentFor); effectiveLastUsedAgentRef.current = effectiveLastUsedAgentFor;
  const chatAgentFilterRef = useRef(registry.selectedAgentFilter); chatAgentFilterRef.current = registry.selectedAgentFilter;
  const getSelectedModelIdRef = useRef<(agentId: string) => string>(() => '');
  const getSelectedModelIdForAgent = useCallback((agentId: string) => getSelectedModelIdRef.current(agentId), []);
  const chatContainerRef = useRef<HTMLElement | null>(null);
  const shouldStickToBottomRef = useRef(true);
  const lastChatScrollTopRef = useRef(0);
  const fileCommentsControllerRef = useRef<Pick<UseFileCommentsResult, 'resetForFileOpen'> | null>(null);
  const runtime = useChatRuntime({ acp, agentsRef, agentsLoadingRef, chatAgentFilterRef, getSelectedModelIdForAgent, setInputProgrammatic, effectiveLastUsedAgentRef, rememberLastUsedAgent, authStatus, reloadAgents });
  const { messages, chatHistory, currentChatId, activeSidebarChatId, chatName, runVersion, shareDialog, expandedMessages, orchestrationMode, pendingWorkflowPlan, dismissedFollowUpOrchId, setDismissedFollowUpOrchId, setChatHistory, setChatName, setCurrentChatId, setActiveSidebarChatId, setShareDialog, setExpandedMessages, setOrchestrationMode, setPendingWorkflowPlan, currentChatIdRef, sessionRunsRef, currentAgentSessionsRef, inputHistoryRef, orchestrationsRef, addMessage, updateMessage, notifyRunStateChanged, dispatchToAgent, saveCurrentChatToHistory, clearChatMessages, shareCurrentChat, handleStop, retryFailedSend, sendWorkflowFollowUpReply, answerAgentUserRequest, dismissAgentUserRequest, fileCommentCallbacksRef, panelCallbacksRef, loadChat: runtimeLoadChat, createNewChat: runtimeCreateNewChat, renameChatById: runtimeRenameChatById, deleteChatById: runtimeDeleteChatById, handleSend: runtimeHandleSend, loadChatIntoCache, getChatSidebarStatus } = runtime;
  const [showWorkflowPicker, setShowWorkflowPicker] = useState(false);
  // runVersion is read so the PlanProgressBar re-renders as node statuses change.
  void runVersion;
  const activeWorkflow = selectActiveWorkflowOrchestration(orchestrationsRef, currentChatId);
  const workflowFollowUp = useMemo(
    () => detectWorkflowFollowUp(orchestrationsRef.current, currentChatId, messages),
    [orchestrationsRef, currentChatId, runVersion, messages],
  );
  const showFollowUpHint = !!workflowFollowUp && workflowFollowUp.orchestrationId !== dismissedFollowUpOrchId;
  const nodePanelState = useNodePanelState({ acp, loadAgents: reloadAgents, addMessage });
  const { showNodesPanel, setShowNodesPanel, loadNodes, nodesData } = nodePanelState;
  const agentPanelState = useAgentPanelState({ acp, loadAgents: reloadAgents, addMessage, loadNodes });
  const { showAgentsPanel, setShowAgentsPanel } = agentPanelState;
  const [showSchedulesPanel, setShowSchedulesPanel] = useState(false);

  getSelectedModelIdRef.current = (agentId) => {
    const agent = agents.find((item) => item.id === agentId), models = agent?.models || [], selected = registry.selectedAgentModels[agentId];
    if (selected && (models.length === 0 || models.some((model) => model.modelId === selected))) return selected;
    if (agent?.defaultModelId && models.some((model) => model.modelId === agent.defaultModelId)) return agent.defaultModelId;
    return models[0]?.modelId || '';
  };
  panelCallbacksRef.current = { setSelectedAgentFilter: registry.setSelectedAgentFilter, setShowChatsPanel, setShowAgentsPanel, setOpenChatMenuId, setRenamingChatId, setRenameValue };

  const fileWorkspace = useFileWorkspaceState({ agents, agentsLoading, mounted, schedulerAgentId: SCHEDULER_AGENT_ID, onFileOpened: ({ agentId, filePath, restoreScrollTop }) => fileCommentsControllerRef.current?.resetForFileOpen(agentId, filePath, restoreScrollTop) });
  const fileCommentsController = useFileComments(fileWorkspace, {
    mounted, onOpenReviewChat: async (chatId) => { fileWorkspace.setLeftSidebarTab('chats'); await runtimeLoadChat(chatId); },
    onLoadChatIntoCache: loadChatIntoCache, onDispatchToAgent: dispatchToAgent, onInterruptAgent: (agentId, chatId) => acp({ action: 'interrupt', agentId, chatId }),
    onGetActiveRun: (reviewChatId, commentId) => {
      const activeRun = Object.entries(sessionRunsRef.current).find(([, run]) => run.chatId === reviewChatId && run.commentId === commentId);
      if (!activeRun) return null; const [runKey, run] = activeRun;
      return { runKey, agentId: run.agentId, pendingId: run.pendingId, currentText: run.currentText, chatId: run.chatId };
    },
    onUpdateMessage: updateMessage, onDeleteActiveRun: (runKey) => { delete sessionRunsRef.current[runKey]; }, onRunStateChanged: notifyRunStateChanged,
  });
  fileCommentsControllerRef.current = fileCommentsController;
  const { leftSidebarTab, setLeftSidebarTab, switchLeftSidebarTab, mdEditorOpen, mdSelectedFile } = fileWorkspace;
  const { fileCommentsRef, extractFileComments, saveAgentComments, resolveProcessingCommentForChat } = fileCommentsController;
  fileCommentCallbacksRef.current = { extractFileComments, saveAgentComments, fileCommentsRef, resolveProcessingCommentForChat };

  const filteredAgents = useMemo(() => { const match = input.match(/@(\S*)$/); if (!match) return []; const q = match[1].toLowerCase(); return agents.filter((a) => a.id !== SCHEDULER_AGENT_ID && a.canTalk !== false && (a.id.toLowerCase().includes(q) || a.name?.toLowerCase().includes(q))); }, [input, agents]);
  const chatFilterAgents = useMemo(() => agents.filter((agent) => agent.id !== SCHEDULER_AGENT_ID), [agents]);
  const mentionedAgentIds = useMemo(() => getMentionedAgentIds(input, agents), [input, agents]);
  const currentChatPrimaryAgentId = useMemo(() => chatHistory.find((chat) => chat.id === currentChatId)?.agentId || null, [chatHistory, currentChatId]);
  const rememberedComposerAgentId = getExistingAgentId(effectiveLastUsedAgentFor(currentChatId || null), agents);
  const effectiveComposerAgentId = mentionedAgentIds.length === 0 ? rememberedComposerAgentId || getExistingAgentId(currentChatPrimaryAgentId, agents) || getDefaultAgentId(agents) : null;
  const composerTargetAgentIds = mentionedAgentIds.length > 0 ? mentionedAgentIds : effectiveComposerAgentId ? [effectiveComposerAgentId] : [];
  const singleComposerAgentId = composerTargetAgentIds.length === 1 ? composerTargetAgentIds[0] : null;
  const slashMatch = useMemo(() => (singleComposerAgentId ? input.match(/^\/(\w*)$/) : null), [input, singleComposerAgentId]);
  const slashCommandsState = useSlashCommands({ acp, agentId: singleComposerAgentId, chatId: currentChatId || null });
  const filteredSlashCommands = useMemo(() => {
    if (!slashMatch) return [];
    const q = slashMatch[1].toLowerCase();
    const targetAgent = singleComposerAgentId ? agents.find((a) => a.id === singleComposerAgentId) : null;
    const modelIds = (targetAgent?.models || []).map((m) => m.modelId).filter(Boolean);
    return slashCommandsState.commands
      .filter((cmd) => cmd.name.toLowerCase().startsWith(q))
      .map((cmd) => {
        // The agent's hint for `/model` is typically just "model" which isn't useful.
        // If we already know the agent's supported models, surface them as the hint.
        if (cmd.name.toLowerCase() === 'model' && modelIds.length > 0) {
          return { ...cmd, hint: modelIds.join(' | ') };
        }
        return cmd;
      });
  }, [slashMatch, slashCommandsState.commands, singleComposerAgentId, agents]);
  const [slashSelectedIndex, setSlashSelectedIndex] = useState(0);
  const slashTriggerActiveRef = useRef(false);
  useEffect(() => { setSlashSelectedIndex(0); }, [input, singleComposerAgentId]);
  useEffect(() => {
    const active = !!slashMatch;
    if (active && !slashTriggerActiveRef.current && singleComposerAgentId && currentChatId) {
      // User just typed `/` — refresh in case the agent advertised commands after initial fetch.
      void slashCommandsState.refresh();
    }
    slashTriggerActiveRef.current = active;
  }, [slashMatch, singleComposerAgentId, currentChatId, slashCommandsState]);
  const isCurrentChatSending = useMemo(() => runtime.isChatRunning(currentChatId), [currentChatId, runVersion]);
  const agentSidebarItems = useMemo(() => agents.filter((a) => a.id !== SCHEDULER_AGENT_ID).map((agent) => ({ ...agent, running: messages.some((m) => m.agentId === agent.id && m.pending) })), [agents, messages]);
  const visibleMessages = useMemo(() => registry.selectedAgentFilter ? messages.filter((m) => m.type !== 'agent' || m.agentId === registry.selectedAgentFilter) : messages, [messages, registry.selectedAgentFilter]);
  const failedSendByMessageId = useMemo(() => {
    const result: Record<string, FailedSendState | undefined> = {};
    for (const message of visibleMessages) if (message.type === 'user' && message.sendStatus === 'failed') result[message.id] = { error: message.sendError || 'Failed to send prompt to agent', resendDisabled: runtime.isChatRunning(currentChatId) || (!message.resendAgentIds?.length && (agentsLoading || agents.length === 0)), waitingForAgents: !message.resendAgentIds?.length && (agentsLoading || agents.length === 0) };
    return result;
  }, [visibleMessages, agents, agentsLoading, currentChatId, runVersion]);

  useEffect(() => { setMentionSelectedIndex(0); }, [input, agents, setMentionSelectedIndex]);
  useEffect(() => { const handleEsc = (e: globalThis.KeyboardEvent) => { if (e.key !== 'Escape') return; if (lightboxImage) setLightboxImage(null); else if (shareDialog) setShareDialog(null); }; window.addEventListener('keydown', handleEsc); return () => window.removeEventListener('keydown', handleEsc); }, [lightboxImage, shareDialog, setLightboxImage, setShareDialog]);
  useEffect(() => { if (chatFilterAgents.length && registry.selectedAgentFilter && !chatFilterAgents.some((agent) => agent.id === registry.selectedAgentFilter)) registry.setSelectedAgentFilter(null); }, [registry.selectedAgentFilter, chatFilterAgents]);
  useEffect(() => { if (!mounted || !currentChatId) return; for (const agentId of composerTargetAgentIds) if ((agents.find((agent) => agent.id === agentId)?.models || []).length === 0 && !registry.ensuringAgentModels[agentId]) void registry.ensureAgentModels(agentId, { currentChatId, currentAgentSessionsRef, setChatHistory }); }, [mounted, currentChatId, composerTargetAgentIds.join('|'), agents]);
  useEffect(() => { const el = chatContainerRef.current; if (el && shouldStickToBottomRef.current) { el.scrollTop = el.scrollHeight; lastChatScrollTopRef.current = el.scrollTop; } }, [messages]);
  useEffect(() => { const el = chatContainerRef.current; if (!el) return; const onScroll = () => updateChatStickiness(el); onScroll(); el.addEventListener('scroll', onScroll, { passive: true }); return () => el.removeEventListener('scroll', onScroll); }, []);

  function updateChatStickiness(container: HTMLElement) { const previous = lastChatScrollTopRef.current, distance = container.scrollHeight - container.scrollTop - container.clientHeight; shouldStickToBottomRef.current = container.scrollTop < previous - 1 ? false : distance <= 4; lastChatScrollTopRef.current = container.scrollTop; }
  function switchAgentFilter(agentId: string | null) { if (agentId === registry.selectedAgentFilter) return; void saveCurrentChatToHistory(); registry.setSelectedAgentFilter(agentId); currentChatIdRef.current = ''; setCurrentChatId(''); setActiveSidebarChatId(''); setChatName('New Chat'); clearChatMessages({ clearAgentFilter: false }); currentAgentSessionsRef.current = {}; }
  async function loadChat(chatId: string) { if (chatId === currentChatId) { setOpenChatMenuId(null); setShowChatsPanel(false); return; } setOpenChatMenuId(null); shouldStickToBottomRef.current = true; await runtimeLoadChat(chatId); requestAnimationFrame(() => { const el = chatContainerRef.current; if (el) el.scrollTop = el.scrollHeight; }); }
  async function createNewChat() { setOpenChatMenuId(null); await runtimeCreateNewChat(registry.selectedAgentFilter); }
  async function renameChatById(chatId: string, newName: string) { await runtimeRenameChatById(chatId, newName, () => { setRenamingChatId(null); setRenameValue(''); }); }
  async function deleteChatById(chatId: string) { await runtimeDeleteChatById(chatId, () => setOpenChatMenuId(null)); }
  async function handleSend() { let text = (inputRef.current || composerRef.current?.value || '').trim(); const sendAttachments = attachments; if ((!text && sendAttachments.length === 0) || agents.length === 0) return; if (pastedLinksRef.current.length > 0) { for (const { text: linkText, href } of pastedLinksRef.current) { const idx = text.indexOf(linkText); if (idx !== -1) { text = text.substring(0, idx) + `[${linkText}](${href})` + text.substring(idx + linkText.length); } } pastedLinksRef.current = []; } shouldStickToBottomRef.current = true; clearAttachments(); await runtimeHandleSend(text, sendAttachments, inputHistoryIndexRef, inputDraftRef); }
  function selectMention(agentId: string) { const currentInput = inputRef.current, atIndex = currentInput.lastIndexOf('@'); setInputProgrammatic(`${currentInput.slice(0, atIndex)}@${agentId} `); setMentionSelectedIndex(0); }
  function insertSlashCommand(command: { name: string }) { setInputProgrammatic(`/${command.name} `); setSlashSelectedIndex(0); composerRef.current?.focus(); }
  async function copyShareDialogLink() { if (!shareDialog?.url) return; try { await navigator.clipboard.writeText(shareDialog.url); setShareDialog((prev) => prev ? { ...prev, copied: true, detail: 'Copied to clipboard.' } : prev); } catch { setShareDialog((prev) => prev ? { ...prev, copied: false, detail: 'Could not copy automatically. Select the link and copy it manually.' } : prev); } }
  function toggleMessageExpanded(messageId: string) { setExpandedMessages((prev) => ({ ...prev, [messageId]: prev[messageId] === false ? true : false })); }
  function handleComposerKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'ArrowUp') document.title = `[DBG1] filtered=${filteredAgents.length} val="${e.currentTarget.value.slice(0,20)}" sel=${e.currentTarget.selectionStart}`;
    if (filteredAgents.length > 0) { if (e.key === 'ArrowDown') { e.preventDefault(); setMentionSelectedIndex((p) => (p + 1) % filteredAgents.length); return; } if (e.key === 'ArrowUp') { e.preventDefault(); setMentionSelectedIndex((p) => (p - 1 + filteredAgents.length) % filteredAgents.length); return; } if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); selectMention((filteredAgents[mentionSelectedIndex] || filteredAgents[0]).id); return; } if (e.key === 'Escape') { e.preventDefault(); setInputProgrammatic(inputRef.current.replace(/@(\S*)$/, '')); return; } }
    if (filteredSlashCommands.length > 0) { if (e.key === 'ArrowDown') { e.preventDefault(); setSlashSelectedIndex((p) => (p + 1) % filteredSlashCommands.length); return; } if (e.key === 'ArrowUp') { e.preventDefault(); setSlashSelectedIndex((p) => (p - 1 + filteredSlashCommands.length) % filteredSlashCommands.length); return; } if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) { e.preventDefault(); insertSlashCommand(filteredSlashCommands[slashSelectedIndex] || filteredSlashCommands[0]); return; } if (e.key === 'Escape') { e.preventDefault(); setInputProgrammatic(''); return; } }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (isCurrentChatSending) void handleStop(); else void handleSend(); }
    if (filteredAgents.length !== 0) return; const start = e.currentTarget.selectionStart ?? 0, end = e.currentTarget.selectionEnd ?? 0, currentVal = e.currentTarget.value; if (currentVal.includes('\n')) return;
    if (e.key === 'ArrowUp' && start === 0 && end === 0) { e.preventDefault(); const hist = inputHistoryRef.current[currentChatIdRef.current] || []; if (!hist.length) return; if (inputHistoryIndexRef.current === -1) inputDraftRef.current = currentVal; const idx = inputHistoryIndexRef.current === -1 ? hist.length - 1 : Math.max(0, inputHistoryIndexRef.current - 1); inputHistoryIndexRef.current = idx; setInputProgrammatic(hist[idx]); }
    if (e.key === 'ArrowDown' && start === currentVal.length && end === currentVal.length) { e.preventDefault(); const hist = inputHistoryRef.current[currentChatIdRef.current] || []; if (inputHistoryIndexRef.current === -1) return; const idx = inputHistoryIndexRef.current + 1; inputHistoryIndexRef.current = idx >= hist.length ? -1 : idx; setInputProgrammatic(idx >= hist.length ? inputDraftRef.current : hist[idx]); }
  }

  const targetControls = <ComposerTargetControls mentionedAgentIds={mentionedAgentIds} orchestrationEnabled={mentionedAgentIds.length > 1} orchestrationMode={orchestrationMode} pendingWorkflowName={pendingWorkflowPlan?.name || null} onOpenWorkflowPicker={() => setShowWorkflowPicker(true)} effectiveComposerAgentId={effectiveComposerAgentId} rememberedComposerAgentId={rememberedComposerAgentId} currentChatId={currentChatId} getAgentModels={(agentId) => agents.find((agent) => agent.id === agentId)?.models || []} getSelectedModelIdForAgent={getSelectedModelIdForAgent} openModelMenuAgentId={agentPanelState.openModelMenuAgentId} setOpenModelMenuAgentId={agentPanelState.setOpenModelMenuAgentId} modelMenuRefs={agentPanelState.modelMenuRefs} setSelectedModelForAgent={registry.setSelectedModelForAgent} clearLastUsedAgent={() => registry.clearLastUsedAgent(currentChatId || undefined)} setOrchestrationMode={setOrchestrationMode} />;

  return <div className="chatPageRoot"><ChatShell themeStyle={themeStyle} themeId={normalizedThemeId} sidebarWidth={sidebarWidth} sidebarCollapsed={sidebarCollapsed} agentsSidebarOpen={showAgentsPanel || showNodesPanel || showSchedulesPanel} onSidebarResizeStart={(e) => { e.preventDefault(); setOpenChatMenuId(null); sidebarDragRef.current = true; document.body.style.cursor = 'col-resize'; document.body.style.userSelect = 'none'; }} mobilePanel={showChatsPanel ? 'chat' : showAgentsPanel ? 'agents' : showNodesPanel ? 'nodes' : showSchedulesPanel ? 'schedules' : null} onMobilePanelChange={(panel) => { if (panel === null) { setShowChatsPanel(false); setShowAgentsPanel(false); setShowNodesPanel(false); setShowSchedulesPanel(false); } }}
    header={<PageHeader authLabel={session?.user ? (session.user.name || '?') : ''} isAdmin={isAdmin} onSignOut={() => void signOut()} themeMenu={<ThemeMenu activeThemeId={themeId} onSelectTheme={setThemeId} />} showChatsPanel={showChatsPanel} showAgentsPanel={showAgentsPanel} showNodesPanel={showNodesPanel} showSchedulesPanel={showSchedulesPanel} onToggleChats={() => { switchLeftSidebarTab('chats'); setShowChatsPanel((p) => !p); setShowAgentsPanel(false); setShowNodesPanel(false); setShowSchedulesPanel(false); }} onToggleAgents={() => { setShowAgentsPanel((p) => !p); setShowChatsPanel(false); setShowNodesPanel(false); setShowSchedulesPanel(false); }} onToggleNodes={() => { setShowNodesPanel((p) => { if (!p) void loadNodes(); return !p; }); setShowAgentsPanel(false); setShowChatsPanel(false); setShowSchedulesPanel(false); }} onToggleSchedules={() => { setShowSchedulesPanel((p) => !p); setShowAgentsPanel(false); setShowNodesPanel(false); setShowChatsPanel(false); }} activeThemeId={themeId} normalizedThemeId={normalizedThemeId} onSelectTheme={setThemeId} lastUsedAgentScope={lastUsedAgentScope} onSelectLastUsedAgentScope={registry.setLastUsedAgentScope} />}
    sidebar={<aside className={`participantsSidebar ${showChatsPanel ? 'mobilePanelVisible' : ''}`}><div className="participantsHeader">{sidebarCollapsed ? <div className="collapsedSidebarControls"><button className="sidebarExpandBtn" onClick={() => setSidebarCollapsed(false)} title="Expand sidebar" aria-label="Expand sidebar"><svg className="sidebarToggleIcon" viewBox="0 0 16 16" aria-hidden="true"><rect x="1.5" y="2" width="13" height="12" rx="2" fill="none" stroke="currentColor" strokeWidth="1.4" /><path d="M6 2v12" stroke="currentColor" strokeWidth="1.4" /></svg></button><button className={`collapsedSidebarTabButton ${leftSidebarTab === 'chats' ? 'active' : ''}`} onClick={() => { setLeftSidebarTab('chats'); setSidebarCollapsed(false); }} title="Show chats" aria-label="Show chats"><svg className="collapsedSidebarTabIcon" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 3h10a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H7l-3.2 2.4a.5.5 0 0 1-.8-.4V10H3a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" /></svg></button><button className={`collapsedSidebarTabButton ${leftSidebarTab === 'files' ? 'active' : ''}`} onClick={() => { setLeftSidebarTab('files'); setSidebarCollapsed(false); }} title="Show files" aria-label="Show files"><svg className="collapsedSidebarTabIcon" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2.5h5.2L12.5 5v8.5H4z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" /><path d="M9.2 2.5V5H12.5" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" /></svg></button></div> : <><div className="leftSidebarTabs"><button className={`leftSidebarTab ${leftSidebarTab === 'chats' ? 'active' : ''}`} onClick={() => switchLeftSidebarTab('chats')}>💬 Chats</button><button className={`leftSidebarTab ${leftSidebarTab === 'files' ? 'active' : ''}`} onClick={() => setLeftSidebarTab('files')}>📄 Files</button></div><button className="sidebarCollapseBtn" onClick={() => setSidebarCollapsed(true)} title="Collapse sidebar" aria-label="Collapse sidebar"><svg className="sidebarToggleIcon" viewBox="0 0 16 16" aria-hidden="true"><rect x="1.5" y="2" width="13" height="12" rx="2" fill="none" stroke="currentColor" strokeWidth="1.4" /><path d="M6 2v12" stroke="currentColor" strokeWidth="1.4" /></svg></button></>}</div>{!sidebarCollapsed && leftSidebarTab === 'chats' && <div className="participantsList"><div className="chatAgentFilterRow" aria-label="Filter chats by primary agent"><div className="chatAgentFilterPickerSlot"><SelectPicker options={[{ value: '', label: 'All agents' }, ...chatFilterAgents.map((a) => ({ value: a.id, label: a.name || a.id }))]} value={registry.selectedAgentFilter ?? ''} ariaLabel="Filter chats by primary agent" onChange={(v) => switchAgentFilter(v || null)} /></div></div><ChatSidebarList chatHistory={chatHistory} currentChatId={currentChatId} activeSidebarChatId={activeSidebarChatId} chatName={chatName} chatAgentFilter={registry.selectedAgentFilter} chatFilterAgents={chatFilterAgents} mounted={mounted} openChatMenuId={openChatMenuId} renamingChatId={renamingChatId} renameValue={renameValue} themeStyle={themeStyle} chatMenuButtonRefs={chatMenuButtonRefs} actionMenuWidth={CHAT_ACTION_MENU_WIDTH} actionMenuHeight={CHAT_ACTION_MENU_HEIGHT} getChatSidebarStatus={getChatSidebarStatus} onCreateChat={() => void createNewChat()} onLoadChat={(chatId) => void loadChat(chatId)} onOpenChatMenu={setOpenChatMenuId} onRenameValueChange={setRenameValue} onCancelRename={() => { setRenamingChatId(null); setRenameValue(''); }} onStartRename={(chat, isCurrent) => { setRenameValue(isCurrent ? chatName : chat.name); setRenamingChatId(chat.id); }} onRenameChat={(chatId, value) => void renameChatById(chatId, value)} onShareChat={(chatId) => void shareCurrentChat(chatId)} onDeleteChat={(chatId) => void deleteChatById(chatId)} /></div>}{!sidebarCollapsed && leftSidebarTab === 'files' && <FileWorkspacePanel variant="tree" workspace={fileWorkspace} agents={agents} schedulerAgentId={SCHEDULER_AGENT_ID} />}</aside>}
    messages={leftSidebarTab === 'files' && mdEditorOpen && mdSelectedFile ? <FileWorkspacePanel workspace={fileWorkspace} comments={fileCommentsController} selection={fileCommentsController.selection} /> : !currentChatId ? <div className="emptyHomepage"><div className="emptyHomepageContent"><div className="emptyHomepageLogo">💬</div><h2 className="emptyHomepageTitle">Agents Chat</h2><p className="emptyHomepageSubtitle">Start a new conversation with your agents</p><button className="emptyHomepageNewChat" onClick={() => void createNewChat()}>+ New Chat{registry.selectedAgentFilter ? ` with ${chatFilterAgents.find((a) => a.id === registry.selectedAgentFilter)?.name || registry.selectedAgentFilter}` : ''}</button></div></div> : <section className="chatContainer" ref={chatContainerRef} onScroll={(e) => updateChatStickiness(e.currentTarget)} onWheel={(e) => { if (e.deltaY < 0) shouldStickToBottomRef.current = false; }}><MessageList messages={visibleMessages} agents={agents} expandedMessages={expandedMessages} failedSendByMessageId={failedSendByMessageId} onToggleExpanded={toggleMessageExpanded} onRetryFailedSend={retryFailedSend} onOpenImage={setLightboxImage} onAnswerAgentUserRequest={answerAgentUserRequest} onDismissAgentUserRequest={dismissAgentUserRequest} />{showFollowUpHint && workflowFollowUp ? <WorkflowFollowUpCard agentIds={workflowFollowUp.awaitingAgentIds} agents={agents} onReply={(text) => sendWorkflowFollowUpReply(text, workflowFollowUp.awaitingAgentIds, workflowFollowUp.orchestrationId)} onDismiss={() => setDismissedFollowUpOrchId(workflowFollowUp.orchestrationId)} /> : null}</section>}
    composer={currentChatId && !(leftSidebarTab === 'files' && mdEditorOpen && mdSelectedFile) ? <ChatComposer composerRef={composerRef} fileInputRef={fileInputRef} input={input} attachments={attachments} attachmentError={attachmentError} isDraggingAttachment={isDraggingAttachment} mentionAgents={filteredAgents} mentionSelectedIndex={mentionSelectedIndex} slashCommands={filteredSlashCommands} slashSelectedIndex={slashSelectedIndex} targetControls={targetControls} isSending={isCurrentChatSending} sendDisabled={agents.length === 0} onMentionSelect={selectMention} onSlashCommandSelect={insertSlashCommand} onFilesSelected={(files) => void addFilesToComposer(files)} onRemoveAttachment={removeAttachment} onPreviewAttachment={setLightboxImage} onPaste={handleAttachmentPaste} onKeyDown={handleComposerKeyDown} onInput={composerInputHandler} onDragOver={handleComposerDragOver} onDragLeave={handleComposerDragLeave} onDrop={handleComposerDrop} onSend={() => void handleSend()} onStop={() => void handleStop()} /> : null}
    rightPanel={<><AgentsPanel panelState={agentPanelState} agents={agentSidebarItems} agentsLoading={agentsLoading} isAdmin={isAdmin} nodesData={nodesData} selectedAgentFilter={registry.selectedAgentFilter} selectedAgentModels={registry.selectedAgentModels} ensuringAgentModels={registry.ensuringAgentModels} setSelectedModelForAgent={registry.setSelectedModelForAgent} reloadAgents={reloadAgents} /><NodesPanel panelState={nodePanelState} /><SchedulesPanel isOpen={showSchedulesPanel} onClose={() => setShowSchedulesPanel(false)} agents={agentSidebarItems.map(a => ({ id: a.id, name: a.name || a.id }))} /></>}
    statusBar={<StatusBar statusText={`${agents.length} agent${agents.length !== 1 ? 's' : ''} configured`} targetText={`${messages.filter((m) => m.type === 'user').length} messages`} isRunning={agents.length > 0} planSlot={activeWorkflow ? <PlanProgressBar orchestration={activeWorkflow} variant="inline" /> : null} />}
    shareDialog={shareDialog ? <ShareDialogComponent dialog={shareDialog} onCopyLink={() => void copyShareDialogLink()} onClose={() => setShareDialog(null)} /> : null}
    imageLightbox={lightboxImage ? <ImageLightbox src={lightboxImage} onClose={() => setLightboxImage(null)} /> : null}
    workflowPicker={<WorkflowPicker open={showWorkflowPicker} onClose={() => setShowWorkflowPicker(false)} agentIds={agents.map((a) => a.id)} onPicked={(plan) => { setPendingWorkflowPlan(plan); setOrchestrationMode('workflow'); }} />}
  /></div>;
}

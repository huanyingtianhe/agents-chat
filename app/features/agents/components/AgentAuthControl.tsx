'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Agent, AgentAuthMethod } from '../agentTypes';

export interface AgentAuthControlProps {
  agent: Agent;
  /** Called after a successful authenticate() so the parent can refresh agent list / status. */
  onAuthenticated?: () => void;
}

/**
 * Pill button shown on agent rows when the underlying agent process either
 * reports `needsAuth: true` or advertises one or more ACP auth methods.
 *
 * Clicking opens a small popover that lets the user pick a method and triggers
 * the ACP `authenticate` flow on the server.
 */
export function AgentAuthControl({ agent, onAuthenticated }: AgentAuthControlProps) {
  const methods = agent.authMethods ?? [];
  const needsAuth = !!agent.needsAuth;
  const [open, setOpen] = useState(false);
  const [busyMethodId, setBusyMethodId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const [popoverPos, setPopoverPos] = useState<{ top: number; left: number } | null>(null);
  const [mounted, setMounted] = useState(false);

  useEffect(() => { setMounted(true); }, []);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: MouseEvent) {
      const target = event.target as Node;
      if (wrapRef.current?.contains(target)) return;
      if (popoverRef.current?.contains(target)) return;
      setOpen(false);
      setError(null);
    }
    window.addEventListener('mousedown', onPointerDown);
    return () => window.removeEventListener('mousedown', onPointerDown);
  }, [open]);

  useLayoutEffect(() => {
    if (!open || !wrapRef.current) return;
    function reposition() {
      const wrap = wrapRef.current;
      if (!wrap) return;
      const rect = wrap.getBoundingClientRect();
      const popoverWidth = popoverRef.current?.offsetWidth ?? 260;
      const margin = 8;
      // Prefer aligning popover's right edge with the pill's right edge.
      let left = rect.right - popoverWidth;
      if (left < margin) left = margin;
      if (left + popoverWidth > window.innerWidth - margin) {
        left = window.innerWidth - popoverWidth - margin;
      }
      const top = rect.bottom + 6;
      setPopoverPos({ top, left });
    }
    reposition();
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    return () => {
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
    };
  }, [open]);

  if (!needsAuth) return null;

  async function authenticate(methodId: string) {
    setBusyMethodId(methodId);
    setError(null);
    setSuccess(false);
    try {
      const res = await fetch('/api/acp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'acp-authenticate', agentId: agent.id, methodId }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json?.ok) {
        const hint = typeof json?.hint === 'string' ? json.hint : null;
        const errMsg = typeof json?.error === 'string' ? json.error : `HTTP ${res.status}`;
        setError(hint || errMsg);
      } else {
        setSuccess(true);
        onAuthenticated?.();
        setTimeout(() => setOpen(false), 600);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyMethodId(null);
    }
  }

  const buttonLabel = needsAuth ? '⚠️ Sign in' : '🔑';
  const buttonTitle = needsAuth
    ? `${agent.name} needs authentication`
    : `Sign in to ${agent.name}`;

  return (
    <div className="agentAuthControl" ref={wrapRef} onClick={(e) => e.stopPropagation()}>
      <span
        role="button"
        tabIndex={0}
        className={`agentAuthButton ${needsAuth ? 'needsAuth' : ''}`}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen((v) => !v); } }}
        title={buttonTitle}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        {buttonLabel}
      </span>
      {open && mounted && createPortal(
        <div
          className="agentAuthPopover"
          role="menu"
          ref={popoverRef}
          style={popoverPos ? { top: popoverPos.top, left: popoverPos.left } : { visibility: 'hidden' }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="agentAuthPopoverTitle">Authenticate {agent.name}</div>
          {methods.length === 0 && (
            <div className="agentAuthHint">
              The agent didn&apos;t advertise any sign-in methods over ACP.
              You may need to sign in by running the agent&apos;s CLI in a terminal
              (for example, <code>copilot</code> then <code>/login</code>).
            </div>
          )}
          {methods.map((m: AgentAuthMethod) => {
            const disabled = busyMethodId !== null;
            return (
              <div
                key={m.id}
                role="menuitem"
                tabIndex={disabled ? -1 : 0}
                aria-disabled={disabled}
                className={`agentAuthMethodBtn ${disabled ? 'disabled' : ''}`}
                onClick={() => { if (!disabled) void authenticate(m.id); }}
                onKeyDown={(e) => {
                  if (disabled) return;
                  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); void authenticate(m.id); }
                }}
                title={m.description || m.id}
              >
                <span className="agentAuthMethodName">{m.name || m.id}</span>
                {m.description && <span className="agentAuthMethodDesc">{m.description}</span>}
                {busyMethodId === m.id && <span className="agentAuthBusy">…</span>}
              </div>
            );
          })}
          {error && <div className="agentAuthError">{error}</div>}
          {success && <div className="agentAuthSuccess">✓ Authenticated</div>}
        </div>,
        document.body,
      )}
    </div>
  );
}

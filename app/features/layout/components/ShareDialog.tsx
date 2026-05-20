'use client';

import type { ShareDialog as ShareDialogData } from '../../../features/chat/chatTypes';

export type ShareDialogProps = {
  dialog: ShareDialogData;
  onCopyLink: () => void;
  onClose: () => void;
};

export function ShareDialog({ dialog, onCopyLink, onClose }: ShareDialogProps) {
  return (
    <div className="modalOverlay">
      <div className={`modal shareLinkModal ${dialog.variant}`} role="dialog" aria-modal="true" aria-labelledby="shareDialogTitle" onClick={(e) => e.stopPropagation()}>
        <h2 id="shareDialogTitle">{dialog.title}</h2>
        {dialog.url ? (
          <>
            <p className="shareDialogText">Anyone with this link can view the shared conversation.</p>
            <input
              className="shareLinkInput"
              readOnly
              value={dialog.url}
              onFocus={(e) => e.currentTarget.select()}
            />
          </>
        ) : (
          <p className="shareDialogText">{dialog.detail}</p>
        )}
        {dialog.detail && dialog.url ? <p className="shareDialogStatus">{dialog.detail}</p> : null}
        <div className="modalActions">
          {dialog.url ? (
            <button type="button" onClick={onCopyLink}>{dialog.copied ? 'Copied' : 'Copy'}</button>
          ) : null}
          <button type="button" className="secondary" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

'use client';

import type { ChatAttachment } from '../attachmentTypes';
import { getAttachmentIconLabel, getAttachmentTypeLabel, formatBytes } from '../attachmentHelpers';

interface AttachmentListProps {
  attachments?: ChatAttachment[];
  mode?: 'composer' | 'message';
  onRemove?: (id: string) => void;
  onPreview?: (dataUrl: string) => void;
}

export function AttachmentList({
  attachments,
  mode = 'message',
  onRemove,
  onPreview,
}: AttachmentListProps) {
  if (!attachments?.length) return null;

  return (
    <div className={mode === 'composer' ? 'attachmentTray' : 'messageAttachments'}>
      {attachments.map((attachment) => (
        <div
          key={attachment.id}
          className={mode === 'composer' ? 'attachmentChip' : 'messageAttachment'}
          title={mode === 'composer' ? `${attachment.name} · ${getAttachmentTypeLabel(attachment)} · ${formatBytes(attachment.size)}` : undefined}
        >
          {attachment.kind === 'image' && mode === 'message' ? (
            <span className="messageAttachmentImageWrap" tabIndex={0} aria-label={`Preview ${attachment.name}`}
              onClick={() => { onPreview?.(attachment.dataUrl); }}
              style={{ cursor: 'pointer' }}
            >
              <img
                src={attachment.dataUrl}
                alt={attachment.name}
                className="messageAttachmentImage"
              />
              <span className="messageAttachmentPreview" aria-hidden="true">
                <img src={attachment.dataUrl} alt="" className="messageAttachmentPreviewImage" />
              </span>
            </span>
          ) : attachment.kind === 'image' ? (
            <img
              src={attachment.dataUrl}
              alt={attachment.name}
              className={mode === 'composer' ? 'attachmentThumb' : 'messageAttachmentImage'}
            />
          ) : (
            <div className={mode === 'composer' ? 'attachmentFileIcon' : 'messageAttachmentFileIcon'} aria-hidden="true">
              <span className="attachmentFileIconLabel">{getAttachmentIconLabel(attachment)}</span>
            </div>
          )}
          <div className="attachmentMeta">
            <span className="attachmentName" title={attachment.name}>{attachment.name}</span>
            {mode === 'composer' ? null : <span className="attachmentDetails">{getAttachmentTypeLabel(attachment)} · {formatBytes(attachment.size)}</span>}
          </div>
          {mode === 'composer' ? (
            <button
              type="button"
              className="attachmentRemoveButton"
              aria-label={`Remove ${attachment.name}`}
              title={`Remove ${attachment.name}`}
              onClick={() => onRemove?.(attachment.id)}
            >
              ×
            </button>
          ) : null}
        </div>
      ))}
    </div>
  );
}

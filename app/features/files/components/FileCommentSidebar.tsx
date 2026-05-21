'use client';

import { FILE_REVIEW_LINE_HEIGHT } from '../fileWorkspaceHelpers';
import type { UseFileCommentsResult } from '../hooks/useFileComments';
import type { UseLiveEditorSelectionResult } from '../hooks/useLiveEditorSelection';

type FileCommentSidebarProps = {
  comments: UseFileCommentsResult;
  selection: UseLiveEditorSelectionResult;
};

export function FileCommentSidebar({ comments, selection }: FileCommentSidebarProps) {
  if (!comments.commentSidebarOpen) {
    return comments.fileComments.length > 0 ? (
      <div className="commentSidebarCollapsed" onClick={() => comments.setCommentSidebarOpen(true)} title="Open comments">
        <span className="commentSidebarCollapsedLabel">COMMENTS</span>
        <span className="commentBadge">{comments.fileComments.filter(c => c.status === 'active').length}</span>
        <span className="commentExpandBtn">▶</span>
      </div>
    ) : null;
  }

  const visibleComments = comments.getVisibleSidebarComments();
  const commentLayout = comments.getCommentSidebarLayout(visibleComments);

  return (
    <div className="commentSidebar" ref={comments.commentSidebarRef}>
      <div className="commentSidebarHeader">
        <span>Comments</span>
        <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
          <select
            className="commentFilterSelect"
            value={comments.commentFilter}
            onChange={(e) => comments.setCommentFilter(e.target.value as 'all' | 'active' | 'resolved')}
          >
            <option value="all">All</option>
            <option value="active">Active</option>
            <option value="resolved">Resolved</option>
          </select>
          <button className="sidebarToggle" onClick={() => comments.setCommentSidebarOpen(false)} title="Collapse comments">◀</button>
        </div>
      </div>
      <div className="commentSidebarList">
        <div className="commentSidebarCanvas" style={{ minHeight: `${comments.getCommentSidebarHeight(visibleComments, commentLayout)}px` }}>
          {visibleComments.map(c => {
            const isSelected = comments.selectedCommentId === c.id;
            const isReplying = comments.replyingToCommentId === c.id;
            const repliesExpanded = comments.expandedReplyIds.has(c.id);
            return (
              <div
                key={c.id}
                data-comment-id={c.id}
                className={`commentCard aligned ${isSelected ? 'selected' : ''} ${c.status === 'resolved' ? 'resolved' : ''} ${c.status === 'processing' ? 'processing' : ''} ${c.status === 'queued' ? 'queued' : ''}`}
                style={{ top: `${commentLayout.get(c.id) ?? comments.getCommentLineTop(c)}px` }}
                onClick={() => comments.setSelectedCommentId(isSelected ? null : c.id)}
              >
                <div className="commentCardHeader">
                  <span className="commentAuthor">{c.authorType === 'agent' ? '🤖' : '👤'} {c.authorName || c.authorType}</span>
                  <span className="commentHeaderMeta">
                    <span className={`commentStatusBadge ${c.status}`}>{comments.getCommentStatusLabel(c.status)}</span>
                    <span className="commentLineRange">
                      {c.rangeStartLine != null ? (c.rangeEndLine != null && c.rangeEndLine !== c.rangeStartLine ? `L${c.rangeStartLine}-${c.rangeEndLine}` : `L${c.rangeStartLine}`) : ''}
                    </span>
                  </span>
                </div>
                {isSelected || c.status === 'processing' || c.status === 'queued' ? (
                  <>
                    <div className="commentContent">{c.content}</div>
                    {c.status === 'active' && (
                      <div className="commentActions">
                        <button className="commentActionBtn approve" onClick={(e) => { e.stopPropagation(); void comments.handleApproveComment(c.id); }}>✓ Approve</button>
                        <button className="commentActionBtn reject" onClick={(e) => { e.stopPropagation(); void comments.handleRejectComment(c.id); }}>✗ Reject</button>
                        <button className="commentActionBtn reply" onClick={(e) => { e.stopPropagation(); comments.setReplyingToCommentId(isReplying ? null : c.id); comments.setReplyInput(''); }}>💬 Reply</button>
                      </div>
                    )}
                    {c.status === 'processing' && (
                      <>
                        <div className="commentProcessing" onClick={(e) => {
                          e.stopPropagation();
                          if (c.linkedChatId) comments.openCommentReviewChat(c.linkedChatId);
                        }}>
                          <span className="commentSpinner" />
                          <span>Processing… (click to view)</span>
                        </div>
                        <div className="commentActions">
                          <button className="commentActionBtn stop" onClick={(e) => { e.stopPropagation(); void comments.handleStopProcessingComment(c); }}>⏹ Stop</button>
                        </div>
                      </>
                    )}
                    {c.status === 'queued' && (
                      <div className="commentProcessing queued" onClick={(e) => {
                        e.stopPropagation();
                        if (c.linkedChatId) comments.openCommentReviewChat(c.linkedChatId);
                      }}>
                        <span>⏳ Queued… (click to view)</span>
                      </div>
                    )}
                    {c.status === 'resolved' && (
                      <div className="commentResolved">
                        <span>✓ Resolved</span>
                        {c.linkedChatId && (
                          <button
                            type="button"
                            className="commentReviewChatLink"
                            onClick={(e) => {
                              e.stopPropagation();
                              comments.openCommentReviewChat(c.linkedChatId!);
                            }}
                          >
                            View chat
                          </button>
                        )}
                      </div>
                    )}
                    {c.replies.length > 0 && (
                      <div className="commentReplies">
                        {!repliesExpanded && c.replies.length > 1 ? (
                          <button className="commentShowReplies" onClick={(e) => { e.stopPropagation(); comments.setExpandedReplyIds(prev => new Set(prev).add(c.id)); }}>
                            {c.replies.length} replies
                          </button>
                        ) : (
                          c.replies.map(rp => (
                            <div key={rp.id} className="commentReply">
                              <span className="commentReplyAuthor">{rp.authorType === 'agent' ? '🤖' : '👤'} {rp.authorName || rp.authorType}</span>
                              <span className="commentReplyText">{rp.content}</span>
                            </div>
                          ))
                        )}
                      </div>
                    )}
                    {isReplying && (
                      <div className="commentReplyInput" onClick={(e) => e.stopPropagation()}>
                        <input
                          type="text"
                          value={comments.replyInput}
                          onChange={(e) => comments.setReplyInput(e.target.value)}
                          placeholder="Reply…"
                          onKeyDown={(e) => { if (e.key === 'Enter') void comments.handleReplyComment(c.id); }}
                          autoFocus
                        />
                        <button onClick={() => void comments.handleReplyComment(c.id)}>Send</button>
                      </div>
                    )}
                  </>
                ) : (
                  <div className="commentContentCompact">{c.content}</div>
                )}
              </div>
            );
          })}
          {comments.showCommentInput && comments.commentAddRange && (() => {
            const anchorTop = selection.liveSelectionDraftAnchor?.rects?.[0]?.top;
            const top = anchorTop != null
              ? anchorTop - comments.commentSourceScrollTop
              : (comments.commentAddRange.startLine - 1) * FILE_REVIEW_LINE_HEIGHT - comments.commentSourceScrollTop;
            return (
              <div className="commentAddForm aligned" ref={comments.commentAddFormRef} style={{ top: `${top}px` }}>
                <div className="commentAddLabel">
                  New comment on L{comments.commentAddRange.startLine}{comments.commentAddRange.endLine !== comments.commentAddRange.startLine ? `-${comments.commentAddRange.endLine}` : ''}
                </div>
                <textarea
                  className="commentAddTextarea"
                  value={comments.commentInput}
                  onChange={(e) => comments.setCommentInput(e.target.value)}
                  placeholder="Write a comment…"
                  autoFocus={!selection.liveSelectionDraftAnchor}
                />
                <div className="commentAddActions">
                  <button className="commentActionBtn" onClick={() => {
                    comments.setShowCommentInput(false);
                    comments.setCommentAddRange(null);
                    comments.setCommentInput('');
                    selection.clearLiveSelectionDraft();
                  }}>Cancel</button>
                  <button className="commentActionBtn approve" onClick={() => void comments.handleCreateComment()} disabled={!comments.commentInput.trim()}>Submit</button>
                </div>
              </div>
            );
          })()}
        </div>
        {visibleComments.length === 0 && !comments.showCommentInput && (
          <div className="muted" style={{ padding: 20, textAlign: 'center', fontSize: 13 }}>No comments</div>
        )}
      </div>
    </div>
  );
}

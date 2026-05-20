'use client';

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { markdownToHtml, mdComponents } from '../../messages/markdownHelpers';
import { FILE_REVIEW_LINE_HEIGHT, buildSimpleLineDiff, getFileIcon, isHtmlFile, isMarkdownFile } from '../fileWorkspaceHelpers';
import type { FileComment } from '../fileWorkspaceTypes';
import type { UseFileCommentsResult } from '../hooks/useFileComments';
import type { UseFileWorkspaceStateResult } from '../hooks/useFileWorkspaceState';
import type { UseLiveEditorSelectionResult } from '../hooks/useLiveEditorSelection';

type FileEditorPanelProps = {
  workspace: UseFileWorkspaceStateResult;
  comments: UseFileCommentsResult;
  selection: UseLiveEditorSelectionResult;
};

export function FileEditorPanel({ workspace, comments, selection }: FileEditorPanelProps) {
  const filePath = workspace.mdSelectedFile;
  if (!filePath) return null;

  const renderLineCommentMarker = (lineNum: number, commentsForLine: FileComment[]) => {
    if (commentsForLine.length === 0) return null;
    const selectedOnLine = commentsForLine.some(c => c.id === comments.selectedCommentId);
    const markerComment = commentsForLine.find(c => c.authorType === 'agent') || commentsForLine[0];
    const markerColor = markerComment.authorType === 'agent' ? 'var(--comment-agent-color)' : 'var(--comment-user-color)';
    const label = `${commentsForLine.length} comment${commentsForLine.length === 1 ? '' : 's'} on line ${lineNum}`;
    return (
      <button
        type="button"
        className={`lineCommentMarker ${selectedOnLine ? 'selected' : ''}`}
        style={{ borderColor: markerColor, color: markerColor }}
        onClick={(e) => { e.stopPropagation(); comments.openLineComment(commentsForLine); }}
        title={commentsForLine.map(c => c.content).join('\n')}
        aria-label={label}
      >
        💬{commentsForLine.length > 1 ? <span className="lineCommentCount">{commentsForLine.length}</span> : null}
      </button>
    );
  };

  const renderReviewFileLineText = (line: string, lineNum: number, selectedComment: FileComment | undefined) => {
    if (!selectedComment || selectedComment.rangeStartLine == null) return line || ' ';
    const startLine = selectedComment.rangeStartLine;
    const endLine = selectedComment.rangeEndLine ?? startLine;
    if (lineNum < startLine || lineNum > endLine) return line || ' ';
    const startChar = lineNum === startLine ? (selectedComment.rangeStartChar ?? 0) : 0;
    const endChar = lineNum === endLine ? (selectedComment.rangeEndChar ?? line.length) : line.length;
    const boundedStart = Math.max(0, Math.min(startChar, line.length));
    const boundedEnd = Math.max(boundedStart, Math.min(endChar, line.length));
    return (
      <>
        {line.slice(0, boundedStart)}
        <span className="fileLineSelectedText">{line.slice(boundedStart, boundedEnd) || ' '}</span>
        {line.slice(boundedEnd)}
      </>
    );
  };

  const renderReviewFileLine = (line: string, idx: number, commentsByLine: Map<number, FileComment[]>) => {
    const lineNum = idx + 1;
    const commentsForLine = commentsByLine.get(lineNum) || [];
    const isHighlighted = commentsForLine.some(c => c.id === comments.selectedCommentId);
    const selectedComment = commentsForLine.find(c => c.id === comments.selectedCommentId);
    return (
      <div
        key={idx}
        className={`fileLine ${isHighlighted ? 'highlighted' : ''} ${commentsForLine.length > 0 && !isHighlighted ? 'has-comment' : ''}`}
        data-line-num={lineNum}
      >
        <span className="fileLineGutter"><span className="fileLineNum">{lineNum}</span></span>
        <span className="fileLineText">{renderReviewFileLineText(line, lineNum, selectedComment)}</span>
        <span className="fileLineCommentSlot">{renderLineCommentMarker(lineNum, commentsForLine)}</span>
      </div>
    );
  };

  const renderFileLines = () => {
    const commentsByLine = comments.getCommentsByLine();
    return workspace.mdEditContent.split('\n').map((line, idx) => renderReviewFileLine(line, idx, commentsByLine));
  };

  const renderAddCommentButton = () => comments.commentAddRange && !comments.showCommentInput ? (
    <button
      className="addCommentFloatingBtn"
      style={{
        position: 'absolute',
        right: comments.commentSidebarOpen ? '280px' : '40px',
        top: `${(comments.commentAddRange.startLine - 1) * FILE_REVIEW_LINE_HEIGHT + 40}px`,
      }}
      onClick={() => {
        comments.setShowCommentInput(true);
        if (!comments.commentSidebarOpen) comments.setCommentSidebarOpen(true);
      }}
    >
      💬 Add Comment
    </button>
  ) : null;

  return (
    <div className="mdEditorContent">
      {workspace.mdConflict && workspace.mdConflict.mode === 'choice' && (
        <div className="mdConflictBackdrop" role="dialog" aria-modal="true" aria-labelledby="md-conflict-title">
          <div className="mdConflictDialog">
            <h2 id="md-conflict-title">File changed on disk</h2>
            <p>Someone else saved <strong>{workspace.mdConflict.path}</strong> after you opened it. Choose how to resolve the conflict.</p>
            <div className="mdConflictActions">
              <button className="mdEditorBtn danger" onClick={workspace.resolveMdConflictByReload}>Reload</button>
              <button className="mdEditorBtn" onClick={workspace.beginManualMdConflictResolution}>Handle conflict manually</button>
              <button className="mdEditorBtn secondary" onClick={() => workspace.setMdConflict(null)}>Cancel</button>
            </div>
            <p className="mdConflictNote">Reload will discard your current unsaved changes.</p>
          </div>
        </div>
      )}
      {workspace.mdConflict && workspace.mdConflict.mode === 'manual' && (
        <div className="mdConflictDiffPage">
          <div className="mdConflictDiffHeader">
            <div>
              <h2>Resolve conflict: {workspace.mdConflict.path}</h2>
              <p>Review the server version and your version. Edit the resolved content, or use the quick choices to keep server / keep mine.</p>
            </div>
            <div className="mdConflictActions">
              <button className="mdEditorBtn secondary" onClick={workspace.keepServerVersion}>keep server</button>
              <button className="mdEditorBtn secondary" onClick={workspace.keepMineVersion}>keep mine</button>
              <button className="mdEditorBtn" onClick={() => void workspace.handleSaveManualMdConflict()} disabled={workspace.mdSaving}>
                {workspace.mdSaving ? 'Saving…' : 'Save resolved'}
              </button>
              <button className="mdEditorBtn secondary" onClick={() => workspace.setMdConflict({ ...workspace.mdConflict!, mode: 'choice' })}>Back</button>
            </div>
          </div>
          <div className="mdConflictDiffGrid" aria-label="Conflict diff">
            <div className="mdConflictDiffColumn"><div className="mdConflictColumnTitle">Server</div><pre>{workspace.mdConflict.serverContent}</pre></div>
            <div className="mdConflictDiffColumn"><div className="mdConflictColumnTitle">Mine</div><pre>{workspace.mdConflict.mineContent}</pre></div>
          </div>
          <div className="mdConflictDiffRows">
            {buildSimpleLineDiff(workspace.mdConflict.serverContent, workspace.mdConflict.mineContent).map((line, index) => (
              <div key={line.key} className={`mdConflictDiffRow ${line.type}`}>
                <span className="mdConflictLineNo">{index + 1}</span>
                <code>{line.serverLine ?? ''}</code>
                <code>{line.mineLine ?? ''}</code>
              </div>
            ))}
          </div>
          <label className="mdConflictResolvedLabel" htmlFor="md-conflict-resolved">Resolved content</label>
          <textarea
            id="md-conflict-resolved"
            className="mdConflictResolvedTextarea"
            value={workspace.mdConflictResolvedContent}
            onChange={(e) => workspace.setMdConflictResolvedContent(e.target.value)}
            spellCheck={false}
          />
        </div>
      )}
      <div className="mdEditorToolbar">
        <div className="mdEditorToolbarLeft">
          <span className="mdEditorFilePath">{getFileIcon(filePath)} {filePath}</span>
          {workspace.mdDirty && <span className="mdDirtyBadge">● Unsaved</span>}
        </div>
        <div className="mdEditorToolbarRight">
          {isMarkdownFile(filePath) && (
            <div className="mdModeToggle">
              <button className={`mdModeBtn ${workspace.mdEditorMode === 'split' ? 'active' : ''}`} onClick={() => {
                if (workspace.mdEditorMode === 'live') {
                  const md = workspace.syncLiveToMarkdown();
                  workspace.setMdEditContent(md);
                }
                workspace.setMdEditorMode('split');
              }}>Split</button>
              <button className={`mdModeBtn ${workspace.mdEditorMode === 'live' ? 'active' : ''}`} onClick={() => {
                workspace.setMdLiveHtml(markdownToHtml(workspace.mdEditContent));
                workspace.setMdEditorMode('live');
              }}>Live Edit</button>
            </div>
          )}
          {isHtmlFile(filePath) && (
            <>
              <span className="mdPreviewBadge">Rendered HTML</span>
              <div className="mdModeToggle">
                <button className="mdModeBtn active" onClick={() => workspace.setMdEditorMode('live')}>Preview</button>
              </div>
            </>
          )}
          <button
            className={`mdEditorBtn commentToggle ${comments.commentSidebarOpen ? 'active' : ''}`}
            onClick={() => comments.setCommentSidebarOpen(p => !p)}
            title="Toggle comments"
          >
            💬 {comments.fileComments.filter(c => c.status === 'active').length || ''}
          </button>
          <button className="mdEditorBtn save" onClick={() => void workspace.saveMdFile()} disabled={workspace.mdSaving || !workspace.mdDirty}>
            {workspace.mdSaving ? 'Saving…' : '💾 Save'}
          </button>
          <button className="mdEditorBtn secondary" onClick={() => {
            if (isMarkdownFile(filePath) && workspace.mdEditorMode === 'live') {
              const md = workspace.syncLiveToMarkdown();
              if (md !== workspace.mdFileContent && !confirm('Discard changes?')) return;
            } else if (workspace.mdDirty && !confirm('Discard changes?')) return;
            selection.clearLiveSelectionDraft();
            workspace.closeMdEditor();
          }}>
            ✕ Close
          </button>
        </div>
      </div>
      {!workspace.mdConflict && (isMarkdownFile(filePath) ? (
        workspace.mdEditorMode === 'split' ? (
          <div className="mdEditorSplit">
            <div className="mdEditorPane mdEditorEditPane">
              <textarea
                className="mdEditorTextarea"
                value={workspace.mdEditContent}
                onChange={(e) => { workspace.setMdEditContent(e.target.value); workspace.setMdDirty(e.target.value !== workspace.mdFileContent); }}
                spellCheck={false}
              />
            </div>
            <div className="mdEditorPane mdEditorPreviewPane">
              <div className="markdownBody">
                <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>{workspace.mdEditContent}</ReactMarkdown>
              </div>
            </div>
          </div>
        ) : workspace.mdEditorMode === 'review' ? (
          <div className="mdEditorSimple">
            <div className="fileContentWithLines" ref={selection.fileContentRef} onMouseUp={selection.handleTextSelection} onScroll={selection.handleFileContentScroll}>
              {renderFileLines()}
            </div>
            {renderAddCommentButton()}
          </div>
        ) : (
          <div className="mdEditorLive" ref={selection.mdLiveContainerRef} onScroll={selection.handleLiveEditorScroll}>
            <div
              ref={workspace.setMdLiveElementRef}
              className="mdLiveEditable markdownBody"
              contentEditable
              suppressContentEditableWarning
              onMouseDown={() => {
                selection.hideLiveEditCommentButton();
                selection.clearLiveSelectionDraft();
              }}
              onMouseUp={(e) => { if (e.detail >= 2) selection.liveEditSelectionRef.current(); }}
              onBeforeInput={selection.handleLiveEditableBeforeInput}
              onInput={selection.handleLiveEditableInput}
            />
            {selection.liveSelectionDraftAnchor && (
              <div className="liveSelectionDraftLayer" aria-hidden="true">
                {selection.liveSelectionDraftAnchor.rects.map((rect, idx) => (
                  <span
                    key={`${idx}-${rect.left}-${rect.top}`}
                    className="liveSelectionDraftHighlight"
                    style={{ left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` }}
                  />
                ))}
              </div>
            )}
            {selection.liveCommentMarkers.length > 0 && (
              <div className="liveCommentMarkerLayer">
                {selection.liveCommentMarkers.map(marker => (
                  <button
                    key={marker.lineNum}
                    type="button"
                    className={`lineCommentMarker liveCommentMarker ${marker.selected ? 'selected' : ''}`}
                    style={{ left: `${marker.left}px`, top: `${marker.top}px`, borderColor: marker.color, color: marker.color }}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={(e) => { e.stopPropagation(); comments.openCommentIds(marker.commentIds); }}
                    title={marker.title}
                    aria-label={marker.label}
                  >
                    💬{marker.count > 1 ? <span className="lineCommentCount">{marker.count}</span> : null}
                  </button>
                ))}
              </div>
            )}
            <button
              ref={selection.liveEditCommentBtnRef}
              className="addCommentFloatingBtn"
              style={{ position: 'absolute', display: 'none' }}
              onMouseDown={(e) => e.preventDefault()}
              onClick={selection.startPendingLiveCommentDraft}
            >
              💬 Add Comment
            </button>
          </div>
        )
      ) : isHtmlFile(filePath) ? (
        <div className="mdHtmlPreviewWrap">
          <iframe className="mdHtmlPreviewFrame" title={`Rendered preview of ${filePath}`} sandbox="" srcDoc={workspace.mdFileContent} />
        </div>
      ) : (
        <div className="mdEditorSimple">
          <div className="fileContentWithLines" ref={selection.fileContentRef} onMouseUp={selection.handleTextSelection} onScroll={selection.handleFileContentScroll}>
            {renderFileLines()}
          </div>
          {renderAddCommentButton()}
        </div>
      ))}
    </div>
  );
}

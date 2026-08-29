import { useState } from 'react';
import { MAX_TEXT_CHARS } from '../../shared/messages.js';
import { Button } from './Button.js';
import { IconSend } from './icons.js';

export interface TextSnippetProps {
  onSend: (content: string) => void;
}

/**
 * A note or link, sent as a control frame rather than a file. AGENTS.md is
 * explicit about the split here: plain Enter must still insert a newline (a
 * multi-line note would otherwise be impossible to write), and ⌘/Ctrl+Enter
 * is what submits.
 *
 * Composer only — it used to also list received notes, with their own Copy
 * buttons and copy-state, but that list is now one of `TransferRecord`'s row
 * kinds (interleaved with files, in send/receive order, newest first) rather
 * than a second, uncoordinated list living beside it. The copy state that
 * served it (`copiedIndex`/`copyFailedIndex`, the clipboard fallback, the
 * `COPIED_MS` timer) moved with it onto `TransferRecord`'s note rows.
 */
export function TextSnippet({ onSend }: TextSnippetProps) {
  const [draft, setDraft] = useState('');
  const canSend = draft.trim() !== '';

  function send(): void {
    if (!canSend) return;
    onSend(draft);
    setDraft('');
  }

  return (
    <section className="flex flex-col gap-3">
      {/* h3, not h2: this composer used to be a direct child of the session
          screen's <h1> section, where h2 was the right level. The two-column
          restructure moved it inside the Share section, whose own heading is
          an h2 (TransferPanel.tsx) — an h2 here would read as Share's peer
          rather than as part of it, flattening the hierarchy AGENTS.md
          requires. axe does not flag this: no level is skipped, the nesting
          is just wrong. The visual weight is set by the classes and does not
          change with the level. */}
      <h3 className="text-sm font-medium text-[var(--color-text-muted)]">Send a note</h3>
      <textarea
        aria-label="Text to send"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          // Plain Enter inserts a newline, same as any other textarea — only
          // the modified combination submits, so writing a multi-line note
          // stays possible. This is a shortcut for the Send button below, not
          // the only way to send: a phone keyboard has no Ctrl or ⌘, which
          // made the note box unusable on the devices this app is mostly for.
          if (event.key !== 'Enter' || !(event.metaKey || event.ctrlKey)) return;
          event.preventDefault();
          send();
        }}
        rows={3}
        // A note is one unchunked control frame, so it has a hard ceiling —
        // and before this, that ceiling silently moved with the transport
        // (see Sender.sendText). Stopping the paste here is the only way the
        // user finds out before pressing send.
        maxLength={MAX_TEXT_CHARS}
        placeholder="Paste a link or a note…"
        className="neo-inset w-full resize-y rounded-[var(--radius-md)] border-0 bg-[var(--color-surface-2)] p-3.5 text-base text-[var(--color-text)]"
        style={{ fontSize: '16px' }}
      />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="min-w-0 flex-1 text-xs text-[var(--color-text-muted)]">
          Up to {MAX_TEXT_CHARS.toLocaleString()} characters. Longer than that, send it as a file.{' '}
          {/* The shortcut is mentioned, never relied on. Hidden from touch
              devices, where no such key exists and naming it is just noise. */}
          <span className="hidden sm:inline">Or press ⌘/Ctrl&nbsp;+&nbsp;Enter.</span>
        </p>
        <Button icon={<IconSend />} onClick={send} disabled={!canSend}>Send</Button>
      </div>
      {/* maxLength truncates a long paste rather than rejecting it, and a
          100 KB log silently cut to its first 10,000 characters would look
          exactly like a successful send. Mounted only once the ceiling is
          reached, so the alert fires when that becomes true rather than
          sitting on screen from the start. Worded as a fact about the
          ceiling, not an accusation of loss: hitting the limit by typing
          drops nothing, and this component cannot tell that case from a
          truncated paste — the browser applies maxLength before onChange. */}
      {draft.length >= MAX_TEXT_CHARS && (
        <p role="alert" className="text-xs text-[var(--color-danger)]">
          This note is at the {MAX_TEXT_CHARS.toLocaleString()}-character limit, and nothing beyond it can be
          added, and a longer paste stops here. Send it as a file instead.
        </p>
      )}
    </section>
  );
}

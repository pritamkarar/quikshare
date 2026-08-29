import { Button } from '../ui/Button.js';
import { IconCheck } from '../ui/icons.js';
import { TransferRecord } from '../ui/TransferRecord.js';
import type { TrackedFile, TrackedNote } from '../hooks/useSession.js';

export interface SessionEndedPanelProps {
  files: TrackedFile[];
  notes: TrackedNote[];
  onDone: () => void;
}

/**
 * Where a joiner lands when the other device ended the session on purpose
 * *and* this tab is still the only place some received files exist.
 *
 * Every other case skips this and goes straight to the landing page — being
 * left on the link of a session that is over is the thing this whole path
 * exists to stop. The exception is the in-memory save tier (Safari, and
 * anywhere the streaming tier is unavailable), where a received file lives
 * as a Blob in this document and the Save link in the record below is the
 * only copy there will ever be. Navigating away from that revokes the object
 * URL and destroys files the user was never told they still had to save.
 *
 * So the record is re-shown rather than a bare "the session ended", and
 * leaving is the user's own click. No QR: unlike `PeerLeftPanel`, there is
 * nothing here to scan back into.
 */
export function SessionEndedPanel({ files, notes, onDone }: SessionEndedPanelProps) {
  return (
    <section
      aria-labelledby="session-ended-heading"
      className="mx-auto w-full max-w-3xl flex flex-1 flex-col justify-center gap-6 py-8"
    >
      <div className="flex flex-col items-center gap-3 text-center">
        <h1 id="session-ended-heading" className="text-2xl font-semibold">
          The other device ended the session
        </h1>
        <p className="max-w-md text-pretty text-[var(--color-text-muted)]">
          Anything below is still held in this tab only. Save what you want to keep before you leave
          — closing this page discards it.
        </p>
      </div>

      {/* Display-only: there is nothing left to cancel, and no peer to tell. */}
      <TransferRecord files={files} notes={notes} />

      <div className="flex justify-center">
        <Button icon={<IconCheck />} onClick={onDone}>Done</Button>
      </div>
    </section>
  );
}

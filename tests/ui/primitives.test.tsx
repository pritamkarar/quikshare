// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Button } from '../../client/ui/Button.js';
import { Badge } from '../../client/ui/Badge.js';
import { IconDirect, IconRelay } from '../../client/ui/icons.js';
import { ProgressBar } from '../../client/ui/ProgressBar.js';
import { CodeInput } from '../../client/ui/CodeInput.js';
import { formatBytes } from '../../client/ui/format.js';

describe('Button', () => {
  it('keeps its label while loading', () => {
    render(<Button loading>Send</Button>);
    expect(screen.getByRole('button', { name: /send/i })).toBeInTheDocument();
  });

  it('marks itself busy for assistive tech while loading', () => {
    render(<Button loading>Send</Button>);
    expect(screen.getByRole('button')).toHaveAttribute('aria-busy', 'true');
  });

  it('fires on click', async () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Go</Button>);
    await userEvent.click(screen.getByRole('button'));
    expect(onClick).toHaveBeenCalled();
  });

  it('is reachable and activatable by keyboard', async () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Go</Button>);
    await userEvent.tab();
    await userEvent.keyboard('{Enter}');
    expect(onClick).toHaveBeenCalled();
  });
});

describe('Badge', () => {
  it('conveys status with text, not color alone', () => {
    render(<Badge tone="relayed" icon={<IconRelay />} label="Relayed" />);
    expect(screen.getByText('Relayed')).toBeInTheDocument();
  });

  it('hides the decorative icon from assistive tech', () => {
    const { container } = render(<Badge tone="live" icon={<IconDirect />} label="Direct" />);
    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();
    expect(svg).toHaveAttribute('aria-hidden', 'true');
  });

  /*
   * These icons used to be Unicode arrows ('⇄' / '↔') passed as strings.
   * Font glyphs fall back unpredictably across platforms, ignore the stroke
   * weight of the UI around them, and cannot be sized or coloured as
   * artwork — so the badge must draw real vector geometry, not type.
   */
  it('draws vector artwork rather than a text glyph', () => {
    const { container } = render(<Badge tone="live" icon={<IconDirect />} label="Direct" />);
    expect(container.querySelector('svg path')).not.toBeNull();
    expect(container.textContent).toBe('Direct');
  });

  // Widened with a className prop rather than forked, same as CodeInput's
  // aria-label/placeholder and Button's own className: a second badge
  // component for one-off layout needs (e.g. `shrink-0` in a tight row) is
  // exactly the kind of drift this avoids.
  it('accepts a className for per-instance layout instead of forking the component', () => {
    render(<Badge tone="live" icon="✓" label="Sent" className="shrink-0" />);
    expect(screen.getByText('Sent').parentElement).toHaveClass('shrink-0');
  });
});

describe('ProgressBar', () => {
  it('exposes progressbar semantics', () => {
    render(<ProgressBar value={50} max={100} label="Sending a.bin" />);
    const bar = screen.getByRole('progressbar', { name: /sending a\.bin/i });
    expect(bar).toHaveAttribute('aria-valuenow', '50');
  });

  // aria-valuenow/max are raw byte counts, so a screen reader was announcing
  // "2147483648 of 4294967296". aria-valuetext takes precedence and says the
  // same thing the sighted user reads one element over.
  //
  // Asserted against formatBytes rather than the literal "512 B of 1 KB":
  // ProgressBar formats through the browser's locale (deliberately — that is
  // the product behaviour), so a literal digit here would make this test pass
  // on a latin-numeral machine and fail under, say, LC_ALL=ar_EG.UTF-8, where
  // it renders \u0665\u0661\u0662. The digits are the locale's business; the
  // wiring is this test's.
  it('announces sizes as text rather than reciting raw byte counts', () => {
    render(<ProgressBar value={512} max={1024} label="Receiving a.bin" />);
    const bar = screen.getByRole('progressbar');

    expect(bar).toHaveAttribute('aria-valuetext', `${formatBytes(512)} of ${formatBytes(1024)}`);
    // …and that really is different from the raw count it replaced.
    expect(bar.getAttribute('aria-valuetext')).not.toBe(bar.getAttribute('aria-valuenow'));
  });

  it('animates transform rather than width', () => {
    const { container } = render(<ProgressBar value={25} max={100} label="x" />);
    const fill = container.querySelector('[data-progress-fill]');
    expect(fill).toHaveStyle({ transform: 'scaleX(0.25)' });
  });

  it('clamps a value beyond the maximum', () => {
    render(<ProgressBar value={500} max={100} label="x" />);
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100');
  });

  // Widened with a className prop rather than forked — see Badge's identical
  // addition just above.
  it('accepts a className for per-instance layout instead of forking the component', () => {
    render(<ProgressBar value={50} max={100} label="x" className="mt-1.5" />);
    expect(screen.getByRole('progressbar')).toHaveClass('mt-1.5');
  });
});

describe('CodeInput', () => {
  it('normalizes a pasted, dashed, lowercase code', async () => {
    const onChange = vi.fn();
    render(<CodeInput value="" onChange={onChange} onSubmit={vi.fn()} />);
    await userEvent.type(screen.getByRole('textbox'), 'k7m-3qp');
    expect(onChange).toHaveBeenLastCalledWith('K7M3QP');
  });

  it('disables spellcheck and autocorrect for a code', () => {
    render(<CodeInput value="" onChange={vi.fn()} onSubmit={vi.fn()} />);
    const input = screen.getByRole('textbox');
    expect(input).toHaveAttribute('spellcheck', 'false');
    expect(input).toHaveAttribute('autocapitalize', 'characters');
  });

  it('submits on Enter once the code is complete', async () => {
    const onSubmit = vi.fn();
    render(<CodeInput value="K7M3QP" onChange={vi.fn()} onSubmit={onSubmit} />);
    await userEvent.type(screen.getByRole('textbox'), '{Enter}');
    expect(onSubmit).toHaveBeenCalledWith('K7M3QP');
  });

  it('does not submit an incomplete code', async () => {
    const onSubmit = vi.fn();
    render(<CodeInput value="K7M" onChange={vi.fn()} onSubmit={onSubmit} />);
    await userEvent.type(screen.getByRole('textbox'), '{Enter}');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  // …but "does not submit" is not the same as "does nothing", which is what
  // this used to do: no message, no announcement, no focus move, at the exact
  // moment a user who mistyped is retrying. AGENTS.md requires an incomplete
  // submission to surface validation inline, tied to the field.
  it('says why an incomplete code was not submitted, and ties it to the field', async () => {
    render(<CodeInput value="K7M" onChange={vi.fn()} onSubmit={vi.fn()} />);
    const input = screen.getByRole('textbox');

    await userEvent.type(input, '{Enter}');

    const message = screen.getByText(/six characters/i);
    expect(input).toHaveAttribute('aria-describedby', message.id);
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(message).toHaveAttribute('aria-live', 'polite');
  });

  it('clears the validation message as soon as the code is being corrected', async () => {
    render(<CodeInput value="K7M" onChange={vi.fn()} onSubmit={vi.fn()} />);
    const input = screen.getByRole('textbox');
    await userEvent.type(input, '{Enter}');
    expect(screen.getByText(/six characters/i)).toBeInTheDocument();

    await userEvent.type(input, '3');

    expect(screen.queryByText(/six characters/i)).not.toBeInTheDocument();
    expect(input).not.toHaveAttribute('aria-invalid');
  });

  it('defaults to the plain "Session code" label and example placeholder', () => {
    render(<CodeInput value="" onChange={vi.fn()} onSubmit={vi.fn()} />);
    const input = screen.getByLabelText('Session code');
    expect(input).toHaveAttribute('placeholder', 'K7M3QP');
  });

  // Addition 2: widened with props rather than forked, so a screen that
  // needs different copy (e.g. one that also accepts a pasted link) has
  // somewhere to put it without a second, driftable implementation.
  it('accepts an overridden aria-label and placeholder instead of forking the component', () => {
    render(
      <CodeInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        ariaLabel="Session code or pasted link"
        placeholder="ABC123"
      />,
    );
    const input = screen.getByLabelText('Session code or pasted link');
    expect(input).toHaveAttribute('placeholder', 'ABC123');
  });

  it('is not focused by default, but can be asked to focus on mount', () => {
    const { unmount } = render(<CodeInput value="" onChange={vi.fn()} onSubmit={vi.fn()} />);
    expect(screen.getByRole('textbox')).not.toHaveFocus();
    unmount();

    render(<CodeInput value="" onChange={vi.fn()} onSubmit={vi.fn()} autoFocus />);
    expect(screen.getByRole('textbox')).toHaveFocus();
  });

  // A pasted full share link must not be silently truncated by maxLength={9},
  // and reusing parseRoute (rather than a second, driftable parser) is what
  // lets this recognize the exact shape the router accepts.
  it('extracts the code from a pasted share link, submitting immediately', () => {
    const onChange = vi.fn();
    const onSubmit = vi.fn();
    render(<CodeInput value="" onChange={onChange} onSubmit={onSubmit} />);
    const input = screen.getByRole('textbox');

    const notCancelled = pasteInto(input, 'https://host.example/s/K7M3QP');

    expect(notCancelled).toBe(false); // handled ourselves, not left to native paste
    expect(onChange).toHaveBeenCalledWith('K7M3QP');
    expect(onSubmit).toHaveBeenCalledWith('K7M3QP');
  });

  it('extracts the code from an older link that still has a key fragment on it', () => {
    const onSubmit = vi.fn();
    render(<CodeInput value="" onChange={vi.fn()} onSubmit={onSubmit} />);
    const input = screen.getByRole('textbox');

    pasteInto(input, `https://host.example/s/K7M3QP#${'a'.repeat(43)}`);

    expect(onSubmit.mock.calls[0]).toEqual(['K7M3QP']);
  });

  it('leaves a plain pasted code to the normal paste-and-normalize path', () => {
    const onChange = vi.fn();
    const onSubmit = vi.fn();
    render(<CodeInput value="" onChange={onChange} onSubmit={onSubmit} />);
    const input = screen.getByRole('textbox');

    const notCancelled = pasteInto(input, 'k7m-3qp');

    expect(notCancelled).toBe(true); // not a URL — native paste proceeds
    expect(onChange).not.toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('does not treat an unrelated absolute URL as a share link', () => {
    const onSubmit = vi.fn();
    render(<CodeInput value="" onChange={vi.fn()} onSubmit={onSubmit} />);
    const input = screen.getByRole('textbox');

    const notCancelled = pasteInto(input, 'https://host.example/');

    expect(notCancelled).toBe(true);
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

/**
 * jsdom implements no default action for `paste` (no built-in text
 * insertion), so this only needs to deliver `clipboardData` and report
 * whether the handler cancelled the event — exactly what these tests check.
 */
function pasteInto(element: Element, text: string): boolean {
  const event = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent;
  Object.defineProperty(event, 'clipboardData', { value: { getData: () => text } });
  return element.dispatchEvent(event);
}

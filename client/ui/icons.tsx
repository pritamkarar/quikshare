import type { SVGProps } from 'react';

/*
 * One icon family, hand-inlined.
 *
 * Outline geometry on a 24x24 grid, 1.5 stroke, round caps and joins, drawn
 * in `currentColor` so every icon inherits the colour of the text it sits
 * beside and needs no per-theme variant. Paths follow the Heroicons outline
 * set (MIT) so the whole set shares one optical weight rather than being
 * drawn ad hoc.
 *
 * Inlined rather than pulled from a package: the app needs a dozen-odd icons,
 * and a dependency for a dozen paths is more supply chain and more build
 * surface than it saves. If this grows past ~20, swap it for `lucide-react`
 * wholesale instead of letting the two coexist.
 *
 * Decorative by default. Every icon here sits next to a real text label, so
 * `aria-hidden` is set and the label alone carries the meaning — a screen
 * reader should hear the word once, not a glyph description and then the
 * word. An icon that ever becomes the *only* content needs a label from its
 * caller instead.
 */

export type IconProps = SVGProps<SVGSVGElement>;

function Icon({ children, ...rest }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      // Sized by the caller's font-size unless overridden, so an icon beside
      // text scales with it instead of drifting out of proportion.
      width="1em"
      height="1em"
      {...rest}
    >
      {children}
    </svg>
  );
}

/** Bidirectional: the direct peer-to-peer path, nothing in between. */
export function IconDirect(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M7.5 21 3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5" />
    </Icon>
  );
}

/** A hop in the middle: the relayed path, travelling through the server. */
export function IconRelay(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="9" y="9" width="6" height="6" rx="1.75" />
      <path d="M3 12h6m6 0h6" />
      <path d="M5.5 9.75 3 12l2.5 2.25M18.5 9.75 21 12l-2.5 2.25" />
    </Icon>
  );
}

/** No account: the link itself is the credential. */
export function IconKey(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M15.75 5.25a3 3 0 0 1 3 3m3 0a6 6 0 0 1-7.029 5.912c-.563-.097-1.159.026-1.563.43L10.5 17.25H8.25v2.25H6v2.25H2.25v-2.818c0-.597.237-1.17.659-1.591l6.499-6.499c.404-.404.527-1 .43-1.563A6 6 0 1 1 21.75 8.25Z" />
    </Icon>
  );
}

/**
 * End-to-end encryption. Shield-and-check rather than shield-and-padlock: a
 * padlock nested inside a shield turns to mush at the 20px this renders at,
 * where a check still reads.
 */
export function IconShield(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 3.25 4.75 6.35v4.9c0 4.3 2.95 7.5 7.25 9.05 4.3-1.55 7.25-4.75 7.25-9.05v-4.9Z" />
      <path d="m9.5 11.75 1.85 1.85 3.4-3.7" />
    </Icon>
  );
}

/** No practical size limit: it streams rather than buffering. */
export function IconExpand(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3.75 8.25v-4.5h4.5M3.75 3.75 9 9M3.75 15.75v4.5h4.5m-4.5 0L9 15M20.25 8.25v-4.5h-4.5m4.5 0L15 9m5.25 6.75v4.5h-4.5m4.5 0L15 15" />
    </Icon>
  );
}

/** Choosing files. */
export function IconUpload(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5" />
      <path d="M16.5 7.5 12 3 7.5 7.5M12 3v13.5" />
    </Icon>
  );
}

/** Nothing has moved yet. */
export function IconInbox(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M2.25 13.5h3.86a2.25 2.25 0 0 1 2.012 1.244l.256.512a2.25 2.25 0 0 0 2.013 1.244h3.218a2.25 2.25 0 0 0 2.013-1.244l.256-.512a2.25 2.25 0 0 1 2.013-1.244h3.859" />
      <path d="M2.25 13.838V18a2.25 2.25 0 0 0 2.25 2.25h15A2.25 2.25 0 0 0 21.75 18v-4.162c0-.224-.034-.447-.1-.661L19.24 5.338a2.25 2.25 0 0 0-2.15-1.588H6.911a2.25 2.25 0 0 0-2.15 1.588L2.35 13.177a2.25 2.25 0 0 0-.1.661Z" />
    </Icon>
  );
}

/** A folder on this device — where received files can be written directly. */
export function IconFolder(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M2.25 12.75V12A2.25 2.25 0 0 1 4.5 9.75h15A2.25 2.25 0 0 1 21.75 12v.75" />
      <path d="m13.06 6.31-2.12-2.12a1.5 1.5 0 0 0-1.061-.44H4.5A2.25 2.25 0 0 0 2.25 6v12a2.25 2.25 0 0 0 2.25 2.25h15A2.25 2.25 0 0 0 21.75 18V9a2.25 2.25 0 0 0-2.25-2.25h-5.379a1.5 1.5 0 0 1-1.06-.44Z" />
    </Icon>
  );
}

/** Swap to the camera pointing the other way. Two arrows around a lens. */
export function IconFlip(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 15.75a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" />
      <path d="M3.75 12.75a8.25 8.25 0 0 0 13.5 6.36" />
      <path d="M20.25 11.25a8.25 8.25 0 0 0-13.5-6.36" />
      <path d="M2.25 15.75h3v-3M21.75 8.25h-3v3" />
    </Icon>
  );
}

/** The camera lamp, lit. */
export function IconFlash(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3.75 13.5 13.5 2.25v7.5h6.75L10.5 21.75v-7.5H3.75Z" />
    </Icon>
  );
}

/** The camera lamp, off — the same bolt, struck through. */
export function IconFlashOff(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3.75 13.5 13.5 2.25v7.5h6.75L10.5 21.75v-7.5H3.75Z" />
      <path d="M3 3l18 18" />
    </Icon>
  );
}

/** Something went wrong and there is a way forward. */
export function IconAlert(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 9v3.75m0 3h.007v.008H12V15.75Z" />
      <path d="M10.05 3.378c.866-1.5 3.032-1.5 3.898 0l7.303 12.748c.866 1.5-.217 3.374-1.948 3.374H4.697c-1.731 0-2.814-1.874-1.949-3.374Z" />
    </Icon>
  );
}

/** A file finished moving. */
/** "There is more to say about this" — the affordance on the transport badge. */
export function IconInfo(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 16.5v-5.25" />
      <path d="M12 8.25h.008v.008H12z" strokeWidth={2} />
    </Icon>
  );
}

export function IconCheck(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m4.5 12.75 6 6 9-13.5" strokeWidth={2} />
    </Icon>
  );
}

/** Scanning to pair. */
export function IconQr(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="3.75" y="3.75" width="6" height="6" rx="1.25" />
      <rect x="14.25" y="3.75" width="6" height="6" rx="1.25" />
      <rect x="3.75" y="14.25" width="6" height="6" rx="1.25" />
      <path d="M14.25 14.25h2.25v2.25h-2.25zM20.25 20.25H18v-2.25m2.25 2.25v-2.25" />
    </Icon>
  );
}

/**
 * A phone, for a device card. The three device glyphs below are drawn on the
 * same 24x24 grid at deliberately different aspect ratios — tall and narrow,
 * squat and wide, in between — so the *silhouette* distinguishes them at
 * 16px, where a screen-size difference alone would not read. Each still sits
 * beside a written "Mobile"/"Tablet"/"Desktop" label; the shape is the
 * redundant cue, never the only one.
 */
export function IconMobile(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="7.5" y="2.25" width="9" height="19.5" rx="2" />
      <path d="M10.5 18.75h3" />
    </Icon>
  );
}

/** A tablet: the same body, wider, with the home indicator on the short edge. */
export function IconTablet(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="4.5" y="2.25" width="15" height="19.5" rx="2" />
      <path d="M10.5 18.75h3" />
    </Icon>
  );
}

/** A laptop or desktop: a landscape screen standing on a base. */
export function IconDesktop(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="2.25" y="4.5" width="19.5" height="12" rx="2" />
      <path d="M1.5 19.5h21" />
    </Icon>
  );
}

/** Neither confirmed nor guessable — a device that did not say what it is. */
export function IconUnknownDevice(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="4.5" y="3" width="15" height="18" rx="2" />
      <path d="M10.125 9.75a1.875 1.875 0 1 1 2.53 1.757c-.63.236-1.03.83-1.03 1.503v.24" />
      <path d="M11.625 16.5h.008" />
    </Icon>
  );
}

/** Starting something new: a fresh session. */
export function IconPlus(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 4.5v15m7.5-7.5h-15" />
    </Icon>
  );
}

/** Joining by link rather than by scan. */
export function IconLink(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M13.19 8.688a4.5 4.5 0 0 1 1.242 7.244l-4.5 4.5a4.5 4.5 0 0 1-6.364-6.364l1.757-1.757" />
      <path d="M10.81 15.312a4.5 4.5 0 0 1-1.242-7.244l4.5-4.5a4.5 4.5 0 0 1 6.364 6.364l-1.757 1.757" />
    </Icon>
  );
}

/** Copying to the clipboard. Two offset sheets, which reads at 20px where a
    clipboard-and-page does not. */
export function IconCopy(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M16.5 8.25V6a2.25 2.25 0 0 0-2.25-2.25H6A2.25 2.25 0 0 0 3.75 6v8.25A2.25 2.25 0 0 0 6 16.5h2.25" />
      <rect x="8.25" y="8.25" width="12" height="12" rx="2.25" />
    </Icon>
  );
}

/** Sharing a live camera. A video camera, not a stills camera: what this
    starts is a stream, and IconQr already covers "point a lens at a code". */
export function IconCamera(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m15.75 10.5 4.72-4.72a.75.75 0 0 1 1.28.53v11.38a.75.75 0 0 1-1.28.53l-4.72-4.72" />
      <rect x="2.25" y="5.25" width="13.5" height="13.5" rx="2.25" />
    </Icon>
  );
}

/** Sending a note. */
export function IconSend(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M6 12 3.269 3.125A59.769 59.769 0 0 1 21.485 12 59.768 59.768 0 0 1 3.27 20.875L5.999 12Zm0 0h7.5" />
    </Icon>
  );
}

/** The microphone is open. */
export function IconMic(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 18.75a6 6 0 0 0 6-6v-1.5m-6 7.5a6 6 0 0 1-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5" />
      <path d="M12 15.75a3 3 0 0 1-3-3V4.5a3 3 0 1 1 6 0v8.25a3 3 0 0 1-3 3Z" />
    </Icon>
  );
}

/**
 * The microphone is muted. The struck-through variant, not a second unrelated
 * glyph: mute and unmute are one control in two states, and a slash is the
 * one convention every user already reads that way.
 */
export function IconMicOff(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 18.75a6 6 0 0 0 6-6v-1.5m-6 7.5a6 6 0 0 1-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5" />
      <path d="M12 15.75a3 3 0 0 1-3-3V4.5a3 3 0 1 1 6 0v8.25a3 3 0 0 1-3 3Z" />
      <path d="M3.75 3.75 20.25 20.25" strokeWidth={2} />
    </Icon>
  );
}

/** Ending a live stream. A filled-weight square is the universal stop. */
export function IconStop(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="5.25" y="5.25" width="13.5" height="13.5" rx="2.25" />
    </Icon>
  );
}

/** Abandoning an attempt that has not finished. */
export function IconClose(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M6 18 18 6M6 6l12 12" />
    </Icon>
  );
}

/** Leaving the session. */
export function IconExit(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M15.75 9V5.25A2.25 2.25 0 0 0 13.5 3h-6a2.25 2.25 0 0 0-2.25 2.25v13.5A2.25 2.25 0 0 0 7.5 21h6a2.25 2.25 0 0 0 2.25-2.25V15" />
      <path d="M12 9l3 3m0 0-3 3m3-3H2.25" />
    </Icon>
  );
}

/** Saving a received file to disk. The mirror of IconUpload. */
export function IconDownload(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5" />
      <path d="M7.5 12 12 16.5 16.5 12M12 3v13.5" />
    </Icon>
  );
}

/** Everything in the record, unfiltered. */
export function IconList(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5" />
    </Icon>
  );
}

/** Filtering to what this device sent. */
export function IconArrowUpRight(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4.5 19.5 19.5 4.5M9 4.5h10.5V15" />
    </Icon>
  );
}

/** Filtering to what this device received. */
export function IconArrowDownLeft(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M19.5 4.5 4.5 19.5M15 19.5H4.5V9" />
    </Icon>
  );
}

/**
 * The GitHub mark, in the header. Solid rather than outlined — it is a
 * trademark with one correct shape, and redrawing it in this set's 1.5-stroke
 * outline style would make it something other than the GitHub logo. `fill`
 * and `stroke` are overridden on the element for that reason.
 */
export function IconGitHub(props: IconProps) {
  return (
    <Icon fill="currentColor" stroke="none" viewBox="0 0 16 16" {...props}>
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.42 7.42 0 0 1 2-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </Icon>
  );
}

/** Light theme, in the theme toggle. */
export function IconSun(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 3v2.25m6.364.386-1.591 1.591M21 12h-2.25m-.386 6.364-1.591-1.591M12 18.75V21m-4.773-4.227-1.591 1.591M5.25 12H3m4.227-4.773L5.636 5.636M15.75 12a3.75 3.75 0 1 1-7.5 0 3.75 3.75 0 0 1 7.5 0Z" />
    </Icon>
  );
}

/** Dark theme, in the theme toggle. */
export function IconMoon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M21.752 15.002A9.72 9.72 0 0 1 18 15.75c-5.385 0-9.75-4.365-9.75-9.75 0-1.33.266-2.597.748-3.752A9.753 9.753 0 0 0 3 11.25C3 16.635 7.365 21 12.75 21a9.753 9.753 0 0 0 9.002-5.998Z" />
    </Icon>
  );
}

/** Nothing is kept: the session is gone when the tab is. */
export function IconClock(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 6v6h4.5m4.5 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
    </Icon>
  );
}

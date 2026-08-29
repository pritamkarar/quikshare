import { describe, expect, it } from 'vitest';
import { cleanText, formatIp, parseDeviceInfo } from '../../shared/device.js';

/*
 * The peer's self-description is attacker-controlled text that this app
 * renders next to labels a user will read as facts. `parseDeviceInfo` is the
 * only boundary between the two, so it gets the same treatment the other
 * untrusted parsers in this repo do.
 */
describe('parseDeviceInfo', () => {
  it('keeps a well-formed description intact', () => {
    expect(parseDeviceInfo({
      id: 'a1b2-c3d4-e5f6',
      kind: 'mobile',
      os: 'Android',
      browser: 'Chrome',
      ip: '203.0.113.7',
      screen: '390 × 844',
    })).toEqual({
      id: 'a1b2-c3d4-e5f6',
      kind: 'mobile',
      os: 'Android',
      browser: 'Chrome',
      ip: '203.0.113.7',
      screen: '390 × 844',
    });
  });

  /*
   * The one that actually matters. U+202E flips rendering direction for
   * everything after it, so a peer could otherwise paint arbitrary text
   * across the label beside its own value -- a spoof that survives every
   * amount of CSS care in the component. Written as escapes here for the
   * same reason format.ts writes its non-breaking space as one: the raw
   * characters are invisible in an editor and in a diff.
   */
  it('strips bidi overrides and other format characters', () => {
    const info = parseDeviceInfo({ id: 'x', browser: '‮Chrome‬', os: 'Lin​ux' });
    expect(info?.browser).toBe('Chrome');
    expect(info?.os).toBe('Lin ux');
  });

  it('collapses newlines rather than letting a value span rows', () => {
    expect(parseDeviceInfo({ id: 'x', os: 'Windows\nSomething Else' })?.os)
      .toBe('Windows Something Else');
  });

  it('clamps a field long enough to push the panel around', () => {
    const info = parseDeviceInfo({ id: 'x', browser: 'B'.repeat(5000) });
    expect(info?.browser.length).toBe(48);
  });

  it('falls back to "unknown" for a kind it does not recognise', () => {
    expect(parseDeviceInfo({ id: 'x', kind: 'toaster' })?.kind).toBe('unknown');
    expect(parseDeviceInfo({ id: 'x', kind: 7 })?.kind).toBe('unknown');
  });

  /*
   * Dropped whole rather than half-rendered: with no id there is nothing to
   * tell this device apart from any other, which is the card's whole point.
   */
  it('rejects a description with no usable id', () => {
    expect(parseDeviceInfo({ kind: 'mobile', os: 'Android' })).toBeUndefined();
    expect(parseDeviceInfo({ id: '   ' })).toBeUndefined();
    expect(parseDeviceInfo({ id: 42 })).toBeUndefined();
  });

  it('rejects anything that is not an object', () => {
    expect(parseDeviceInfo(null)).toBeUndefined();
    expect(parseDeviceInfo('a1b2')).toBeUndefined();
    expect(parseDeviceInfo(undefined)).toBeUndefined();
  });

  /*
   * Absent, not empty. The panel renders an absent field as "Not available"
   * in muted text; an empty string would render as a blank row that reads
   * like a rendering bug.
   */
  it('leaves an unusable optional field absent rather than blank', () => {
    const info = parseDeviceInfo({ id: 'x', ip: '', screen: '​' });
    expect(info?.ip).toBeUndefined();
    expect(info?.screen).toBeUndefined();
  });
});

describe('cleanText', () => {
  it('returns undefined for a non-string', () => {
    expect(cleanText(12)).toBeUndefined();
    expect(cleanText(undefined)).toBeUndefined();
  });

  it('trims and collapses runs of whitespace', () => {
    expect(cleanText('  Samsung   Internet  ')).toBe('Samsung Internet');
  });
});

describe('formatIp', () => {
  /*
   * What Node hands back for a v4 client on a dual-stack listener -- i.e. the
   * most ordinary deployment there is, and a prefix that is noise to anyone
   * not debugging a socket.
   */
  it('unwraps the IPv4-mapped IPv6 form', () => {
    expect(formatIp('::ffff:203.0.113.7')).toBe('203.0.113.7');
  });

  it('leaves a real IPv6 address alone', () => {
    expect(formatIp('2001:db8::1')).toBe('2001:db8::1');
  });

  it('leaves a plain IPv4 address alone', () => {
    expect(formatIp('192.0.2.10')).toBe('192.0.2.10');
  });
});

import type { ComponentType } from 'react';
import type { DeviceKind } from '../../shared/device.js';
import {
  IconDesktop, IconMobile, IconTablet, IconUnknownDevice, type IconProps,
} from './icons.js';

export interface DeviceKindCopy {
  icon: ComponentType<IconProps>;
  label: string;
}

/**
 * The glyph and the word for each device kind, in one table.
 *
 * Lifted out of DevicePanel the moment SessionHeader started drawing the
 * same two devices at the top of the session: a phone has to be the same
 * glyph and the same noun in both places, and two private copies of this
 * map is exactly how "Phone" up top becomes "Mobile" down below.
 */
export const DEVICE_KIND: Record<DeviceKind, DeviceKindCopy> = {
  mobile: { icon: IconMobile, label: 'Phone' },
  tablet: { icon: IconTablet, label: 'Tablet' },
  desktop: { icon: IconDesktop, label: 'Computer' },
  unknown: { icon: IconUnknownDevice, label: 'Unknown' },
};

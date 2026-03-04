'use client';

import { CSSProperties } from 'react';
import useReducedMotion from './useReducedMotion';
import { MOTION_PRESETS, MotionPresetKey } from './motion-tokens';

export default function useMotionPreset(key: Exclude<MotionPresetKey, 'none'> = 'normal', properties = 'all') {
  const reduced = useReducedMotion();

  if (reduced) {
    return {
      reduced,
      style: { transition: 'none' } as CSSProperties,
    };
  }

  const preset = MOTION_PRESETS[key];
  return {
    reduced,
    style: {
      transitionProperty: properties,
      transitionDuration: `${preset.durationMs}ms`,
      transitionTimingFunction: preset.easing,
    } as CSSProperties,
  };
}

export type MotionPresetKey = 'none' | 'quick' | 'normal' | 'emphasized';

export interface MotionPreset {
  durationMs: number;
  easing: string;
}

export const MOTION_PRESETS: Record<Exclude<MotionPresetKey, 'none'>, MotionPreset> = {
  quick: { durationMs: 140, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' },
  normal: { durationMs: 220, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' },
  emphasized: { durationMs: 320, easing: 'cubic-bezier(0.2, 0, 0, 1)' },
};

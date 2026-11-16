// Small pure helpers shared across modules (no DOM / no Three.js).

export function round2(v) {
  return Math.round(v * 100) / 100;
}

export function hexToNum(hex) {
  return parseInt(String(hex).replace('#', ''), 16) || 0;
}

export function colorHex(color) {
  return '#' + color.toString(16).padStart(6, '0');
}

export const clampv = (v, lo, hi) => Math.max(lo, Math.min(v, hi));

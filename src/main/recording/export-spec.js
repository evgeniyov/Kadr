'use strict';
const plan = require('../../renderer/recorder/shared/export-plan.mjs');
function sanitizeSpec(spec = {}) {
  const f = plan.FORMATS[spec.format] ? spec.format : 'mp4';
  const rect = (r) => (r && r.width > 0 && r.height > 0 ? { x: Math.max(0, Math.round(r.x || 0)), y: Math.max(0, Math.round(r.y || 0)), width: Math.round(r.width), height: Math.round(r.height) } : null);
  return {
    format: f,
    trim: spec.trim && Number.isFinite(spec.trim.start) && Number.isFinite(spec.trim.end) ? { start: spec.trim.start, end: spec.trim.end } : null,
    crop: rect(spec.crop),
    size: spec.size && spec.size.width >= 2 && spec.size.height >= 2 ? { width: plan.even(spec.size.width), height: plan.even(spec.size.height) } : null,
    fps: plan.FPS_OPTIONS.includes(spec.fps) ? spec.fps : null,
    quality: plan.QUALITIES.includes(spec.quality) ? spec.quality : 'high',
    mute: !!spec.mute,
    audioTrack: Number.isInteger(spec.audioTrack) && spec.audioTrack >= 0 ? spec.audioTrack : 0,
    speed: plan.SPEEDS.includes(spec.speed) ? spec.speed : 1,
    precise: !!spec.precise,
  };
}

module.exports = { sanitizeSpec };

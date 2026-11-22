// Object type registry. Objects are plain JSON-able data ({ id, type, color, size, opacity, k, ... });
// behaviour lives in the type modules so documents can be snapshotted with structuredClone.
import arrow from './arrow.js';
import { rect, oval, line } from './shapes.js';
import { text, counter } from './text.js';
import { freehand, highlighter } from './stroke.js';
import { conceal, spotlight, magnifier } from './effects.js';
import { ruler, image } from './misc.js';

export const TYPES = { arrow, rect, oval, line, text, counter, freehand, highlighter, conceal, spotlight, magnifier, ruler, image };

export const typeOf = (o) => TYPES[o?.type];

let seq = 0;
export const newObjectId = () => `o${Date.now().toString(36)}${(seq++).toString(36)}`;

// Build a new object of `type` at (x,y) from the current tool properties.
export function createObject(type, props, x, y) {
  const T = TYPES[type];
  const base = {
    id: newObjectId(),
    type,
    color: props.color,
    size: props.size,
    opacity: props.opacity ?? 1,
    shadow: props.shadow ?? true,
    k: props.k || 1,
  };
  return Object.assign(base, T.create(props, x, y));
}

export function bounds(o, env) {
  return typeOf(o).bounds(o, env);
}

export function hit(o, x, y, tol, env) {
  return typeOf(o).hit(o, x, y, tol, env);
}

export function handles(o, env) {
  return typeOf(o).handles?.(o, env) || [];
}

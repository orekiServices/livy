/**
 * The Automix renderer registry. Livy intentionally supports exactly one
 * transition shape: a crossfade. The registration functions remain as a
 * migration surface for plugins, but new effect renderers are rejected.
 */
export const EFFECT_RENDERERS = Object.freeze({
  crossfade(ctx: any) {
    const { a, b, left, right, fade, total, gainFor } = ctx
    for (let i = 0; i < total; i += 1) {
      const [ga, gb] = gainFor(i / Math.max(1, fade))
      left[i] = (a.left[i] ?? 0) * ga + (b.left[i] ?? 0) * gb
      right[i] = (a.right[i] ?? 0) * ga + (b.right[i] ?? 0) * gb
    }
  }
})

/**
 * Kept so existing plugins fail clearly instead of silently installing a
 * transition that Automix will never use.
 */
export function registerEffect(name: string, _renderer: unknown) {
  const id = String(name ?? '').trim().toLowerCase()
  if (id === 'crossfade') throw new Error('"crossfade" is Livy’s built-in transition and cannot be replaced')
  if (!/^[a-z0-9][a-z0-9-]{1,23}$/.test(id)) throw new Error(`Invalid effect name "${name}"`)
  if (typeof _renderer !== 'function') throw new Error('A transition needs a renderer function')
  throw new Error('Automix supports crossfade only; plugin transition renderers are no longer supported')
}

/** Plugin unload compatibility: the one built-in transition is immutable. */
export function unregisterEffect(_name: string) {
  return false
}

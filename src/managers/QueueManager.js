/**
 * Livy's own queue.
 *
 * FastLink's built-in queue stores only encoded track strings and its
 * loop handling is buggy in 2.4.1 (loop=track replays the *next* track,
 * loop=queue duplicates the wrong entry). Livy therefore runs FastLink
 * with `queue: false` and owns queueing itself, keeping rich metadata
 * (title, requester, duration) alongside each encoded track.
 *
 * Invariant: `tracks[0]` is the currently playing track whenever
 * `current` is set; `tracks` holds only upcoming tracks.
 */
export const LOOP_MODES = ['off', 'track', 'queue'];

export class QueueManager {
  constructor() {
    /** @type {Array<object>} upcoming tracks (metadata + encoded) */
    this.tracks = [];
    /** @type {object|null} currently playing track */
    this.current = null;
    this.loopMode = 'off';
  }

  get size() {
    return this.tracks.length + (this.current ? 1 : 0);
  }

  get isEmpty() {
    return this.size === 0;
  }

  /** Add one track. Returns its 1-based position in the full queue. */
  add(track) {
    this.tracks.push(track);
    return this.size;
  }

  addMany(tracks) {
    for (const track of tracks) this.tracks.push(track);
    return tracks.length;
  }

  /** Take the next upcoming track and make it current. */
  next() {
    this.current = this.tracks.shift() ?? null;
    return this.current;
  }

  /** Put the current track back at the front (used for loop=track). */
  replayCurrent() {
    return this.current;
  }

  /** Move current to the end and take the next one (loop=queue). */
  rotate() {
    if (this.current) this.tracks.push(this.current);
    return this.next();
  }

  /** Remove the track at a 1-based position (1 = now playing). */
  removeAt(position) {
    if (position === 1) return null; // now-playing is removed via skip()
    const index = position - 2;
    if (index < 0 || index >= this.tracks.length) return undefined;
    return this.tracks.splice(index, 1)[0];
  }

  clear() {
    this.tracks = [];
    this.current = null;
  }

  clearUpcoming() {
    this.tracks = [];
  }

  shuffle() {
    for (let i = this.tracks.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [this.tracks[i], this.tracks[j]] = [this.tracks[j], this.tracks[i]];
    }
    return this.tracks;
  }

  setLoop(mode) {
    if (!LOOP_MODES.includes(mode)) throw new Error(`Loop mode must be one of: ${LOOP_MODES.join(', ')}`);
    this.loopMode = mode;
    return this.loopMode;
  }

  /** Full ordered list for display: [current, ...upcoming]. */
  all() {
    return this.current ? [this.current, ...this.tracks] : [...this.tracks];
  }
}

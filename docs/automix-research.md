# Automix research — Apple Music AutoMix and the open-source field

*Notes behind the redesign: what "automix" means when a streaming service ships
it, what the open-source projects actually do, and which ideas Livy adopted —
and which it deliberately did not.*

---

## 1. Apple Music AutoMix

AutoMix arrived with iOS 26 and is **on by default**. Apple's description is
short and precise:

> "AutoMix ... mixes one song into the next, just like a DJ. Using AI to
> analyze audio features, it crafts unique transitions between songs with time
> stretching and beat matching to deliver continuous playback and an even more
> seamless listening experience."
> — Apple, as quoted by [9to5Mac](https://9to5mac.com/2025/06/16/automix-apple-music-ios-26/)

The observable behaviour, from reviewers and listeners:

| Observation | Source |
|---|---|
| Enabled by default; the setting is **Settings → Apps → Music → Song Transitions**, with AutoMix / crossfade / off | [9to5Mac](https://9to5mac.com/2025/06/16/automix-apple-music-ios-26/), [podcastvideos](https://www.podcastvideos.com/articles/apple-music-automix-ai-dj-style-mixing-ios26/) |
| Beat matching **and time stretching** are the core, not a volume fade | [9to5Mac](https://9to5mac.com/2025/06/16/automix-apple-music-ios-26/) |
| A "Mixing" animation appears during the blend | [podcastvideos](https://www.podcastvideos.com/articles/apple-music-automix-ai-dj-style-mixing-ios26/) |
| Not an Apple Intelligence feature — it runs on every device that can run iOS 26 | [9to5Mac](https://9to5mac.com/2025/06/16/automix-apple-music-ios-26/) |
| It is aggressive: reviewers heard tracks at 0.75× / 1.5× and some awkward handovers | [Yahoo Tech](https://tech.yahoo.com/audio/articles/tried-apple-musics-dj-feature-153000036.html) |
| Works best on clear-groove material; can be confused by complex endings or big genre/tempo jumps | [podcastvideos](https://www.podcastvideos.com/articles/apple-music-automix-ai-dj-style-mixing-ios26/) |

### What that means for a radio node

1. **Default on, explainable, switchable.** Livy already defaults
   `automix.effect` to `auto` and `automix.model` to `true`; the console now
   exposes the switch per station *and* node-wide.
2. **Beatmatch with a ceiling.** Apple was criticised for obvious pitch/tempo
   shifts. Livy caps the stretch (`maxStretchPercent`, 12 % by default), folds
   half/double-time before stretching, and only renders the seam — the rest of
   the incoming song plays at its native tempo.
3. **A learned choice, not a learned renderer.** Apple's model decides how to
   mix. Livy's policy ranks ten *already safe* transitions per seam; it cannot
   invent a transition the heuristic's pool forbids. That is the difference
   between a model that can sound wrong live and one that can only sound
   different.
4. **Fast enough to stay on air.** Apple does this on-device. Livy trains a
   few-hundred-parameter policy in tens of milliseconds and runs the heavy DSP in Rust
   (MetroS), so training is a background job, never a station restart.

---

## 2. Open-source automix projects

Searched on GitHub for beat-matched automix / DJ transition engines:

| Project | Approach | Useful idea |
|---|---|---|
| [`clawd139/automix`](https://github.com/clawd139/automix) | Neural DJ transition generation: Demucs stems, conditional diffusion predicting EQ/filter/gain curves, differentiable effects chain | The **learned effect curves** idea; also "one-command pipeline" UX |
| [`WalterByte-afk/BeatBridge`](https://github.com/WalterByte-afk/BeatBridge) | Real-time YouTube Music extension: downbeat snapping, Camelot key matching, vocal ducking, four transition modes | **Vocal ducking/key context** and the explicit comparison table against Apple AutoMix |
| [`kingmitten/mini-dj-automix`](https://github.com/kingmitten/mini-dj-automix) | Browser editor plus a five-stage pipeline: downbeats, Camelot key, sub-bass density, VAD, vocal-collision avoidance; 11 transition presets | **Vocal collision avoidance** bounds the mix length; **presets map to musical context** |
| [`vedantexists/redmix`](https://github.com/vedantexists/redmix) | Offline PWA: beat/bar alignment, ±6 % tempo ramp returning to native, equal-power bass swap, Camelot ordering | **Tempo returns to native after the blend**; **bar-aligned bass swap** |
| [danger.academy AutoMix](https://danger.academy/AutoMix/) | Commercial-adjacent open-source DJ tool: stem separation, harmonic/tempo locking | Framing: automix as "one-click transition generation" |

Common architecture across all of them:

```
analyse (BPM, beats/downbeats, key, loudness, vocals/stems)
  → plan (which transition, how long, where to cut)
  → render (EQ/filter/gain curves, time-stretch, ducking)
  → join (edge smoothing, peak ceiling)
```

Livy implements the same four stages without ffmpeg or stems: `analysis.js` does
beat/phase, loudness, correlation and vocal-band activity; `chooseEffect`
plans; the ten renderers render; `smoothEdges` joins. The new model replaces
only the **plan** stage, and only as a ranker.

What Livy deliberately does **not** copy:

- **Diffusion/stem models on the live path.** A radio node must render a seam
  in tens of milliseconds without a GPU. The policy is microscopic by design.
- **Always-on dramatic mixing.** Reviewers disliked AutoMix calling attention to
  itself. Livy's model must clear a margin over the heuristic, and the
  heuristic still gates the pool. `varyEffects` avoids the same trick twice.
- **A hosted service dependency.** Models can be *stored* on Hugging Face, but
  inference is local and offline; a dead network never silences a station.

---

## 3. How the model is trained (and why multi-train)

Each seam logs its features, the transition used, and the listener's reaction
(completed vs skipped within the attribution window). That is a tiny labelled
dataset — a few hundred rows per station-month.

`trainModels()`:

1. Reads seams from MetroDB (`dj_seams`) or the JSONL tail as a fallback.
2. Splits chronologically, so the held-out set is *future* seams.
3. Trains **N candidates** with different widths/seeds (fast: `[16,12]`,
   `[20,14]`, …), optionally warm-starting from the incumbent.
4. Picks by held-out accuracy → loss → parameter count.
5. Saves **every** candidate; activates the winner only if it beats the
   incumbent. Losers remain inspectable and activatable by hand.
6. Records the run in `dj_training_runs` and pushes the winner to the private
   HF repo when one is configured.

The default is fast, multi and **on**: poll every 60 s, train after 60 new
seams, two candidates, small nets, CPU with a WebGPU path when present. The
station keeps playing throughout — the trainer yields every few epochs and the
activated model is picked up at the next seam.

### What was added for v3.10

- **Vocal-aware length.** AutoMix fades a lyric line rather than cutting it;
  with no stems, Livy detects vocal-band activity in the first 1.8 s of each
  side *before* choosing the blend length. Both sides singing contracts the
  blend to ~70 % (the lines hand over), one side to ~90 %. The later curve
  shaping still uses the phrase boundary.
- **Vocal-aware choice.** A clash penalises bass-swap, drop, roll and slam,
  which leave both voices exposed, and rewards filter/echo, which mask one.
- **Grid honesty.** Roll and drop require an *unmatched* tempo gap below 5 and
  7 BPM respectively; a folded match already reconciled the grids and is
  allowed regardless of the raw tag difference.
- **Folded matches count.** Bass-swap is no longer refused just because the
  BPM tags differ by more than 3 after a successful ±4 % fold.
- **Android budget.** A phone trains one 12-unit candidate for 26 epochs on
  the 1,200 most recent seams, yields every 4 epochs, and skips the WebGPU
  probe. The seam still decides the same way; only the learning budget changed.

---

## 4. Private storage on Hugging Face

- The repo is created with `private: true`; every upload re-checks visibility
  and refuses a public repo. A public DJ policy would leak listener behaviour.
- The token (`HF_TOKEN` / `LIVY_HF_TOKEN`) lives only in the node's
  environment. It is never returned by an API and never written to SQLite.
- Models are ordinary files (`*.bin`), so the Hub is a dump-and-restore, not a
  runtime dependency.

## Sources

- [9to5Mac — iOS 26 adds AutoMix](https://9to5mac.com/2025/06/16/automix-apple-music-ios-26/)
- [podcastvideos — Apple Music AutoMix explained](https://www.podcastvideos.com/articles/apple-music-automix-ai-dj-style-mixing-ios26/)
- [Yahoo Tech — hands-on with AutoMix](https://tech.yahoo.com/audio/articles/tried-apple-musics-dj-feature-153000036.html)
- [clawd139/automix](https://github.com/clawd139/automix) · [BeatBridge](https://github.com/WalterByte-afk/BeatBridge) · [mini-dj-automix](https://github.com/kingmitten/mini-dj-automix) · [redmix](https://github.com/vedantexists/redmix)

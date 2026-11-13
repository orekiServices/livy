# DJ models

A DJ model is a small learned policy that picks the transition at each seam —
which of `crossfade`, `bass-swap`, `filter`, `echo`, `sweep`, `spindown`,
`slam`, `wash`, `roll` or `drop` fits the two songs meeting there.

This directory holds the ones that ship with a release. Weights trained on a
running node are written to the writable data directory (`server/data/models`
on a normal install, `/tmp/livy/data/models` on Vercel) and shadow a file of
the same name here, because a trained model is *state*, not part of the code.

## Nothing here is required

With no model, `chooseEffect()` decides using the heuristics it always has. A
missing directory, a corrupt file, a file trained on a different feature set —
each is a warning in the log and a fall back to those heuristics. A model can
never stop a station.

## The file

`<name>.bin` — a versioned, self-describing binary. `src/core/models/format.js`
has the layout in full; the short version is a `LVDJ` magic number, the feature
names in column order, then the layers, then a checksum. The feature names
travel with the model on purpose: a network fed the right numbers in the wrong
order still produces a confident answer, and there is no way to notice from the
outside.

## `manifest.json`

Names the active file. The trainer writes it atomically, so a node reloading
between seams sees either the old model or the new one.

## Switching models

- `LIVY_DJ_MODEL=/path/to/model.bin` pins one file, overriding the manifest.
- `GET/POST /api/v1/owner/stations/:id/dj-model` inspects, reloads, or turns the
  model off for a station (`{ "enabled": false }` leaves the heuristic in
  charge).
- `POST /api/v1/owner/stations/:id/dj-model/train` trains from the station's
  own seam history and activates the result only if it beats the incumbent on
  a held-out split.

## Training

The station logs every transition — the features it saw, the effect it chose,
and whether the track then played out or was skipped. That log is the training
set. `trainModel()` runs in a second or two on a few hundred seams, on the CPU;
`LIVY_GPU=1` and a WebGPU adapter move the forward pass to the GPU, which is
only worth it for a much larger model than this one. The report records the
held-out accuracy before and after, so "did it get better?" is answered by the
run rather than assumed.

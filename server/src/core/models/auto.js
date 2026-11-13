/**
 * Training while the station is on air.
 *
 * A timer, not a job queue: every minute it asks one indexed question — "are
 * there enough new seams to be worth another model?" — and usually answers no.
 * When the answer is yes it runs a fast multi-train in the background, which
 * yields between epochs, and the active policy is swapped at the next seam.
 * Nothing here can stop a station: every failure lands in `state().error`.
 */
import createLogger from '../../util/logger.js'
import { modelSettings } from './settings.js'
import { trainModels } from './trainer/index.js'
import { seamCount } from './trainer/dataset.js'
import { hfConfig, hfReady } from './storage/hf.js'
import { pushModels } from './registry.js'

const log = createLogger('dj-auto')

export class AutoTrainer {
  constructor({ manager = null, store = null, config = {}, log: logger = log } = {}) {
    this.manager = manager
    this.store = store
    this.config = config
    this.log = logger
    this.running = false
    this.timer = null
    this.lastSeams = 0
    this.lastRunAt = 0
    this.lastResult = null
    this.error = null
  }

  get enabled() {
    return modelSettings().enabled !== false && modelSettings().autoTrain !== false
  }

  start() {
    if (!this.enabled || this.timer) return this.state()
    // Prime with what already exists so a restart does not immediately retrain
    // on a log the previous process already learned from.
    this.lastSeams = seamCount({ store: this.store })
    const interval = Math.max(10_000, Number(modelSettings().pollMs) || 60_000)
    this.timer = setInterval(() => {
      this.tick().catch((error) => {
        this.error = error.message
        this.log.warn(`auto-train: ${error.message}`)
      })
    }, interval)
    this.timer.unref?.()
    this.log.info(`auto-train on · every ${Math.round(interval / 1000)}s · ${modelSettings().everySeams} new seams (${modelSettings().preset ?? 'auto'} · ${modelSettings().candidates} candidate${modelSettings().candidates === 1 ? '' : 's'})`)
    return this.state()
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    return this.state()
  }

  /** Run one check, or force a run regardless of thresholds. */
  async tick({ force = false } = {}) {
    if (!this.enabled && !force) return { skipped: 'disabled' }
    if (this.running) return { skipped: 'already running' }

    const settings = modelSettings()
    const seams = seamCount({ store: this.store })
    if (!force && seams < settings.minSeams) return { skipped: `only ${seams} seams (${settings.minSeams} needed)` }
    if (!force && seams - this.lastSeams < settings.everySeams) {
      return { skipped: `waiting for ${settings.everySeams} new seams (${seams - this.lastSeams})` }
    }

    this.running = true
    this.error = null
    const started = Date.now()
    try {
      const report = await trainModels({
        store: this.store,
        count: settings.fast ? settings.candidates : Math.max(2, settings.candidates),
        fast: settings.fast !== false,
        epochs: Number(settings.epochs) || 0,
        activate: settings.activate !== false,
        saveDir: settings.saveDir || null,
        warm: true,
        gpu: 'auto'
      })

      this.lastSeams = seams
      this.lastRunAt = Date.now()
      this.lastResult = report
      if (report.trained) {
        this.store?.saveTrainingRun?.({
          stationId: null,
          mode: report.mode,
          count: report.count,
          backend: report.backend,
          trained: true,
          accuracy: report.accuracyAfter,
          best: report.best?.name ?? null,
          report
        })

        // Mirror the winner to the private repo when the owner asked for it.
        const cfg = hfConfig()
        if (hfReady(cfg) && report.best?.name) {
          try {
            const pushed = await pushModels({ names: [report.best.name], store: this.store, cfg })
            report.pushed = pushed.pushed
          } catch (error) {
            this.log.warn(`auto-train push: ${error.message}`)
            report.pushError = error.message
          }
        }
      } else {
        this.store?.saveTrainingRun?.({
          stationId: null,
          mode: report.mode ?? 'auto',
          count: report.count ?? 0,
          backend: null,
          trained: false,
          accuracy: null,
          best: null,
          report
        })
      }
      this.log.info(`auto-train finished in ${Date.now() - started} ms: ${report.trained ? `${report.accuracyAfter} held-out` : report.reason}`)
      this.manager?.emit?.('models', { report })
      return report
    } catch (error) {
      this.error = error.message
      this.log.warn(`auto-train failed: ${error.message}`)
      return { trained: false, reason: error.message }
    } finally {
      this.running = false
    }
  }

  state() {
    const settings = modelSettings()
    return {
      enabled: this.enabled,
      running: this.running,
      pollMs: settings.pollMs,
      everySeams: settings.everySeams,
      minSeams: settings.minSeams,
      candidates: settings.candidates,
      fast: settings.fast,
      preset: settings.preset ?? 'auto',
      seams: seamCount({ store: this.store }),
      lastSeams: this.lastSeams,
      lastRunAt: this.lastRunAt,
      last: this.lastResult
        ? {
            trained: this.lastResult.trained,
            accuracyAfter: this.lastResult.accuracyAfter,
            activated: this.lastResult.activated,
            best: this.lastResult.best?.name ?? null,
            ms: this.lastResult.ms
          }
        : null,
      error: this.error
    }
  }
}

export default AutoTrainer

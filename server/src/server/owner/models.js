/**
 * Owner routes for the learned automix policy.
 *
 * Station-scoped: the switch, the last decision, an explanation, and a train
 * run. Node-scoped (`/owner/models`): every candidate, activation, deletion,
 * the private Hugging Face mirror, and the auto-train switches.
 */
import createLogger from '../../util/logger.js'
import {
  activateModel,
  forgetModel,
  hfConfig,
  hubStatus,
  modelSettings,
  models,
  pullModels,
  pushModels,
  registryState,
  trainModels,
  updateModelSettings
} from '../../core/models/index.js'

const log = createLogger('owner-models')

/* ---------------------------- station routes ---------------------------- */

export async function stationModels({ req, res, method, action, target, store, readJson, send, fail, autoTrainer }) {
  if (method === 'GET') {
    const seam = target.automix?.last ?? {}
    return send(res, 200, {
      ...models.detail(),
      enabled: target.automix?.options?.model !== false,
      last: target.automix?.last?.decision ?? null,
      explain: models.explain(seam),
      auto: autoTrainer?.state?.() ?? null,
      registry: (await registryState({ store, cfg: hfConfig() })).models
    })
  }

  if (method === 'POST' || method === 'PATCH') {
    const body = await readJson(req).catch(() => ({}))
    if (body.enabled !== undefined) {
      target.setAutomix({ model: Boolean(body.enabled) })
      store?.saveStation({ ...target.options, id: target.id, name: target.name, playlists: target.playlists })
    }
    if (body.action === 'reload') models.reload()
    return send(res, 200, { ...models.info(), enabled: target.automix?.options?.model !== false })
  }

  if (method === 'DELETE') {
    target.setAutomix({ model: false })
    store?.saveStation({ ...target.options, id: target.id, name: target.name, playlists: target.playlists })
    return send(res, 200, { enabled: false })
  }

  return fail(res, 405, 'Method not allowed')
}

/* ----------------------------- training run ----------------------------- */

export async function trainForStation({ req = null, res, target = null, stationId = null, store, readJson, send, fail }) {
  const body = await readJson(req).catch(() => ({})).then((value) => value ?? {})
  const owner = stationId ?? target?.id ?? body.station ?? null
  const count = Math.max(1, Math.min(8, Number(body.count) || (body.multi ? 3 : 1)))
  const fast = body.fast !== false
  const report = await trainModels({
    store,
    station: owner,
    count,
    fast,
    epochs: body.epochs ? Math.max(10, Math.min(4000, Number(body.epochs))) : 0,
    learningRate: body.learningRate ? Math.max(0.0001, Math.min(0.5, Number(body.learningRate))) : 0.01,
    gpu: body.gpu === true ? true : body.gpu === false ? false : 'auto',
    activate: body.activate !== false,
    warm: body.warm !== false
  })
  if (report.trained) {
    store?.saveTrainingRun?.({
      stationId: owner,
      mode: report.mode,
      count: report.count,
      backend: report.backend,
      trained: true,
      accuracy: report.accuracyAfter,
      best: report.best?.name ?? null,
      report
    })
    log.info(`trained on "${owner ?? 'node'}": ${report.accuracyAfter} held-out (${report.count} candidate${report.count === 1 ? '' : 's'})`)
  }
  return send(res, report.trained ? 200 : 409, report)
}

/* ------------------------------ node routes ----------------------------- */

export async function modelRoutes({ req, res, url, method, id, action, store, readJson, send, fail, autoTrainer }) {
  const cfg = hfConfig()

  if (!id) {
    if (method !== 'GET') return fail(res, 405, 'Method not allowed')
    return send(res, 200, {
      ...(await registryState({ store, cfg })),
      settings: modelSettings(),
      auto: autoTrainer?.state?.() ?? null,
      enabled: modelSettings().enabled !== false
    })
  }

  if (id === 'hf') {
    if (method === 'GET') return send(res, 200, await hubStatus(cfg))
    if (method === 'POST') {
      const body = await readJson(req)
      const settings = updateModelSettings({ hf: { ...modelSettings().hf, ...body } })
      configureAutoTrainer(autoTrainer)
      return send(res, 200, { settings: settings.hf, status: await hubStatus(hfConfig()) })
    }
    return fail(res, 405, 'Method not allowed')
  }

  if (id === 'settings') {
    if (method === 'GET') return send(res, 200, modelSettings())
    if (method !== 'PATCH' && method !== 'POST') return fail(res, 405, 'Method not allowed')
    const body = await readJson(req)
    const settings = updateModelSettings({
      autoTrain: body.autoTrain ?? body.enabled ?? modelSettings().autoTrain,
      fast: body.fast ?? modelSettings().fast,
      candidates: body.candidates ? Math.max(1, Math.min(8, Number(body.candidates))) : modelSettings().candidates,
      minSeams: body.minSeams ? Math.max(12, Number(body.minSeams)) : modelSettings().minSeams,
      everySeams: body.everySeams ? Math.max(10, Number(body.everySeams)) : modelSettings().everySeams,
      pollMs: body.pollMs ? Math.max(10_000, Number(body.pollMs)) : modelSettings().pollMs,
      ...(body.hf ? { hf: { ...modelSettings().hf, ...body.hf } } : {})
    })
    configureAutoTrainer(autoTrainer)
    return send(res, 200, settings)
  }

  if (id === 'train') {
    if (method !== 'POST') return fail(res, 405, 'Method not allowed')
    const body = await readJson(req)
    return trainForStation({ res, stationId: body.station ?? null, store, readJson: async () => body, send, fail })
  }

  if (id === 'push') {
    if (method !== 'POST') return fail(res, 405, 'Method not allowed')
    const body = await readJson(req).catch(() => ({}))
    try {
      return send(res, 200, await pushModels({ names: body.names ?? (body.name ? [body.name] : null), store, cfg }))
    } catch (error) {
      return fail(res, error.status ?? 502, error.message)
    }
  }

  if (id === 'pull') {
    if (method !== 'POST') return fail(res, 405, 'Method not allowed')
    const body = await readJson(req).catch(() => ({}))
    try {
      const pulled = await pullModels({ names: body.names ?? (body.name ? [body.name] : null), store, cfg, activate: body.activate === true })
      return send(res, 200, { ...pulled, registry: (await registryState({ store, cfg })).models })
    } catch (error) {
      return fail(res, error.status ?? 502, error.message)
    }
  }

  if (id === 'auto') {
    if (method === 'POST' || method === 'PATCH') {
      const body = await readJson(req)
      const settings = updateModelSettings({ autoTrain: body.enabled !== false })
      configureAutoTrainer(autoTrainer)
      return send(res, 200, { settings, state: autoTrainer?.state?.() ?? null })
    }
    if (method === 'GET') return send(res, 200, autoTrainer?.state?.() ?? { enabled: false })
    if (method === 'DELETE') return send(res, 200, { report: await autoTrainer?.tick({ force: true }) })
  }

  // Everything left is `/models/:name` or `/models/:name/activate`.
  const name = decodeURIComponent(id)
  if (action === 'activate' && (method === 'POST' || method === 'PUT')) {
    try {
      return send(res, 200, activateModel(name, { store }))
    } catch (error) {
      return fail(res, error.status ?? 400, error.message)
    }
  }

  if (method === 'DELETE') {
    try {
      return send(res, 200, forgetModel(name, { store }))
    } catch (error) {
      return fail(res, error.status ?? 400, error.message)
    }
  }

  if (method === 'GET') {
    const info = models.info()
    return send(res, 200, { model: info.available.find((entry) => entry.name === name) ?? null, active: info.model })
  }

  return fail(res, 404, 'Unknown model route')
}

/** Re-evaluate the timer after the owner changed a switch. */
function configureAutoTrainer(autoTrainer) {
  if (!autoTrainer) return
  if (modelSettings().enabled !== false && modelSettings().autoTrain !== false) autoTrainer.start()
  else autoTrainer.stop()
}

export default modelRoutes

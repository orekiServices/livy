/**
 * Where this node is running, in the terms the scheduler and the trainer care
 * about: desktop/server, or a phone in Termux.
 *
 * The check is deliberately cheap and environment-only. It runs at boot and
 * on every model settings read, so it must not shell out to `uname` or probe
 * the filesystem.
 */
import os from 'node:os'

const ANDROID_HINTS = /android|termux/i

export function hostInfo(env = process.env, { platform = process.platform, cpus = os.cpus().length, totalMem = os.totalmem() }: any = {}) {
  const prefix = String(env.PREFIX ?? '')
  const termux = Boolean(env.TERMUX_VERSION) || prefix.includes('com.termux') || Boolean(env.LIVY_TERMUX)
  const override = String(env.LIVY_PLATFORM ?? env.LIVY_DEVICE_PROFILE ?? '')
  const android = platform === 'android' || termux || ANDROID_HINTS.test(override)
  const forcedServer = /server|desktop/i.test(override)
  const memoryMb = Math.round(totalMem / 1024 / 1024)
  // Android is the real signal. A small VPS is not a phone: two cores with a
  // few GB of RAM trains the tiny policy comfortably, and pretending it is
  // mobile would silently shrink a desktop deployment. Only a genuinely tiny
  // box (< 1.2 GB) takes the mobile budget without an Android platform.
  const mobile = forcedServer ? false : android || memoryMb < 1200
  return {
    platform,
    android,
    termux,
    mobile,
    profile: mobile ? 'android' : 'server',
    cpus,
    memoryMb,
    // WebGPU is not reachable from Termux's Node, and even if it were, the
    // transfer cost is larger than this model.
    gpu: !mobile
  }
}

export const isMobileHost = (env = process.env) => hostInfo(env).mobile

/**
 * Static Loader config schema.
 *
 * The DSH 0.2.x settings page projects a plugin's exported `Config` schema
 * (namespace = profile entry id). A third-party plugin loaded from a profile
 * symlink cannot resolve @deepseek-ai/* by bare import, so the schema is built
 * with the host's own schemastery instance anchored inside the DSH install.
 * On hosts or test runners where that anchor is unavailable, Config stays
 * undefined and the plugin keeps its built-in defaults.
 */

import { createRequire } from 'node:module'
import { join } from 'node:path'

function buildConfig() {
  const installDir = process.env.DSH_INSTALL_DIR
  if (typeof installDir !== 'string' || installDir === '') return undefined
  try {
    const requireFromHost = createRequire(join(installDir, 'package.json'))
    const z = requireFromHost('@deepseek-ai/schemastery')
    if (z === undefined || typeof z.object !== 'function') return undefined
    const vol = schema => (typeof schema.volatile === 'function' ? schema.volatile() : schema)
    return z.object({
      targetTools: vol(z.string().default('read-only').description(
        "Tool tier for the target turn: 'read-only' limits it to read/search tools; 'full' keeps its native tools.",
      )),
      defaultTimeoutMs: vol(z.number().default(120_000).description(
        'Default wait budget for session_ask, in milliseconds.',
      )),
      maxTimeoutMs: vol(z.number().default(600_000).description(
        'Hard cap for one ask and for background delivery, in milliseconds.',
      )),
      maxHops: vol(z.number().default(3).description(
        'Maximum sessions in one cross-session ask chain, including the caller.',
      )),
      pendingTtlMs: vol(z.number().default(3_600_000).description(
        'How long an unanswered ticket stays deliverable, in milliseconds.',
      )),
    })
  } catch {
    return undefined
  }
}

/** Loader-projected schema for Settings → Plugins; undefined when unavailable. */
export const Config = buildConfig()

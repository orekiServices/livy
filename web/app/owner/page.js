'use client'

/**
 * The owner desk.
 *
 * The console used to have a single `/owner` page; the redesign split it into
 * a view per job. This page stays because it is the URL people bookmark, and
 * because a first-time owner needs one place that says where everything is.
 */
import Link from 'next/link'

import { useRadio } from '../../components/RadioProvider.js'
import { Badge, Button, KeyGate, PageHeading, Panel } from '../../components/ui.js'

const DESKS = [
  { href: '/stations/', title: 'Stations', line: 'Start, stop, skip, shuffle, and create a station from a provider string.' },
  { href: '/station/', title: 'Station', line: 'Queue, requests, announcements, automix and the policy on air.' },
  { href: '/seams/', title: 'Seams & Forever', line: 'What the scout hears, the jukebox graph, RL and Forever mode.' },
  { href: '/filters/', title: 'Radio filters', line: 'The live DSP rack: EQ, eighteen units, presets.' },
  { href: '/models/', title: 'Training', line: 'PyTorch or JavaScript, presets, the run report and the registry.' },
  { href: '/ops/', title: 'Node', line: 'Owner password, plugins, process stats and the log.' }
]

export default function OwnerPage() {
  const { key, ownerName, forgetKey, info } = useRadio()
  return (
    <div className="space-y-4">
      <PageHeading
        eyebrow="Credential"
        title="Owner desk"
        subtitle={key && ownerName ? `Signed in as ${ownerName}.` : 'Enter the node’s owner key to change anything.'}
      />

      <Panel title="Where everything is" subtitle="One view per job, all behind the same key." padded={false}>
        <ul className="divide-y divide-ink-700/60">
          {DESKS.map((desk) => (
            <li key={desk.href} className="flex flex-wrap items-center gap-2 px-4 py-2.5">
              <span className="min-w-0 flex-1">
                <Link href={desk.href} className="text-sm text-ink-100 hover:text-amber">
                  {desk.title}
                </Link>
                <span className="mt-0.5 block text-xs text-ink-300">{desk.line}</span>
              </span>
              <Link href={desk.href}>
                <Button size="sm" variant="ghost">Open →</Button>
              </Link>
            </li>
          ))}
        </ul>
      </Panel>

      {!key ? (
        <KeyGate title="Unlock the node" />
      ) : (
        <KeyGate title="Unlock the node">
          <Panel title="Credential" subtitle="The key is stored in this tab only, never in a URL, never in the build.">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone="lime">{ownerName ?? 'owner'}</Badge>
              <span className="text-xs text-ink-300">
                {info?.setup?.protected ? 'this node needs the key for every write' : 'this node is in open mode'}
              </span>
              <Button size="sm" variant="ghost" className="ml-auto" onClick={forgetKey}>
                Forget key
              </Button>
            </div>
            <p className="mt-3 text-xs text-ink-300">
              Change the password, rescan plugins or read the log on the <Link href="/ops/" className="underline">Node</Link> page.
            </p>
          </Panel>
        </KeyGate>
      )}
    </div>
  )
}

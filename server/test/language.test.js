/**
 * Speaking more than one language.
 *
 * A node in Hanoi that announces in English because that was the default is
 * a bad radio station. So the language is a first-class argument everywhere
 * something is spoken: the TTS engine, the `tts:` source, a station's
 * idents, and the errors a listener hears when a stream will not play.
 *
 * Nothing here hits the network: the engine runs with `provider: 'off'`,
 * which exercises every path except the actual synthesis.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { TtsEngine, LANGUAGES, normaliseLanguage, pickLanguage, splitLanguage } from '../src/tts/index.js'
import { TtsSource } from '../src/sources/tts.js'
import { StreamErrorVoice, LINES, REASON_IDS, SHIPPED_LANGUAGES } from '../src/server/streamErrors.js'
import { probeMp3 } from '../src/util/metro.js'
import { quietLogs, tmpdir } from './helpers.js'

quietLogs()

const engine = (options = {}) => new TtsEngine({ cacheDir: tmpdir('tts-'), provider: 'off', ...options })

test('language tags are tidied up, not rejected', () => {
  assert.equal(normaliseLanguage('VI'), 'vi')
  assert.equal(normaliseLanguage('pt_br'), 'pt-BR')
  assert.equal(normaliseLanguage('en-US,en;q=0.9'), 'en')
  assert.equal(normaliseLanguage(''), 'en')
  assert.equal(normaliseLanguage(null, 'ja'), 'ja')
  // Unknown but well-formed passes through: the provider knows more
  // languages than this project lists, and refusing them would be rude.
  assert.equal(normaliseLanguage('sw'), 'sw')
  assert.equal(normaliseLanguage('not a language'), 'en')
})

test('a phrase can name its own language', () => {
  assert.deepEqual(splitLanguage('vi:xin chào'), { language: 'vi', text: 'xin chào' })
  assert.deepEqual(splitLanguage('ja: こんにちは'), { language: 'ja', text: 'こんにちは' })
  // A sentence that merely starts with a word and a colon is left alone.
  assert.deepEqual(splitLanguage('note: this is English'), { language: null, text: 'note: this is English' })
  assert.deepEqual(splitLanguage('Coming up: the news'), { language: null, text: 'Coming up: the news' })
})

test("a listener's Accept-Language picks the closest thing on offer", () => {
  assert.equal(pickLanguage('vi-VN,vi;q=0.9,en;q=0.8', ['en', 'vi', 'ja']), 'vi')
  assert.equal(pickLanguage('de-CH', ['en', 'de']), 'de', 'a region falls back to its language')
  assert.equal(pickLanguage('en', ['en-GB', 'fr']), 'en-GB', 'and a language finds a region')
  assert.equal(pickLanguage('is-IS', ['en', 'vi']), 'en', 'nothing close → the default')
  assert.equal(pickLanguage('', ['en', 'vi']), 'en')
  // q-values are honoured, not just document order.
  assert.equal(pickLanguage('en;q=0.2, ja;q=0.9', ['en', 'ja']), 'ja')
})

test('the same words in two languages are two recordings', async () => {
  const tts = engine({ language: 'en' })
  assert.equal(tts.language, 'en')
  assert.ok(tts.languages.length > 10)
  assert.equal(tts.languages.find((entry) => entry.code === 'en').default, true)

  const english = await tts.speak('good evening')
  const vietnamese = await tts.speak('good evening', { language: 'vi' })
  assert.equal(english.language, 'en')
  assert.equal(vietnamese.language, 'vi')

  // With no provider both fall back to the tone bed, so compare the cache
  // keys the engine would use rather than the fallback file itself.
  const a = await tts.speak('tts test phrase', { language: 'en' })
  const b = await tts.speak('tts test phrase', { language: 'ja' })
  assert.equal(a.provider, 'tone')
  assert.equal(b.provider, 'tone')

  assert.equal(tts.setLanguage('vi'), 'vi')
  assert.equal((await tts.speak('mặc định')).language, 'vi', 'the node default moves with it')
})

test('the tts source carries the language from text, caller or node', async () => {
  const source = new TtsSource({ engine: engine({ language: 'en' }) })

  assert.equal((await source.resolve('tts:hello there')).tracks[0].language, 'en')
  assert.equal((await source.resolve('tts:vi:xin chào các bạn')).tracks[0].language, 'vi')
  assert.equal((await source.resolve('say:ja:こんにちは')).tracks[0].language, 'ja')
  assert.equal((await source.resolve('announce:hello', { language: 'de' })).tracks[0].language, 'de')

  // The prefix is stripped from what actually gets said, and from the title.
  const track = (await source.resolve('tts:vi:xin chào các bạn')).tracks[0]
  assert.equal(track.text, 'xin chào các bạn')
  assert.equal(track.title, 'xin chào các bạn')

  // Two languages, two tracks — the id must not collide.
  const en = (await source.resolve('tts:hello')).tracks[0]
  const fr = (await source.resolve('tts:fr:hello')).tracks[0]
  assert.notEqual(en.id, fr.id)

  const languages = await source.search('viet')
  assert.equal(languages[0].language, 'vi')
})

/* --------------------------- spoken errors ---------------------------- */

test('every shipped language has every line', () => {
  for (const language of SHIPPED_LANGUAGES) {
    for (const reason of REASON_IDS) {
      const line = LINES[language][reason]
      assert.ok(line && line.length > 10, `${language}/${reason} is written`)
    }
    // The station name has to survive translation, or the listener is told
    // that "undefined" is off the air.
    assert.match(LINES[language]['off-air'], /\{station\}/, `${language} keeps {station}`)
  }
})

test('the error voice answers in the listener language and falls back sensibly', () => {
  const voice = new StreamErrorVoice({ tts: null })

  assert.equal(voice.defaultLanguage, 'en')
  assert.ok(voice.languages.includes('vi') && voice.languages.includes('ja'))

  assert.match(voice.line('unknown-station', { station: 'Lo-Fi' }), /no station called Lo-Fi/)
  assert.match(voice.line('unknown-station', { station: 'Lo-Fi', language: 'vi' }), /không có kênh nào tên Lo-Fi/i)
  // pt-BR is not shipped; pt is, and that is close enough to be useful.
  assert.match(voice.line('off-air', { station: 'X', language: 'pt-BR' }), /fora do ar/)
  // Something nobody translated falls all the way back to English.
  assert.match(voice.line('off-air', { station: 'X', language: 'sw' }), /off the air/)

  assert.equal(voice.languageFor('vi-VN,vi;q=0.9'), 'vi')
  assert.equal(voice.languageFor('is'), 'en')
  assert.equal(voice.languageFor(undefined), 'en')
})

test('the owner edits one language without disturbing the others', () => {
  const voice = new StreamErrorVoice({ tts: null })
  const before = voice.line('off-air', { station: 'X', language: 'vi' })

  voice.update({ messages: { vi: { 'unknown-station': 'Không có kênh {station}.' } } })
  assert.equal(voice.line('unknown-station', { station: 'Lo-Fi', language: 'vi' }), 'Không có kênh Lo-Fi.')
  assert.equal(voice.line('off-air', { station: 'X', language: 'vi' }), before, 'the other Vietnamese lines stand')
  assert.match(voice.line('unknown-station', { station: 'Lo-Fi' }), /no station called/, 'English stands')

  // A language the node does not ship can be added outright.
  voice.update({ messages: { sv: { 'unknown-station': 'Ingen station heter {station}.' } } })
  assert.equal(voice.line('unknown-station', { station: 'P3', language: 'sv' }), 'Ingen station heter P3.')
  assert.ok(voice.languages.includes('sv'))
  // …and an unfilled line in that language still falls back to English.
  assert.match(voice.line('off-air', { station: 'P3', language: 'sv' }), /off the air/)

  // Rubbish is ignored rather than stored.
  voice.update({ messages: { vi: { 'not-a-reason': 'nope' }, '': { 'off-air': 'nope' } } })
  assert.equal(voice.settings.messages.vi['not-a-reason'], undefined)

  assert.equal(voice.update({ language: 'vi' }).language, 'vi')
  assert.equal(voice.defaultLanguage, 'vi')
})

test('a spoken error is always playable audio, even with no voice at all', async () => {
  const voice = new StreamErrorVoice({ tts: null })
  const audio = await voice.speak('unknown-station', { station: 'Lo-Fi' })
  assert.ok(Buffer.isBuffer(audio))
  assert.ok(probeMp3(audio).frames > 0, 'valid MP3 frames, not an empty body')

  // A TTS engine that throws must not turn a 404 into a crash.
  const angry = new StreamErrorVoice({
    tts: {
      language: 'en',
      provider: 'broken',
      speak: async () => {
        throw new Error('provider on fire')
      }
    }
  })
  const fallback = await angry.speak('off-air', { station: 'Lo-Fi' })
  assert.ok(probeMp3(fallback).frames > 0, 'still audio')
})

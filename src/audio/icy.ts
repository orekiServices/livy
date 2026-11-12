/**
 * ICY (Shoutcast/Icecast) metadata helpers.
 *
 * ICY metadata is inserted into the audio stream every `icy-metaint`
 * bytes as: 1 length byte + length*16 bytes of "Key='Value';" text,
 * zero-padded. Players that request `Icy-MetaData: 1` parse it to show
 * the current track title.
 */

export function buildIcyBlock(title: string): Buffer {
  const text = `StreamTitle='${title.replace(/'/g, '')}';`;
  const padded = Buffer.alloc(Math.ceil(text.length / 16) * 16);
  padded.write(text, 0, 'utf8');
  const block = Buffer.alloc(1 + padded.length);
  block[0] = padded.length / 16;
  padded.copy(block, 1);
  return block;
}

/**
 * Wrap an audio chunk stream, inserting ICY metadata blocks at the
 * configured interval. Returns a Transform-like async generator.
 */
export async function* withIcyMetadata(
  source: AsyncIterable<Buffer>,
  metaInt: number,
  getTitle: () => string,
): AsyncGenerator<Buffer> {
  let sinceBlock = 0;
  for await (const chunk of source) {
    let offset = 0;
    while (offset < chunk.length) {
      const remaining = metaInt - sinceBlock;
      if (remaining <= 0) {
        yield buildIcyBlock(getTitle());
        sinceBlock = 0;
        continue;
      }
      const slice = chunk.subarray(offset, Math.min(offset + remaining, chunk.length));
      yield Buffer.from(slice);
      sinceBlock += slice.length;
      offset += slice.length;
      if (sinceBlock >= metaInt) {
        yield buildIcyBlock(getTitle());
        sinceBlock = 0;
      }
    }
  }
}

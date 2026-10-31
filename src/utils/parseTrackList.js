// ============================================================
// TRACK LIST PARSER
//
// Turns pasted text, or the contents of a .txt file, into a clean list of
// entries for /playlist. Each entry is later handed to resolveQuery(), so
// anything /play understands works: Spotify track/album/playlist links,
// YouTube/SoundCloud links, or plain "Artist - Title" searches.
//
// Accepted layouts:
//   - one entry per line
//   - several links on one line, separated by spaces or commas (some
//     clients collapse pasted line breaks into spaces)
//   - leading numbering/bullets are ignored: "1. ", "2) ", "- ", "* "
//   - blank lines are ignored
// ============================================================

const DEFAULT_MAX_ENTRIES = 500;

// Anything longer than this isn't a song title, it's pasted junk.
const DEFAULT_MAX_ENTRY_LENGTH = 300;

// A single token that is a link or a Spotify URI.
const LINK_OR_URI =
  /^(?:https?:\/\/\S+|spotify:(?:track|album|playlist):[A-Za-z0-9]+)$/i;

// "1. ", "12) ", "- ", "* ", "• " at the start of a line. Digits must be
// followed by "." or ")" and whitespace, so a song called "1999" or
// "7 Rings" is left alone.
const LIST_MARKER = /^(?:\d{1,4}[.)]|[-*•–])\s+/;

/**
 * Decodes the bytes of an uploaded text file. Handles UTF-8 (with or
 * without a BOM) and the UTF-16 LE that Windows Notepad's "Unicode" option
 * produces.
 *
 * @param {Buffer} buffer
 * @returns {string}
 */
function decodeTextFile(buffer) {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.toString('utf16le').replace(/^\uFEFF/, '');
  }

  return buffer.toString('utf8').replace(/^\uFEFF/, '');
}

/**
 * @param {string} raw
 * @param {object} [options]
 * @param {number} [options.maxEntries]
 * @param {number} [options.maxEntryLength]
 * @returns {{ entries: string[], truncated: boolean, ignored: number }}
 *   `truncated`: there were more entries than `maxEntries`.
 *   `ignored`: lines skipped for being implausibly long.
 */
function parseTrackList(
  raw,
  {
    maxEntries = DEFAULT_MAX_ENTRIES,
    maxEntryLength = DEFAULT_MAX_ENTRY_LENGTH,
  } = {}
) {
  const entries = [];
  let truncated = false;
  let ignored = 0;

  const add = (entry) => {
    if (entry.length > maxEntryLength) {
      ignored += 1;
      return;
    }

    if (entries.length >= maxEntries) {
      truncated = true;
      return;
    }

    entries.push(entry);
  };

  const lines = String(raw ?? '')
    .replace(/^\uFEFF/, '')
    .split(/\r\n|\r|\n/);

  for (const rawLine of lines) {
    const line = rawLine.trim().replace(LIST_MARKER, '').trim();

    if (!line) {
      continue;
    }

    // Several links on one line -> one entry per link. (Trailing commas
    // and semicolons from "link1, link2" are dropped.)
    const tokens = line
      .split(/\s+/)
      .map((token) => token.replace(/[,;]+$/, ''))
      .filter(Boolean);

    if (
      tokens.length > 1 &&
      tokens.every((token) => LINK_OR_URI.test(token))
    ) {
      tokens.forEach(add);
      continue;
    }

    add(line);
  }

  return { entries, truncated, ignored };
}

module.exports = {
  parseTrackList,
  decodeTextFile,
  DEFAULT_MAX_ENTRIES,
  DEFAULT_MAX_ENTRY_LENGTH,
};

'use strict';

/**
 * Child credential channel that preserves stdin.
 * 
 * AUD-001 fix: This matches the repository's existing internal process.argv
 * injection approach but removes the key from both the parent-to-child
 * environment and the OS process command line. File descriptor 3 is used
 * so the CLI's normal stdin remains unavailable/unchanged rather than
 * being consumed by the credential protocol.
 */

// Bootstrap script that reads the credential from fd 3 and injects it
// into process.argv before importing the mmx entry point.
const BOOTSTRAP = String.raw`
const fs = require('fs');
const { pathToFileURL } = require('url');
(async () => {
  let payload;
  try {
    const raw = fs.readFileSync(3, { encoding: 'utf8' });
    if (Buffer.byteLength(raw, 'utf8') > 65536) throw new Error('credential payload too large');
    payload = JSON.parse(raw);
    const key = payload && payload.apiKey;
    if (typeof key !== 'string' || key.length === 0 || key.length > 16384) {
      throw new Error('invalid credential payload');
    }
    const [entry, ...args] = process.argv.slice(1);
    if (!entry) throw new Error('missing mmx entry');
    process.argv = [process.execPath, entry, ...args, '--api-key', key];
    payload.apiKey = '';
    payload = null;
    await import(pathToFileURL(entry).href);
  } catch (error) {
    process.stderr.write('credential bootstrap failed\n');
    process.exitCode = 78;
  }
})();`;

/**
 * Prepare spawn arguments for the credential bridge.
 * @param {string} entry - Path to the mmx entry point
 * @param {string[]} args - Additional arguments
 * @returns {{argv: string[], stdio: string[]}} Spawn configuration
 * @throws {TypeError} If entry or args are invalid
 */
function prepare(entry, args) {
  if (typeof entry !== 'string' || !entry) throw new TypeError('entry is required');
  if (!Array.isArray(args)) throw new TypeError('args must be an array');
  return {
    argv: ['-e', BOOTSTRAP, entry, ...args],
    stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
  };
}

/**
 * Send the credential to the child process via fd 3.
 * @param {import('child_process').ChildProcess} proc - The spawned child process
 * @param {string} apiKey - The API key to send
 * @throws {Error} If the credential pipe is unavailable
 */
function sendCredential(proc, apiKey) {
  const pipe = proc && proc.stdio && proc.stdio[3];
  if (!pipe || typeof pipe.end !== 'function') throw new Error('credential pipe is unavailable');
  const payload = JSON.stringify({ apiKey });
  pipe.end(payload, 'utf8');
}

module.exports = { BOOTSTRAP, prepare, sendCredential };

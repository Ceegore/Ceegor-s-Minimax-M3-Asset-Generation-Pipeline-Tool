'use strict';

/**
 * Abortable delay and deadline composition utilities.
 * 
 * AUD-012 fix: Replicate must use combined signal with strict timeouts
 * for submit and poll requests, plus abortable polling delay.
 */

/**
 * Create a combined abort signal from a parent signal and a timeout.
 * @param {AbortSignal|null} parent - Optional parent signal
 * @param {number} timeoutMs - Timeout in milliseconds (must be positive)
 * @returns {AbortSignal} Combined signal that aborts on parent abort or timeout
 * @throws {TypeError} If timeoutMs is not positive
 */
function combinedSignal(parent, timeoutMs) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError('timeoutMs must be positive');
  }
  const timeout = AbortSignal.timeout(timeoutMs);
  return parent ? AbortSignal.any([parent, timeout]) : timeout;
}

/**
 * Create an abortable delay promise.
 * @param {number} ms - Delay in milliseconds
 * @param {AbortSignal} [signal] - Optional abort signal
 * @returns {Promise<void>} Resolves after delay, rejects on abort
 */
function abortableDelay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason || new DOMException('Aborted', 'AbortError'));
      return;
    }
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      fn(value);
    };
    const timer = setTimeout(() => finish(resolve), ms);
    timer.unref?.();
    const onAbort = () => finish(
      reject,
      signal.reason || new DOMException('Aborted', 'AbortError')
    );
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

module.exports = { combinedSignal, abortableDelay };

// main/ipc/inpaintTeleaWorker.js
// PE-022: Worker Thread for the Telea inpaint — offloads the CPU-heavy
// synthesis from the main process event loop (7.4 s at 1024² was blocking
// all IPC/window events). Receives {rgba, mask, w, h, radius} via
// workerData, runs inpaint(), and posts back the mutated rgba buffer.

'use strict';

const { parentPort, workerData } = require('worker_threads');
const { inpaint } = require('../../src/inpaint');

const { rgba, mask, w, h, radius } = workerData;
const rgbaBuf = new Uint8ClampedArray(rgba);
const maskBuf = new Uint8Array(mask);

inpaint(rgbaBuf, maskBuf, w, h, { radius });

// Transfer the mutated buffer back (zero-copy).
parentPort.postMessage({ rgba: rgbaBuf.buffer }, [rgbaBuf.buffer]);

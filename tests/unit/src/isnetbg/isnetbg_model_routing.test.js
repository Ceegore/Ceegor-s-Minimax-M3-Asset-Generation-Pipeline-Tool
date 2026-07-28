// tests/unit/src/isnetbg/isnetbg_model_routing.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const ISNETBG_PATH = path.join(ROOT, 'src', 'isnetbg.js');
const DISC_PATH = path.join(ROOT, 'src', 'isnetbg', 'binaryDiscovery.js');

function withMocks({ withBinary, withNodeModel, modelPresentKey }, fn) {
  delete require.cache[require.resolve(ISNETBG_PATH)];
  delete require.cache[require.resolve(DISC_PATH)];

  const Module = require('module');
  const origLoad = Module._load;
  const captured = { calls: [] };

  const cpMock = {
    spawn: (bin, args, opts) => {
      const call = { bin, args: [...args], opts: opts || {} };
      captured.calls.push(call);
      return {
        stderr: { on() {} },
        on(ev, fnClose) { if (ev === 'close') setImmediate(() => fnClose(0)); },
      };
    },
    spawnSync: (cmd) => {
      if (withBinary && (cmd === 'where' || cmd === 'which')) {
        return { status: 0, stdout: 'C:\\fake\\isnetbg.exe\n', stderr: '' };
      }
      return { status: 1, stdout: '', stderr: '' };
    },
  };

  const fsMock = {
    existsSync: (p) => {
      const sp = String(p);
      if (withBinary && /isnetbg\.exe$/.test(sp)) return true;
      if (withNodeModel) {
        if (modelPresentKey === 'isnet-general-use' && /models[\\/]isnet-general-use\.onnx$/.test(sp)) return true;
        if (modelPresentKey === 'birefnet-general-lite' && /models[\\/]birefnet-general-lite\.onnx$/.test(sp)) return true;
      }
      if (/out\.png$/.test(sp)) return true;
      return false;
    },
    renameSync: () => {},
    unlinkSync: () => {},
    statSync: () => ({ isFile: () => true, size: 100 }),
    promises: {
      rename: async () => {},
      writeFile: async () => {},
      stat: async () => ({ isFile: () => true, size: 100 }),
    },
  };

  Module._load = function (request, parent, ...rest) {
    if (request === 'child_process') return cpMock;
    if (request === 'fs') return fsMock;
    return origLoad.call(this, request, parent, ...rest);
  };

  const disc = require(DISC_PATH);
  disc.checkNodeBackendAvailable = () => true;

  const isnetbg = require(ISNETBG_PATH);
  Module._load = origLoad;

  return fn({ isnetbg, captured });
}

test('isnetbg_model_routing: run with birefnet-general-lite and no model file present errors with filename', async () => {
  await withMocks({ withBinary: true, withNodeModel: false, modelPresentKey: null }, async ({ isnetbg }) => {
    const res = await isnetbg.run('in.png', 'out.png', { model: 'birefnet-general-lite' });
    assert.equal(res.ok, false);
    assert.ok(res.stderr.includes('Model file missing:'));
    assert.ok(res.stderr.includes('birefnet-general-lite.onnx'));
  });
});

test('isnetbg_model_routing: routes to node backend even if binary exists for non-default model', async () => {
  await withMocks({ withBinary: true, withNodeModel: true, modelPresentKey: 'birefnet-general-lite' }, async ({ isnetbg, captured }) => {
    const res = await isnetbg.run('in.png', 'out.png', { model: 'birefnet-general-lite' });
    assert.equal(res.ok, true);
    assert.equal(captured.calls.length, 1);
    // Node process is spawned (process.execPath), not the binary
    assert.ok(!captured.calls[0].bin.includes('isnetbg.exe'));
    assert.ok(captured.calls[0].args.includes('--model'));
    assert.ok(captured.calls[0].args.includes('birefnet-general-lite'));
  });
});

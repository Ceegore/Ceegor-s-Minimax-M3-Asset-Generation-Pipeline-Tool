// scripts/e2e/scenarios/audio-cutter.js
// ============================================================================
// Ported near-verbatim from scripts/smoke-renderer.js step 6.
//
// The audio-cutter modal (window.showAudioCutter) opens, probes a generated
// WAV, and exports a trimmed clip of the expected duration.
//
// Self-contained: synthesises its own 2s 8kHz tone fixture, trims 0.5→1.5s,
// and asserts the exported clip is ~1.0s.
// ============================================================================

module.exports = {
  name: 'audio-cutter',
  needsRealApi: false,
  order: 60,
  async run(ctx) {
    // NOTE: `exec` is the harness's win.webContents.executeJavaScript() — NOT child_process.exec.
    const { exec, check } = ctx;

    const audio = await exec(`(async () => {
      function wav(sec, sr){ const n=Math.floor(sec*sr), dl=n*2, buf=new ArrayBuffer(44+dl), dv=new DataView(buf);
        const ws=(o,s)=>{for(let i=0;i<s.length;i++)dv.setUint8(o+i,s.charCodeAt(i));};
        ws(0,'RIFF');dv.setUint32(4,36+dl,true);ws(8,'WAVE');ws(12,'fmt ');dv.setUint32(16,16,true);dv.setUint16(20,1,true);
        dv.setUint16(22,1,true);dv.setUint32(24,sr,true);dv.setUint32(28,sr*2,true);dv.setUint16(32,2,true);dv.setUint16(34,16,true);
        ws(36,'data');dv.setUint32(40,dl,true);
        for(let i=0;i<n;i++)dv.setInt16(44+i*2,Math.round(Math.sin(2*Math.PI*440*i/sr)*30000),true);
        let bin='';const b=new Uint8Array(buf);for(let i=0;i<b.length;i++)bin+=String.fromCharCode(b[i]);return btoa(bin); }
      const out = state.config.output_dir; const src = out + '\\\\sm_tone.wav';
      const ag = await window.GrantCache.ensurePathGrant(out, 'write', { kind: 'directory', capabilities: ['read', 'write'], coversRoot: true });
      await window.api.fbWrite(src, wav(2.0, 8000), ag);
      const mr = document.querySelector('#modal-root'); mr.innerHTML=''; mr.classList.remove('active');
      window.showAudioCutter(src); await new Promise(r=>setTimeout(r,1200));
      const m = mr.querySelector('.audio-cutter-modal'); if (!m) return { opened:false };
      const inps = m.querySelectorAll('.ac-time-inp');
      inps[0].value='0:00.500'; inps[0].dispatchEvent(new Event('change'));
      inps[1].value='0:01.500'; inps[1].dispatchEvent(new Event('change'));
      m.querySelector('.ac-name-inp').value='sm_tone_cut.wav';
      [...m.querySelectorAll('button')].find(b=>/Export/.test(b.textContent)).click();
      await new Promise(r=>setTimeout(r,2500));
      const existsRes = await window.api.fbExists(out + '\\\\sm_tone_cut.wav', ag);
      const exists = !!(existsRes && existsRes.exists);
      const pr = await window.api.audioProbe(out + '\\\\sm_tone_cut.wav', ag);
      return { opened:true, exists, dur: pr && pr.duration };
    })()`);
    check(audio.opened, 'audio cutter modal did not open');
    check(audio.exists, 'audio cutter did not produce a trimmed file');
    check(audio.dur && Math.abs(audio.dur - 1.0) < 0.2, `audio cutter trim duration wrong (${audio.dur}, expected ~1.0)`);

    // Close the cutter modal so downstream scenarios start clean.
    await ctx.closeModals();
  },
};

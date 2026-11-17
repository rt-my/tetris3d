/* Monolite - modulo audio procedurale (Web Audio API). Nessun file esterno, musica originale. */
(function () {
  'use strict';

  var ctx = null, pre = null, lp = null, comp = null, sfxGain = null, musicGain = null;
  var revIn = null, noiseBuf = null;
  var soundOn = true, musicOn = false, paused = false, slowmo = false, intensity = 1;
  var voices = 0, MAX_VOICES = 12;
  var timer = null, stopTimer = null, nextTime = 0, step = 0;

  var MASTER = 0.5, MUSIC = 0.35, SFX = 0.6;

  function mtof(m) { return 440 * Math.pow(2, (m - 69) / 12); }
  function clamp(v, a, b) { v = +v; if (isNaN(v)) v = a; return Math.max(a, Math.min(b, v)); }

  function safe(fn) {
    return function () {
      if (!ctx) return;
      try { return fn.apply(null, arguments); } catch (e) { /* silenzio */ }
    };
  }

  // ---------- Costruzione del grafo ----------
  function makeImpulse(seconds) {
    var rate = ctx.sampleRate, n = Math.floor(rate * seconds);
    var buf = ctx.createBuffer(2, n, rate);
    for (var c = 0; c < 2; c++) {
      var d = buf.getChannelData(c);
      for (var i = 0; i < n; i++) {
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, 3);
      }
    }
    return buf;
  }

  function build() {
    comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18; comp.knee.value = 20; comp.ratio.value = 6;
    comp.attack.value = 0.005; comp.release.value = 0.2;
    comp.connect(ctx.destination);

    lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 22000; lp.Q.value = 0.5;
    lp.connect(comp);

    pre = ctx.createGain(); pre.gain.value = MASTER; pre.connect(lp);

    sfxGain = ctx.createGain(); sfxGain.gain.value = SFX; sfxGain.connect(pre);
    musicGain = ctx.createGain(); musicGain.gain.value = 0; musicGain.connect(pre);

    var conv = ctx.createConvolver();
    conv.buffer = makeImpulse(2.5);
    revIn = ctx.createGain(); revIn.gain.value = 1;
    var revOut = ctx.createGain(); revOut.gain.value = 0.7;
    revIn.connect(conv); conv.connect(revOut); revOut.connect(pre);

    var musRev = ctx.createGain(); musRev.gain.value = 0.35;
    musicGain.connect(musRev); musRev.connect(revIn);

    var len = ctx.sampleRate * 2;
    noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    var nd = noiseBuf.getChannelData(0);
    for (var i = 0; i < len; i++) nd[i] = Math.random() * 2 - 1;
  }

  // ---------- Primitive sonore ----------
  // o: {det, cut, cut2, q, ftype, sus}
  function osc(dest, type, f0, f1, t0, dur, vol, att, o) {
    o = o || {};
    var s = ctx.createOscillator(), g = ctx.createGain(), f = null;
    s.type = type;
    s.frequency.setValueAtTime(f0, t0);
    if (f1 && f1 !== f0) s.frequency.exponentialRampToValueAtTime(f1, t0 + dur);
    if (o.det) s.detune.value = o.det;
    att = Math.min(att, dur * 0.5);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(vol, t0 + att);
    if (o.sus) {
      g.gain.setValueAtTime(vol, t0 + dur - att);
    }
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    if (o.cut) {
      f = ctx.createBiquadFilter();
      f.type = o.ftype || 'lowpass';
      f.frequency.setValueAtTime(o.cut, t0);
      if (o.cut2) f.frequency.exponentialRampToValueAtTime(o.cut2, t0 + dur);
      f.Q.value = o.q || 0.7;
      s.connect(f); f.connect(g);
    } else s.connect(g);
    g.connect(dest);
    s.start(t0); s.stop(t0 + dur + 0.05);
    s.onended = function () {
      try { s.disconnect(); g.disconnect(); if (f) f.disconnect(); } catch (e) {}
    };
  }

  function noise(dest, t0, dur, vol, ftype, c0, c1, q) {
    var s = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
    s.buffer = noiseBuf; s.loop = true;
    f.type = ftype; f.Q.value = q || 0.7;
    f.frequency.setValueAtTime(c0, t0);
    if (c1 && c1 !== c0) f.frequency.exponentialRampToValueAtTime(c1, t0 + dur);
    g.gain.setValueAtTime(vol, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    s.connect(f); f.connect(g); g.connect(dest);
    s.start(t0, Math.random() * 1.5); s.stop(t0 + dur + 0.05);
    s.onended = function () { try { s.disconnect(); f.disconnect(); g.disconnect(); } catch (e) {} };
  }

  // Voce di effetto: limita la polifonia e ripulisce i nodi.
  // fn(t, out, rev): rev(amount) collega l'uscita al riverbero.
  function voice(dur, fn) {
    if (!ctx || !soundOn || voices >= MAX_VOICES) return;
    var nodes = [];
    voices++;
    try {
      var out = ctx.createGain();
      out.connect(sfxGain); nodes.push(out);
      var t = ctx.currentTime + 0.005;
      var rev = function (a) {
        var r = ctx.createGain(); r.gain.value = a;
        out.connect(r); r.connect(revIn); nodes.push(r);
      };
      fn(t, out, rev);
    } catch (e) { /* silenzio */ }
    setTimeout(function () {
      for (var i = 0; i < nodes.length; i++) { try { nodes[i].disconnect(); } catch (e) {} }
      voices = Math.max(0, voices - 1);
    }, (dur + 0.4) * 1000);
  }

  // ---------- Musica ----------
  var PROG = [
    { roots: [33, 29, 36, 31], chords: [[57, 60, 64], [57, 60, 65], [55, 60, 64], [55, 59, 62]] },
    { roots: [33, 31, 29, 28], chords: [[57, 60, 64], [55, 59, 62], [57, 60, 65], [55, 59, 64]] }
  ];
  var BASS_OCT = [0, 0, 12, 0, 0, 12, 0, 7];

  function bpm() { return Math.min(150, 96 + 3 * (intensity - 1)); }
  function rate() { return slowmo ? 0.6 : 1; }
  function stepDur() { return 60 / bpm() / 4 / rate(); }

  function scheduleStep(n, t) {
    var pm = rate(), sd = stepDur();
    var w = n % 16;
    var set = PROG[Math.floor(n / 128) % 2];
    var ci = Math.floor(n / 32) % 4;
    var root = set.roots[ci], chord = set.chords[ci];
    var dest = musicGain;

    // basso pulsante in ottavi
    if (w % 2 === 0) {
      var note = root + BASS_OCT[w / 2];
      osc(dest, 'sawtooth', mtof(note) * pm, 0, t, sd * 1.8, 0.32, 0.01,
        { cut: (450 + intensity * 40) * pm, cut2: 160 * pm, q: 3 });
    }
    // kick leggero
    if ((w === 0 || w === 8) || (intensity >= 3 && w % 4 === 0)) {
      osc(dest, 'sine', 130 * pm, 42 * pm, t, 0.2 / pm, 0.4, 0.003);
    }
    // hi-hat da livello 3
    if (intensity >= 3) {
      if (w % 4 === 2) noise(dest, t, 0.05 / pm, 0.1, 'highpass', 7000, 7000, 0.7);
      else if (intensity >= 8 && w % 2 === 1) noise(dest, t, 0.03 / pm, 0.05, 'highpass', 8000, 8000, 0.7);
    }
    // arpeggio da livello 6
    if (intensity >= 6 && Math.random() > 0.2) {
      var idx = [0, 1, 2, 1][w % 4];
      osc(dest, 'triangle', mtof(chord[idx] + 24) * pm, 0, t, 0.2 / pm, 0.1, 0.005,
        { cut: 3200 * pm, q: 1 });
    }
    // campane rade
    if ((w === 6 || w === 14) && Math.random() < 0.35) {
      var bn = chord[Math.floor(Math.random() * 3)] + 24;
      osc(dest, 'sine', mtof(bn) * pm, 0, t, 0.8 / pm, 0.09, 0.005);
    }
    // pad ogni due battute
    if (n % 32 === 0) {
      var pd = sd * 32 * 1.05;
      var cut = (700 + intensity * 30 + (intensity >= 10 ? 1400 : 0)) * pm;
      for (var i = 0; i < chord.length; i++) {
        var f = mtof(chord[i] + 12) * pm;
        osc(dest, 'sawtooth', f, 0, t, pd, 0.04, 1.2, { det: -9, cut: cut, q: 0.8, sus: true });
        osc(dest, 'sawtooth', f, 0, t, pd, 0.04, 1.2, { det: 9, cut: cut, q: 0.8, sus: true });
        osc(dest, 'triangle', f / 2, 0, t, pd, 0.05, 1.2, { sus: true });
        if (intensity >= 10) osc(dest, 'sine', f * 2, 0, t, pd, 0.025, 1.5, { sus: true });
      }
    }
  }

  function tick() {
    if (!ctx) return;
    try {
      var limit = ctx.currentTime + 0.1;
      var guard = 0;
      while (nextTime < limit && guard++ < 16) {
        scheduleStep(step, nextTime);
        nextTime += stepDur();
        step++;
      }
    } catch (e) { /* silenzio */ }
  }

  function applyMusicGain(ramp) {
    if (!musicGain) return;
    var target = musicOn ? MUSIC * (paused ? 0.2 : 1) : 0;
    var now = ctx.currentTime, g = musicGain.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.linearRampToValueAtTime(target, now + ramp);
  }

  function startMusic() {
    if (stopTimer) { clearTimeout(stopTimer); stopTimer = null; }
    if (!timer) {
      nextTime = ctx.currentTime + 0.05;
      step = 0;
      timer = setInterval(tick, 25);
    }
    applyMusicGain(0.5);
  }

  function stopMusic() {
    applyMusicGain(0.5);
    if (stopTimer) clearTimeout(stopTimer);
    stopTimer = setTimeout(function () {
      stopTimer = null;
      if (!musicOn && timer) { clearInterval(timer); timer = null; }
    }, 650);
  }

  // ---------- API pubblica ----------
  var Sfx = {};

  Sfx.init = function () {
    try {
      if (!ctx) {
        var AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        ctx = new AC();
        build();
      }
      if (ctx.state === 'suspended') ctx.resume();
    } catch (e) { ctx = null; }
  };

  Sfx.setSound = function (on) { soundOn = !!on; };

  Sfx.setMusic = safe(function (on) {
    musicOn = !!on;
    if (musicOn) { if (ctx.state === 'suspended') ctx.resume(); startMusic(); return; }
    // spegnimento deciso: dissolvenza breve, poi volume a zero e scheduler fermo
    if (stopTimer) { clearTimeout(stopTimer); stopTimer = null; }
    if (timer) { clearInterval(timer); timer = null; }
    var now = ctx.currentTime, g = musicGain.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.linearRampToValueAtTime(0, now + 0.15);
    g.setValueAtTime(0, now + 0.16);
  });

  Sfx.isMusicOn = function () { return musicOn; };

  // pagina nascosta: tutto l'audio sospeso, ripreso al ritorno
  Sfx.setHidden = safe(function (hidden) {
    if (hidden) ctx.suspend(); else ctx.resume();
  });

  Sfx.setIntensity = function (level) { intensity = Math.round(clamp(level, 1, 20)); };

  Sfx.setSlowmo = safe(function (on) {
    slowmo = !!on;
    var now = ctx.currentTime, f = lp.frequency;
    f.cancelScheduledValues(now);
    f.setValueAtTime(f.value, now);
    f.setTargetAtTime(slowmo ? 600 : 22000, now, 0.1);
  });

  Sfx.pause = safe(function (on) {
    paused = !!on;
    applyMusicGain(0.2);
  });

  Sfx.move = safe(function () {
    voice(0.06, function (t, out) {
      osc(out, 'square', 1800, 1300, t, 0.04, 0.07, 0.002, { cut: 4000 });
    });
  });

  Sfx.rotate = safe(function () {
    voice(0.2, function (t, out) {
      osc(out, 'triangle', 380, 1300, t, 0.14, 0.18, 0.01);
      noise(out, t, 0.12, 0.08, 'bandpass', 800, 3500, 1.5);
    });
  });

  Sfx.softDrop = safe(function () {
    voice(0.05, function (t, out) {
      osc(out, 'triangle', 900, 800, t, 0.025, 0.03, 0.002);
    });
  });

  Sfx.hardDrop = safe(function (height) {
    var h = clamp(height, 0, 20) / 20;
    var dur = 0.3 + 0.3 * h;
    voice(dur, function (t, out) {
      osc(out, 'sine', 120, 36, t, dur, 0.45 + 0.5 * h, 0.004);
      noise(out, t, 0.2 + 0.2 * h, 0.3 + 0.4 * h, 'lowpass', 1400, 140, 0.8);
    });
  });

  Sfx.lock = safe(function () {
    voice(0.15, function (t, out) {
      osc(out, 'triangle', 1400, 1000, t, 0.09, 0.12, 0.002);
      osc(out, 'square', 2100, 2000, t, 0.05, 0.035, 0.002, { cut: 2400, ftype: 'bandpass', q: 4 });
    });
  });

  Sfx.hold = safe(function () {
    voice(0.25, function (t, out) {
      osc(out, 'triangle', 660, 0, t, 0.09, 0.15, 0.005);
      osc(out, 'triangle', 880, 0, t + 0.07, 0.1, 0.15, 0.005);
    });
  });

  Sfx.clear = safe(function (layers, combo) {
    layers = Math.round(clamp(layers, 1, 8));
    combo = Math.round(clamp(combo, 1, 12));
    var big = layers >= 4;
    var dur = big ? 3.2 : 1.8;
    voice(dur, function (t, out, rev) {
      var base = 60 + layers * 2 + (combo > 1 ? combo - 1 : 0);
      var iv = [0, 4, 7, 12, 16, 19, 24];
      var cnt = Math.min(7, 2 + layers);
      for (var i = 0; i < cnt; i++) {
        var f = mtof(base + iv[i]), st = t + i * 0.045, d = 0.5 + (big ? 0.7 : 0.2);
        osc(out, 'triangle', f, 0, st, d, 0.13, 0.008);
        osc(out, 'sine', f * 2, 0, st, d * 0.7, 0.05, 0.008);
      }
      if (big) {
        osc(out, 'sawtooth', 200, 4500, t, 0.9, 0.12, 0.2, { cut: 2500, cut2: 6000, q: 2 });
        noise(out, t, 0.9, 0.12, 'bandpass', 400, 6000, 2);
        rev(1.4);
      } else rev(0.5);
    });
  });

  Sfx.bomb = safe(function () {
    voice(1.3, function (t, out, rev) {
      noise(out, t, 1.2, 0.8, 'lowpass', 6000, 80, 0.8);
      osc(out, 'sine', 95, 28, t, 1.0, 0.9, 0.004);
      rev(0.4);
    });
  });

  Sfx.powerup = safe(function () {
    voice(0.9, function (t, out, rev) {
      var iv = [0, 4, 7, 12, 16, 19, 24, 28];
      for (var i = 0; i < iv.length; i++) {
        var f = mtof(72 + iv[i]), st = t + i * 0.055;
        osc(out, 'sine', f, 0, st, 0.3, 0.14, 0.004);
        osc(out, 'triangle', f * 2, 0, st, 0.2, 0.04, 0.004);
      }
      rev(0.6);
    });
  });

  Sfx.levelUp = safe(function () {
    voice(1.3, function (t, out, rev) {
      var notes = [60, 64, 67, 72], dts = [0, 0.15, 0.3, 0.45], ds = [0.2, 0.2, 0.2, 0.7];
      for (var i = 0; i < 4; i++) {
        var f = mtof(notes[i]);
        osc(out, 'sawtooth', f, 0, t + dts[i], ds[i], 0.12, 0.01, { det: -7, cut: 2600, q: 1 });
        osc(out, 'sawtooth', f, 0, t + dts[i], ds[i], 0.12, 0.01, { det: 7, cut: 2600, q: 1 });
      }
      rev(0.5);
    });
  });

  Sfx.gameOver = safe(function () {
    musicOn = false;
    stopMusic();
    voice(4.6, function (t, out, rev) {
      for (var i = 0; i < 8; i++) {
        var f = mtof(76 - i), st = t + i * 0.38, d = 0.95, dt = 8 + i * 6;
        osc(out, 'sawtooth', f, f * 0.985, st, d, 0.13, 0.02, { det: -dt, cut: 1800, cut2: 500, q: 1 });
        osc(out, 'sawtooth', f, f * 0.985, st, d, 0.13, 0.02, { det: dt, cut: 1800, cut2: 500, q: 1 });
      }
      rev(0.8);
    });
  });

  window.Sfx = Sfx;
})();

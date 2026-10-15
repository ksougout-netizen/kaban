/* ============================================================================
   АТМОСФЕРА В ЧАТЕ
   Живой фон за сообщениями (над обоями, под пузырями). На выбор в настройках →
   «Оформление»: по сезону, листопад, снег, дождь, гроза, сакура, светлячки,
   звездопад, мыльные пузыри; три уровня интенсивности; можно выключить.

   • Листья нарисованы заранее (клён, дуб, берёза, липа, гинкго, ива — с прожилками,
     зубчиками, объёмом и более тёмной изнанкой) и летят «как настоящие»: качаются
     маятником, планируют, переворачиваются, кувыркаются, их сносит порывами ветра.
   • Три слоя глубины: дальние мельче, медленнее и бледнее.
   • Курсор или палец раздувают листья и снег, пузыри от касания лопаются.
   • Пауза, когда чат не виден, окно свёрнуто или включено «Уменьшить анимации».
   ========================================================================= */

(function () {
    "use strict";

    const rnd = (a, b) => a + Math.random() * (b - a);
    const pick = (list) => list[(Math.random() * list.length) | 0];
    const TAU = Math.PI * 2;
    const DENSITY = { low: 0.55, mid: 1, high: 1.75 };

    const ICONS = {
        auto: `<svg viewBox="0 0 24 24"><rect x="3.5" y="5" width="17" height="15" rx="2.5"/><path d="M3.5 9.5h17M8 3v4M16 3v4"/><path d="M8.5 14.5l2 2 4.5-4.5"/></svg>`,
        leaves: `<svg viewBox="0 0 24 24"><path d="M5 19c0-8 5-13 15-14-1 10-6 15-14 15"/><path d="M5 19l8-8"/></svg>`,
        snow: `<svg viewBox="0 0 24 24"><path d="M12 3v18M4.2 7.5l15.6 9M4.2 16.5l15.6-9M9.5 4.5 12 7l2.5-2.5M9.5 19.5 12 17l2.5 2.5"/></svg>`,
        rain: `<svg viewBox="0 0 24 24"><path d="M7 15.5a4.5 4.5 0 0 1-.5-9A6 6 0 0 1 18 8a3.8 3.8 0 0 1-.5 7.5z"/><path d="M8.5 18.5 7.5 21M12.5 18.5l-1 2.5M16.5 18.5l-1 2.5"/></svg>`,
        storm: `<svg viewBox="0 0 24 24"><path d="M7 15.5a4.5 4.5 0 0 1-.5-9A6 6 0 0 1 18 8a3.8 3.8 0 0 1-.5 7.5"/><path d="m12.5 12-2.5 4.5h3.5L11 21"/></svg>`,
        sakura: `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="2"/><path d="M12 10c-2-2.5-1.5-6 0-7 1.5 1 2 4.5 0 7zM14 12c2.5-2 6-1.5 7 0-1 1.5-4.5 2-7 0zM12 14c2 2.5 1.5 6 0 7-1.5-1-2-4.5 0-7zM10 12c-2.5 2-6 1.5-7 0 1-1.5 4.5-2 7 0z"/></svg>`,
        fireflies: `<svg viewBox="0 0 24 24"><circle cx="7" cy="8" r="1.6"/><circle cx="16.5" cy="6" r="1.1"/><circle cx="14" cy="15" r="2"/><circle cx="6" cy="17.5" r="1"/><path d="M14 10.5v-1M14 20.5v-1M9.5 15h1M18.5 15h-1"/></svg>`,
        stars: `<svg viewBox="0 0 24 24"><path d="M3 21 13 11"/><path d="m16.5 3 1.2 2.8 2.8 1.2-2.8 1.2-1.2 2.8-1.2-2.8-2.8-1.2 2.8-1.2z"/><path d="M6 5.5h.01M20 16h.01"/></svg>`,
        bubbles: `<svg viewBox="0 0 24 24"><circle cx="9" cy="14" r="5.5"/><circle cx="17" cy="7.5" r="3"/><circle cx="18" cy="17" r="1.8"/><path d="M6.5 12a3 3 0 0 1 2-2"/></svg>`
    };

    const KINDS = [
        { id: "auto", label: "По сезону" },
        { id: "leaves", label: "Листопад" },
        { id: "snow", label: "Снег" },
        { id: "rain", label: "Дождь" },
        { id: "storm", label: "Гроза" },
        { id: "sakura", label: "Сакура" },
        { id: "fireflies", label: "Светлячки" },
        { id: "stars", label: "Звездопад" },
        { id: "bubbles", label: "Пузыри" }
    ];

    function seasonKind(date) {
        const m = date.getMonth();
        if (m === 11 || m <= 1) return "snow";
        if (m <= 4) return "sakura";
        if (m <= 7) return "fireflies";
        return "leaves";
    }

    function chosenKind() {
        let forced = null;
        try { forced = new URLSearchParams(location.search).get("season") || localStorage.getItem("kaban-season-force"); } catch { /* ок */ }
        if (forced === "off") return null;
        if (forced && ENGINES[forced]) return forced;
        const kind = appSettings.atmosphereKind || "auto";
        return kind !== "auto" && ENGINES[kind] ? kind : seasonKind(new Date());
    }

    /* ---- цвета ---- */

    function rgb(hex) {
        const n = parseInt(hex.slice(1), 16);
        return [n >> 16, (n >> 8) & 255, n & 255];
    }
    function shade(hex, f, alpha = 1) {
        let [r, g, b] = rgb(hex);
        if (f >= 1) { r += (255 - r) * (f - 1); g += (255 - g) * (f - 1); b += (255 - b) * (f - 1); }
        else { r *= f; g *= f; b *= f; }
        return `rgba(${r | 0},${g | 0},${b | 0},${alpha})`;
    }
    function dull(hex, k) {
        const [r, g, b] = rgb(hex);
        const y = 0.3 * r + 0.59 * g + 0.11 * b;
        const m = (c) => Math.round(c + (y - c) * k).toString(16).padStart(2, "0");
        return "#" + m(r) + m(g) + m(b);
    }

    function canvasOf(w, h = w) {
        const c = document.createElement("canvas");
        c.width = w;
        c.height = h;
        return c;
    }

    /* ---- формы листьев (единичный размер, черешок внизу) ---- */

    const tri = (v) => 1 - Math.abs(2 * (v - Math.floor(v)) - 1);
    const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

    function polar(fn, n = 320) {
        const path = new Path2D();
        for (let i = 0; i <= n; i++) {
            const [x, y] = fn((i / n) * TAU);
            if (i) path.lineTo(x, y); else path.moveTo(x, y);
        }
        path.closePath();
        return path;
    }

    const LEAF_SHAPES = {
        maple() {
            // Правая половина настоящего кленового листа (сверху вниз), левая — зеркально.
            const half = [
                [0, -1.0], [0.07, -0.8], [0.17, -0.85], [0.14, -0.63], [0.25, -0.62], [0.16, -0.44], [0.2, -0.3],
                [0.42, -0.4], [0.48, -0.6], [0.58, -0.46], [0.8, -0.64], [0.98, -0.54], [0.78, -0.32], [0.88, -0.22],
                [0.63, -0.12], [0.7, -0.01], [0.43, 0.05], [0.53, 0.17], [0.68, 0.37], [0.43, 0.3], [0.29, 0.28], [0.08, 0.34], [0, 0.3]
            ].map(([x, y]) => [x * 0.95, y + 0.3]);
            const pts = [...half, ...half.slice(0, -1).reverse().map(([x, y]) => [-x, y])];
            const path = new Path2D();
            pts.forEach(([x, y], i) => (i ? path.lineTo(x, y) : path.moveTo(x, y)));
            path.closePath();
            const o = [0, 0.52];
            const tips = [[0, -0.7], [0.93, -0.21], [-0.93, -0.21], [0.65, 0.67], [-0.65, 0.67]];
            const veins = tips.map(([x, y], i) => [o[0], o[1], o[0] + (x - o[0]) * 0.93, o[1] + (y - o[1]) * 0.93, i === 0 ? 2.2 : 1.6]);
            return { path, veins, stem: [0, 0.58, 0.04, 1.12] };
        },        oak() {
            const at = (s) => {
                const m = 0.6 + 0.4 * Math.pow(Math.abs(Math.cos(4.5 * s)), 0.45);
                return [0.52 * Math.sin(s) * m, -0.95 * Math.cos(s) * m];
            };
            const veins = [[0, 0.82, 0, -0.85, 2.2]];
            for (let k = 1; k <= 4; k++) {
                const s = (k * Math.PI) / 4.5;
                const [x, y] = at(s);
                veins.push([0, y * 0.45 + 0.05, x * 0.9, y * 0.9, 1.3], [0, y * 0.45 + 0.05, -x * 0.9, y * 0.9, 1.3]);
            }
            return { path: polar(at), veins, stem: [0, 0.8, -0.03, 1.08] };
        },
        birch() { return ovate(0.62, false, 34); },
        linden() { return ovate(0.8, true, 26); },
        ginkgo() {
            const apex = [0, 0.82], R = 1.28;
            const path = new Path2D();
            path.moveTo(apex[0], apex[1]);
            for (let i = 0; i <= 120; i++) {
                const a = (-135 + (i / 120) * 90) * Math.PI / 180;
                const deg = -135 + (i / 120) * 90;
                const rr = R * (1 - 0.17 * Math.exp(-Math.pow((deg + 90) / 6, 2)) + 0.015 * Math.sin(deg * 1.3));
                path.lineTo(apex[0] + Math.cos(a) * rr, apex[1] + Math.sin(a) * rr);
            }
            path.closePath();
            const veins = [];
            for (let i = 0; i < 11; i++) {
                const a = (-130 + i * 8) * Math.PI / 180;
                veins.push([apex[0], apex[1], apex[0] + Math.cos(a) * R * 0.95, apex[1] + Math.sin(a) * R * 0.95, 0.9]);
            }
            return { path, veins, stem: [0, 0.82, 0.03, 1.12] };
        },
        willow() {
            const at = (s) => {
                const y = -Math.cos(s) * 1.05;
                return [0.24 * Math.sin(s) * Math.pow(Math.sin(s / 2), 0.6) + 0.12 * Math.sin(y * 1.6), y];
            };
            return { path: polar(at), veins: [[0.12 * Math.sin(1.6), 0.95, 0.12 * Math.sin(-1.6), -0.95, 1.8]], stem: [0.15, 0.95, 0.18, 1.12] };
        }
    };

    function ovate(width, heart, teethCount) {
        const at = (s) => {
            const k = 1 + 0.045 * tri((s * teethCount) / TAU);
            let y = -Math.cos(s) * 0.95;
            const x = width * Math.sin(s) * Math.pow(Math.sin(s / 2), 0.8) * k;
            if (heart) y -= 0.2 * Math.exp(-Math.pow(s - Math.PI, 2) / 0.05);
            return [x, y * k];
        };
        const veins = [[0, 0.82, 0, -0.85, 2]];
        for (let i = 1; i <= 5; i++) {
            const s = 0.6 + i * 0.42;
            const [x, y] = at(s);
            const y0 = y + 0.32;
            veins.push([0, y0, x * 0.88, y * 0.95, 1.1], [0, y0, -x * 0.88, y * 0.95, 1.1]);
        }
        return { path: polar(at), veins, stem: [0, 0.82, 0.02, 1.1] };
    }

    const LEAF_PALETTES = {
        maple:  { autumn: ["#d62b1f", "#e8501c", "#f2862a", "#c41e3a", "#e0662a"], green: ["#5aa832", "#4f9a2e"] },
        oak:    { autumn: ["#a5522a", "#bf7a30", "#8b4a22", "#c68a3c"], green: ["#4d8b2c"] },
        birch:  { autumn: ["#f2c230", "#e9b021", "#d9a516"], green: ["#7cbf3c"] },
        linden: { autumn: ["#e7b52c", "#d6a227", "#e39a2a"], green: ["#6fae3a"] },
        ginkgo: { autumn: ["#f6cf3f", "#f0bf1f"], green: ["#8fc34a"] },
        willow: { autumn: ["#d9b83a", "#c4a53a"], green: ["#78a83a"] }
    };

    function paintLeaf(shape, color, back, autumn) {
        const S = 112, k = S * 0.4;
        const c = canvasOf(S);
        const x = c.getContext("2d");
        x.translate(S / 2, S / 2);
        x.scale(k, k);
        const base = back ? dull(color, 0.35) : color;
        // черешок
        x.lineCap = "round";
        x.strokeStyle = shade(base, 0.55);
        x.lineWidth = 2.6 / k;
        x.beginPath();
        x.moveTo(shape.stem[0], shape.stem[1]);
        x.quadraticCurveTo(shape.stem[0] + 0.06, (shape.stem[1] + shape.stem[3]) / 2, shape.stem[2], shape.stem[3]);
        x.stroke();
        // лист: объём — свет сверху слева, тень снизу справа
        const g = x.createLinearGradient(-0.8, -0.95, 0.8, 0.95);
        g.addColorStop(0, shade(base, back ? 1.05 : 1.28));
        g.addColorStop(0.5, shade(base, back ? 0.85 : 1));
        g.addColorStop(1, shade(base, back ? 0.6 : 0.7));
        x.fillStyle = g;
        x.fill(shape.path);
        x.save();
        x.clip(shape.path);
        const hl = x.createRadialGradient(-0.3, -0.4, 0, -0.3, -0.4, 1.1);
        hl.addColorStop(0, `rgba(255,255,255,${back ? 0.06 : 0.2})`);
        hl.addColorStop(1, "rgba(255,255,255,0)");
        x.fillStyle = hl;
        x.fillRect(-1.5, -1.5, 3, 3);
        if (autumn && !back) {
            // пятнышки увядания
            for (let i = 0; i < 7; i++) {
                x.fillStyle = `rgba(90,35,10,${rnd(0.08, 0.2)})`;
                x.beginPath();
                x.arc(rnd(-0.5, 0.5), rnd(-0.6, 0.6), rnd(0.03, 0.08), 0, TAU);
                x.fill();
            }
        }
        // тёмная кромка по краю
        x.strokeStyle = shade(base, 0.55, 0.45);
        x.lineWidth = 7 / k;
        x.stroke(shape.path);
        x.restore();
        // прожилки
        x.strokeStyle = back ? shade(base, 1.35, 0.6) : shade(base, 1.22, 0.55);
        shape.veins.forEach(([x1, y1, x2, y2, w]) => {
            x.lineWidth = w / k;
            x.beginPath();
            x.moveTo(x1, y1);
            x.quadraticCurveTo((x1 + x2) / 2 + (x2 - x1) * 0.05, (y1 + y2) / 2 + 0.04, x2, y2);
            x.stroke();
        });
        x.strokeStyle = shade(base, 0.5, 0.5);
        x.lineWidth = 1.2 / k;
        x.stroke(shape.path);
        return c;
    }

    let leafSprites = null;
    function buildLeafSprites() {
        if (leafSprites) return leafSprites;
        leafSprites = [];
        Object.entries(LEAF_SHAPES).forEach(([kind, make]) => {
            const shape = make();
            const pal = LEAF_PALETTES[kind];
            pal.autumn.forEach((col) => leafSprites.push({ kind, green: false, front: paintLeaf(shape, col, false, true), back: paintLeaf(shape, col, true, true) }));
            pal.green.forEach((col) => leafSprites.push({ kind, green: true, front: paintLeaf(shape, col, false, false), back: paintLeaf(shape, col, true, false) }));
        });
        return leafSprites;
    }

    /* ---- прочие спрайты ---- */

    const spriteCache = new Map();
    function sprite(key, make) {
        const full = key + (S.dark ? ":d" : ":l");
        if (!spriteCache.has(full)) spriteCache.set(full, make(S.dark));
        return spriteCache.get(full);
    }

    function softDot(dark) {
        const c = canvasOf(32), x = c.getContext("2d");
        const g = x.createRadialGradient(16, 16, 0, 16, 16, 16);
        const col = dark ? "255,255,255" : "150,178,214";
        g.addColorStop(0, `rgba(${col},1)`);
        g.addColorStop(0.45, `rgba(${col},.85)`);
        g.addColorStop(1, `rgba(${col},0)`);
        x.fillStyle = g;
        x.fillRect(0, 0, 32, 32);
        return c;
    }

    function crystal(dark) {
        const S = 64, c = canvasOf(S), x = c.getContext("2d");
        x.translate(S / 2, S / 2);
        x.strokeStyle = dark ? "rgba(255,255,255,.95)" : "rgba(128,160,205,.95)";
        x.lineCap = "round";
        x.shadowColor = dark ? "rgba(200,225,255,.9)" : "rgba(255,255,255,.9)";
        x.shadowBlur = 4;
        for (let i = 0; i < 6; i++) {
            x.save();
            x.rotate((i * TAU) / 6);
            x.lineWidth = 2.4;
            x.beginPath(); x.moveTo(0, 0); x.lineTo(0, -26); x.stroke();
            x.lineWidth = 1.7;
            [[-10, 7], [-17, 6], [-22, 4]].forEach(([y, l]) => {
                x.beginPath(); x.moveTo(0, y); x.lineTo(l, y - l * 0.8); x.moveTo(0, y); x.lineTo(-l, y - l * 0.8); x.stroke();
            });
            x.restore();
        }
        x.fillStyle = x.strokeStyle;
        x.beginPath(); x.arc(0, 0, 3, 0, TAU); x.fill();
        return c;
    }

    function petal(color, dark) {
        const S = 64, c = canvasOf(S), x = c.getContext("2d");
        x.translate(S / 2, S / 2);
        x.scale(S * 0.4, S * 0.4);
        const p = new Path2D();
        p.moveTo(0, 1);
        p.bezierCurveTo(0.9, 0.55, 0.85, -0.55, 0.28, -0.92);
        p.quadraticCurveTo(0.1, -0.7, 0, -0.62);
        p.quadraticCurveTo(-0.1, -0.7, -0.28, -0.92);
        p.bezierCurveTo(-0.85, -0.55, -0.9, 0.55, 0, 1);
        const g = x.createRadialGradient(0, 0.8, 0, 0, 0.1, 1.2);
        g.addColorStop(0, "#fff5f8");
        g.addColorStop(0.5, color);
        g.addColorStop(1, shade(color, 0.86));
        x.fillStyle = g;
        x.fill(p);
        x.strokeStyle = shade(color, 0.8, dark ? 0.35 : 0.5);
        x.lineWidth = 0.03;
        x.stroke(p);
        x.strokeStyle = "rgba(255,255,255,.45)";
        x.lineWidth = 0.025;
        [-0.25, 0, 0.25].forEach((dx) => { x.beginPath(); x.moveTo(0, 0.9); x.quadraticCurveTo(dx * 0.6, 0.2, dx, -0.5); x.stroke(); });
        return c;
    }

    function blossom(dark) {
        const S = 96, c = canvasOf(S), x = c.getContext("2d");
        const p = petal("#f7a8c4", dark);
        x.translate(S / 2, S / 2);
        for (let i = 0; i < 5; i++) {
            x.save();
            x.rotate((i * TAU) / 5);
            x.drawImage(p, -15, -36, 30, 30);
            x.restore();
        }
        x.fillStyle = "#f5c242";
        for (let i = 0; i < 9; i++) {
            const a = (i * TAU) / 9;
            x.beginPath(); x.arc(Math.cos(a) * 7, Math.sin(a) * 7, 2, 0, TAU); x.fill();
        }
        x.fillStyle = "#e38fae";
        x.beginPath(); x.arc(0, 0, 4.5, 0, TAU); x.fill();
        return c;
    }

    function glow(dark) {
        const c = canvasOf(64), x = c.getContext("2d");
        const g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
        if (dark) {
            g.addColorStop(0, "rgba(255,255,220,1)");
            g.addColorStop(0.18, "rgba(230,255,120,.95)");
            g.addColorStop(0.45, "rgba(170,255,80,.32)");
            g.addColorStop(1, "rgba(120,255,60,0)");
        } else {
            g.addColorStop(0, "rgba(255,240,170,1)");
            g.addColorStop(0.2, "rgba(255,190,30,.95)");
            g.addColorStop(0.5, "rgba(255,160,0,.3)");
            g.addColorStop(1, "rgba(255,150,0,0)");
        }
        x.fillStyle = g;
        x.fillRect(0, 0, 64, 64);
        return c;
    }

    function bubble(hue, dark) {
        const S = 128, c = canvasOf(S), x = c.getContext("2d");
        const r = 58;
        const body = x.createRadialGradient(64, 64, r * 0.55, 64, 64, r);
        body.addColorStop(0, "rgba(255,255,255,0)");
        body.addColorStop(1, `rgba(255,255,255,${dark ? 0.1 : 0.22})`);
        x.fillStyle = body;
        x.beginPath(); x.arc(64, 64, r, 0, TAU); x.fill();
        if (x.createConicGradient) {
            const rim = x.createConicGradient(hue, 64, 64);
            [0, 0.17, 0.34, 0.5, 0.67, 0.84, 1].forEach((stop, i) => rim.addColorStop(stop, `hsla(${(i * 60 + hue * 57) % 360},90%,${dark ? 70 : 55}%,${dark ? 0.55 : 0.7})`));
            x.strokeStyle = rim;
        } else {
            x.strokeStyle = "rgba(160,200,255,.6)";
        }
        x.lineWidth = 3.2;
        x.beginPath(); x.arc(64, 64, r - 1.5, 0, TAU); x.stroke();
        if (!dark) { x.strokeStyle = "rgba(40,60,90,.12)"; x.lineWidth = 1; x.beginPath(); x.arc(64, 64, r, 0, TAU); x.stroke(); }
        x.fillStyle = "rgba(255,255,255,.85)";
        x.beginPath(); x.ellipse(44, 40, 13, 7, -0.7, 0, TAU); x.fill();
        x.fillStyle = "rgba(255,255,255,.35)";
        x.beginPath(); x.ellipse(86, 90, 6, 3, -0.7, 0, TAU); x.fill();
        return c;
    }

    /* ---- состояние ---- */

    const S = {
        canvas: null, ctx: null, w: 0, h: 0, dpr: 1, dark: false, kind: null, density: 1,
        items: [], fx: [], raf: 0, last: 0, t: 0,
        wind: { now: 0.2, target: 0.2, base: 0.2, gustUntil: 0, nextGust: 3 },
        pointer: { x: -999, y: -999, vx: 0, vy: 0, at: 0 },
        storm: { next: 4, flash: 0, bolt: null, boltAt: 0 }
    };

    function chatArea() { return document.querySelector(".chat-area"); }

    function active() {
        const area = chatArea();
        return !!(S.kind && appSettings.seasonalAtmosphere !== false && !appSettings.reduceMotion && !document.hidden && area && area.clientWidth > 0 && area.clientHeight > 0);
    }

    function ensureCanvas() {
        const area = chatArea();
        if (!area) return false;
        if (!S.canvas) {
            S.canvas = document.createElement("canvas");
            S.canvas.className = "wow-season";
            S.canvas.setAttribute("aria-hidden", "true");
            S.ctx = S.canvas.getContext("2d");
            area.addEventListener("pointermove", onPointer, { passive: true });
        }
        // Над обоями, но под сообщениями: сразу после слоя обоев.
        const wallpaper = area.querySelector(":scope > .chat-wallpaper-layer");
        if (wallpaper) { if (wallpaper.nextSibling !== S.canvas) wallpaper.after(S.canvas); }
        else if (S.canvas.parentNode !== area) area.prepend(S.canvas);
        const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
        const w = area.clientWidth, h = area.clientHeight;
        if (w !== S.w || h !== S.h || dpr !== S.dpr) {
            S.w = w; S.h = h; S.dpr = dpr;
            S.canvas.width = Math.round(w * dpr);
            S.canvas.height = Math.round(h * dpr);
        }
        return true;
    }

    function onPointer(event) {
        if (!S.canvas || !S.raf) return;
        const r = S.canvas.getBoundingClientRect();
        const now = performance.now();
        const x = event.clientX - r.left, y = event.clientY - r.top;
        const dt = Math.max(16, now - S.pointer.at) / 1000;
        if (now - S.pointer.at < 120) {
            S.pointer.vx = S.pointer.vx * 0.5 + ((x - S.pointer.x) / dt) * 0.5;
            S.pointer.vy = S.pointer.vy * 0.5 + ((y - S.pointer.y) / dt) * 0.5;
        } else { S.pointer.vx = 0; S.pointer.vy = 0; }
        S.pointer.x = x; S.pointer.y = y; S.pointer.at = now;
    }

    // Толчок от курсора: частица в радиусе получает скорость движения мыши.
    function pointerPush(p, radius, k) {
        const ptr = S.pointer;
        if (performance.now() - ptr.at > 150) return;
        const dx = p.x - ptr.x, dy = p.y - ptr.y;
        const d2 = dx * dx + dy * dy;
        if (d2 > radius * radius) return;
        const f = (1 - Math.sqrt(d2) / radius) * k;
        p.ix = (p.ix || 0) + ptr.vx * f * 0.035 + (dx / (Math.sqrt(d2) + 1)) * 40 * f;
        p.iy = (p.iy || 0) + ptr.vy * f * 0.035 + (dy / (Math.sqrt(d2) + 1)) * 30 * f;
    }

    function stepWind(dt) {
        const w = S.wind;
        const strong = S.kind === "storm" ? 1.8 : 1;
        if (S.t > w.nextGust) {
            w.gustUntil = S.t + rnd(1.8, 4);
            w.target = (Math.random() < 0.7 ? 1 : -1) * rnd(0.6, 1.4) * strong;
            w.nextGust = w.gustUntil + rnd(4, 10);
        }
        if (S.t > w.gustUntil) w.target = w.base * strong;
        w.now += (w.target - w.now) * Math.min(1, dt * 0.9);
    }

    /* ---- движки ---- */

    const area = () => S.w * S.h;

    const ENGINES = {
        leaves: {
            count: () => Math.min(48, Math.max(8, area() / 21000)),
            make(fresh) {
                const sprites = buildLeafSprites();
                // примерно каждый пятый — зелёный
                const green = Math.random() < 0.2;
                const pool = sprites.filter((s) => s.green === green);
                const z = rnd(0.55, 1.3);
                return {
                    x: rnd(-40, S.w + 40), y: fresh ? rnd(-S.h * 0.2, S.h) : rnd(-80, -30), z,
                    sp: pick(pool), size: rnd(26, 42) * z * (Math.random() < 0.12 ? 1.35 : 1),
                    vy0: rnd(26, 44) * (0.6 + z * 0.5), swingA: rnd(26, 62), swingW: rnd(0.9, 1.7), phase: rnd(0, TAU),
                    rot0: rnd(-0.6, 0.6), spin: Math.random() < 0.25 ? rnd(-3.2, 3.2) : rnd(-0.4, 0.4), rot: 0,
                    flip: rnd(0, TAU), flipW: rnd(1.2, 3.6), ix: 0, iy: 0
                };
            },
            step(p, dt) {
                p.phase += p.swingW * dt;
                const s = Math.sin(p.phase), c = Math.cos(p.phase);
                pointerPush(p, 110, 1);
                p.ix *= Math.exp(-1.6 * dt); p.iy *= Math.exp(-1.6 * dt);
                // маятник: в крайних точках лист проваливается быстрее, в середине — планирует
                const vx = c * p.swingA * p.swingW * 0.55 + S.wind.now * 85 * (0.5 + p.z * 0.6) + p.ix;
                const vy = p.vy0 * (0.55 + 0.75 * s * s) + p.iy;
                p.x += vx * dt; p.y += vy * dt;
                p.rot0 += p.spin * dt;
                p.rot = p.rot0 + s * 0.65 + S.wind.now * 0.25;
                p.flip += p.flipW * dt * (1 + Math.abs(S.wind.now) * 0.6);
                return p.y < S.h + 60 && p.x > -120 && p.x < S.w + 120;
            },
            draw(ctx, p) {
                const fx = Math.cos(p.flip);
                const sx = Math.sign(fx || 1) * Math.max(0.12, Math.abs(fx));
                ctx.globalAlpha = 0.62 + 0.38 * Math.min(1, p.z);
                ctx.setTransform(S.dpr * sx * Math.cos(p.rot), S.dpr * sx * Math.sin(p.rot), -S.dpr * Math.sin(p.rot), S.dpr * Math.cos(p.rot), p.x * S.dpr, p.y * S.dpr);
                ctx.drawImage(fx >= 0 ? p.sp.front : p.sp.back, -p.size / 2, -p.size / 2, p.size, p.size);
            }
        },

        snow: {
            count: () => Math.min(260, area() / 4200),
            make(fresh) {
                const z = rnd(0.45, 1.35);
                const type = z > 1.25 && Math.random() < 0.5 ? "bokeh" : (z > 0.9 && Math.random() < 0.3 ? "crystal" : "dot");
                return {
                    x: rnd(-20, S.w + 20), y: fresh ? rnd(-20, S.h) : rnd(-40, -10), z, type,
                    size: type === "crystal" ? rnd(14, 24) * z : type === "bokeh" ? rnd(16, 28) : rnd(3.5, 8) * z,
                    vy: rnd(18, 34) * (0.5 + z * 0.7), sway: rnd(8, 26), w: rnd(0.4, 1.2), phase: rnd(0, TAU),
                    rot: rnd(0, TAU), spin: rnd(-0.8, 0.8), a: type === "bokeh" ? rnd(0.18, 0.35) : rnd(0.55, 1), ix: 0, iy: 0
                };
            },
            step(p, dt) {
                p.phase += p.w * dt;
                pointerPush(p, 90, 0.8);
                p.ix *= Math.exp(-1.8 * dt); p.iy *= Math.exp(-1.8 * dt);
                p.x += (Math.cos(p.phase) * p.sway * p.w + S.wind.now * 60 * p.z + p.ix) * dt;
                p.y += (p.vy + p.iy) * dt;
                p.rot += p.spin * dt;
                return p.y < S.h + 30 && p.x > -60 && p.x < S.w + 60;
            },
            draw(ctx, p) {
                ctx.globalAlpha = p.a;
                if (p.type === "crystal") {
                    ctx.setTransform(S.dpr * Math.cos(p.rot), S.dpr * Math.sin(p.rot), -S.dpr * Math.sin(p.rot), S.dpr * Math.cos(p.rot), p.x * S.dpr, p.y * S.dpr);
                    ctx.drawImage(sprite("crystal", crystal), -p.size / 2, -p.size / 2, p.size, p.size);
                } else {
                    ctx.setTransform(S.dpr, 0, 0, S.dpr, 0, 0);
                    ctx.drawImage(sprite("dot", softDot), p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
                }
            }
        },

        rain: rainEngine(1),
        storm: rainEngine(1.6),

        sakura: {
            count: () => Math.min(60, Math.max(10, area() / 14000)),
            make(fresh) {
                const z = rnd(0.55, 1.3);
                const whole = Math.random() < 0.1;
                return {
                    x: rnd(-40, S.w + 40), y: fresh ? rnd(-S.h * 0.2, S.h) : rnd(-60, -20), z, whole,
                    color: pick(["#ffb7c9", "#ffc8d8", "#f9a3bd", "#ffd6e2"]),
                    size: (whole ? rnd(24, 34) : rnd(15, 22)) * z,
                    vy0: rnd(18, 32) * (0.6 + z * 0.5), swingA: rnd(30, 70), swingW: rnd(0.8, 1.5), phase: rnd(0, TAU),
                    rot0: rnd(0, TAU), spin: rnd(-1.6, 1.6), rot: 0, flip: rnd(0, TAU), flipW: rnd(2, 5), ix: 0, iy: 0
                };
            },
            step(p, dt) { return ENGINES.leaves.step(p, dt * 0.85); },
            draw(ctx, p) {
                const fx = Math.cos(p.flip);
                const sx = p.whole ? 1 : Math.sign(fx || 1) * Math.max(0.15, Math.abs(fx));
                ctx.globalAlpha = 0.7 + 0.3 * Math.min(1, p.z);
                ctx.setTransform(S.dpr * sx * Math.cos(p.rot), S.dpr * sx * Math.sin(p.rot), -S.dpr * Math.sin(p.rot), S.dpr * Math.cos(p.rot), p.x * S.dpr, p.y * S.dpr);
                const img = p.whole ? sprite("blossom", blossom) : sprite("petal" + p.color, (d) => petal(p.color, d));
                ctx.drawImage(img, -p.size / 2, -p.size / 2, p.size, p.size);
            }
        },

        fireflies: {
            count: () => Math.min(46, Math.max(8, area() / 26000)),
            make() {
                const z = rnd(0.5, 1.3);
                return {
                    x: rnd(0, S.w), y: rnd(S.h * 0.1, S.h), z, size: rnd(24, 44) * z,
                    dir: rnd(0, TAU), speed: rnd(10, 26) * z, turn: rnd(-0.6, 0.6),
                    pulse: rnd(0, TAU), pulseW: rnd(1.2, 2.6), blink: rnd(3, 9), ix: 0, iy: 0
                };
            },
            step(p, dt) {
                p.turn += rnd(-1.2, 1.2) * dt;
                p.turn = Math.max(-1, Math.min(1, p.turn));
                p.dir += p.turn * dt;
                pointerPush(p, 90, 0.9);
                p.ix *= Math.exp(-2 * dt); p.iy *= Math.exp(-2 * dt);
                p.x += (Math.cos(p.dir) * p.speed + S.wind.now * 6 + p.ix) * dt;
                p.y += (Math.sin(p.dir) * p.speed * 0.7 - 3 + p.iy) * dt;
                if (p.x < -30) p.x = S.w + 20; if (p.x > S.w + 30) p.x = -20;
                if (p.y < -30) p.y = S.h + 20; if (p.y > S.h + 30) p.y = -20;
                p.pulse += p.pulseW * dt;
                return true;
            },
            draw(ctx, p) {
                const s = Math.sin(p.pulse);
                const a = 0.12 + 0.88 * Math.pow(Math.max(0, s), 2);
                ctx.globalAlpha = a * (0.55 + 0.45 * Math.min(1, p.z));
                ctx.setTransform(S.dpr, 0, 0, S.dpr, 0, 0);
                const size = p.size * (0.8 + 0.3 * a);
                ctx.drawImage(sprite("glow", glow), p.x - size / 2, p.y - size / 2, size, size);
            },
            composite: () => (S.dark ? "lighter" : "source-over")
        },

        stars: {
            count: () => Math.min(220, area() / 3600),
            make() {
                return { x: rnd(0, S.w), y: rnd(0, S.h), r: Math.random() < 0.08 ? rnd(1.4, 2.1) : rnd(0.5, 1.3), tw: rnd(0.6, 2.2), phase: rnd(0, TAU), a: rnd(0.35, 1) };
            },
            step(p, dt) { p.phase += p.tw * dt; return true; },
            draw(ctx, p) {
                const a = p.a * (0.45 + 0.55 * (0.5 + 0.5 * Math.sin(p.phase)));
                ctx.globalAlpha = S.dark ? a : a * 0.75;
                ctx.setTransform(S.dpr, 0, 0, S.dpr, 0, 0);
                ctx.fillStyle = S.dark ? "#ffffff" : "#7d8fb3";
                ctx.fillRect(p.x - p.r / 2, p.y - p.r / 2, p.r, p.r);
                if (p.r > 1.4) {
                    ctx.globalAlpha *= 0.55;
                    ctx.fillRect(p.x - p.r * 2.2, p.y - 0.35, p.r * 4.4, 0.7);
                    ctx.fillRect(p.x - 0.35, p.y - p.r * 2.2, 0.7, p.r * 4.4);
                }
            },
            extra(ctx, dt) {
                // падающие звёзды
                if (S.t > (S.nextMeteor || 0)) {
                    S.nextMeteor = S.t + rnd(1.2, 3.6) / S.density;
                    const fromLeft = Math.random() < 0.5;
                    const ang = (fromLeft ? rnd(20, 40) : rnd(140, 160)) * Math.PI / 180;
                    const speed = rnd(650, 1000);
                    S.fx.push({ type: "meteor", x: rnd(S.w * 0.1, S.w * 0.9), y: rnd(-20, S.h * 0.35), vx: Math.cos(ang) * speed, vy: Math.sin(ang) * speed, len: rnd(110, 220), life: rnd(0.55, 0.95), age: 0 });
                }
            }
        },

        bubbles: {
            count: () => Math.min(26, Math.max(5, area() / 42000)),
            make(fresh) {
                const r = rnd(9, 34);
                return {
                    x: rnd(r, S.w - r), y: fresh ? rnd(S.h * 0.2, S.h + 40) : S.h + r + rnd(0, 60), r,
                    vy: -rnd(16, 38) * (1.2 - r / 60), sway: rnd(10, 28), w: rnd(0.6, 1.4), phase: rnd(0, TAU),
                    hue: (Math.random() * 6) | 0, wob: rnd(0, TAU), ix: 0, iy: 0
                };
            },
            step(p, dt) {
                p.phase += p.w * dt;
                p.wob += 3 * dt;
                const ptr = S.pointer;
                if (performance.now() - ptr.at < 300 && Math.hypot(p.x - ptr.x, p.y - ptr.y) < p.r + 6) { pop(p); return false; }
                p.x += (Math.cos(p.phase) * p.sway * p.w + S.wind.now * 14) * dt;
                p.y += p.vy * dt;
                if (p.y < -p.r - 10) return false;
                if (p.y < S.h * 0.12 && Math.random() < dt * 0.5) { pop(p); return false; }
                return true;
            },
            draw(ctx, p) {
                const sx = 1 + Math.sin(p.wob) * 0.035, sy = 1 - Math.sin(p.wob) * 0.035;
                ctx.globalAlpha = 0.95;
                ctx.setTransform(S.dpr * sx, 0, 0, S.dpr * sy, p.x * S.dpr, p.y * S.dpr);
                ctx.drawImage(sprite("bubble" + p.hue, (d) => bubble(p.hue, d)), -p.r * 1.1, -p.r * 1.1, p.r * 2.2, p.r * 2.2);
            }
        }
    };

    function pop(p) {
        S.fx.push({ type: "ring", x: p.x, y: p.y, r: p.r, life: 0.28, age: 0 });
        for (let i = 0; i < 7; i++) {
            const a = (i / 7) * TAU + rnd(-0.2, 0.2);
            S.fx.push({ type: "drop", x: p.x + Math.cos(a) * p.r, y: p.y + Math.sin(a) * p.r, vx: Math.cos(a) * rnd(60, 130), vy: Math.sin(a) * rnd(60, 130), g: 260, life: rnd(0.25, 0.45), age: 0, size: rnd(1.2, 2.2) });
        }
    }

    function rainEngine(power) {
        return {
            count: () => Math.min(power > 1 ? 560 : 380, (area() / 2600) * power),
            make(fresh) {
                const z = rnd(0.5, 1.3);
                return { x: rnd(-60, S.w + 60), y: fresh ? rnd(-S.h, S.h) : rnd(-S.h * 0.3, -20), z, len: rnd(12, 22) * z, speed: rnd(620, 900) * (0.6 + z * 0.5), ground: S.h - rnd(0, S.h * 0.18) };
            },
            step(p, dt) {
                const vx = S.wind.now * 160 * p.z + 40;
                p.vx = vx;
                p.x += vx * dt;
                p.y += p.speed * dt;
                if (p.y >= p.ground) {
                    if (p.z > 0.85 && S.fx.length < 260) splash(p.x, p.ground, p.z);
                    return false;
                }
                return p.x > -80 && p.x < S.w + 80;
            },
            batch(ctx, items) {
                ctx.setTransform(S.dpr, 0, 0, S.dpr, 0, 0);
                ctx.lineCap = "round";
                const col = S.dark ? "190,210,240" : "80,110,150";
                [[0, 0.75, 0.9], [0.75, 1.05, 1.2], [1.05, 9, 1.6]].forEach(([z0, z1, lw]) => {
                    ctx.beginPath();
                    for (const p of items) {
                        if (p.z < z0 || p.z >= z1) continue;
                        const k = p.len / p.speed;
                        ctx.moveTo(p.x, p.y);
                        ctx.lineTo(p.x - p.vx * k, p.y - p.len);
                    }
                    ctx.globalAlpha = 1;
                    ctx.strokeStyle = `rgba(${col},${(S.dark ? 0.22 : 0.26) + z0 * 0.22})`;
                    ctx.lineWidth = lw;
                    ctx.stroke();
                });
            },
            extra: power > 1 ? stormExtra : null
        };
    }

    function splash(x, y, z) {
        S.fx.push({ type: "ripple", x, y, r: 0, life: 0.35, age: 0, z });
        for (let i = 0; i < 2; i++) {
            S.fx.push({ type: "drop", x, y, vx: rnd(-55, 55) + S.wind.now * 40, vy: -rnd(70, 140) * z, g: 900, life: rnd(0.25, 0.4), age: 0, size: rnd(1, 1.8) });
        }
    }

    function makeBolt() {
        const pts = [];
        let x = rnd(S.w * 0.15, S.w * 0.85), y = -10;
        const end = S.h * rnd(0.45, 0.8);
        const branches = [];
        pts.push([x, y]);
        while (y < end) {
            y += rnd(12, 30);
            x += rnd(-24, 24);
            pts.push([x, y]);
            if (Math.random() < 0.2) {
                const b = [[x, y]];
                let bx = x, by = y;
                const dir = Math.random() < 0.5 ? -1 : 1;
                for (let i = 0; i < 5; i++) { bx += dir * rnd(6, 22); by += rnd(10, 22); b.push([bx, by]); }
                branches.push(b);
            }
        }
        return { pts, branches };
    }

    function stormExtra(ctx) {
        const st = S.storm;
        if (S.t > st.next) {
            st.next = S.t + rnd(5, 13);
            st.boltAt = S.t;
            st.bolt = makeBolt();
        }
        const since = S.t - st.boltAt;
        if (!st.bolt || since > 0.7) return;
        // вспышка: два-три мерцания
        const flash = since < 0.08 ? 1 : since < 0.16 ? 0.25 : since < 0.24 ? 0.8 : Math.max(0, 1 - (since - 0.24) / 0.45) * 0.5;
        ctx.setTransform(S.dpr, 0, 0, S.dpr, 0, 0);
        ctx.globalAlpha = flash * (S.dark ? 0.28 : 0.4);
        ctx.fillStyle = S.dark ? "#c8d6ff" : "#ffffff";
        ctx.fillRect(0, 0, S.w, S.h);
        if (since < 0.35) {
            ctx.globalAlpha = Math.min(1, flash + 0.3);
            ctx.strokeStyle = S.dark ? "#eef3ff" : "#5d6c9c";
            ctx.shadowColor = S.dark ? "rgba(160,185,255,.95)" : "rgba(120,140,220,.6)";
            ctx.shadowBlur = 16;
            ctx.lineJoin = "round";
            const line = (pts, w) => { ctx.lineWidth = w; ctx.beginPath(); pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.stroke(); };
            line(st.bolt.pts, 2.4);
            st.bolt.branches.forEach((b) => line(b, 1.2));
            ctx.shadowBlur = 0;
        }
    }

    function drawFx(ctx, dt) {
        ctx.setTransform(S.dpr, 0, 0, S.dpr, 0, 0);
        let alive = 0;
        for (const f of S.fx) {
            f.age += dt;
            if (f.age >= f.life) continue;
            const t = f.age / f.life;
            if (f.type === "drop") {
                f.vy += f.g * dt; f.x += f.vx * dt; f.y += f.vy * dt;
                ctx.globalAlpha = (1 - t) * 0.7;
                ctx.fillStyle = S.kind === "bubbles" ? (S.dark ? "#cfe6ff" : "#7aa7d6") : (S.dark ? "#cfe0ff" : "#5f87b5");
                ctx.fillRect(f.x - f.size / 2, f.y - f.size / 2, f.size, f.size);
            } else if (f.type === "ripple") {
                ctx.globalAlpha = (1 - t) * 0.45;
                ctx.strokeStyle = S.dark ? "#cfe0ff" : "#5f87b5";
                ctx.lineWidth = 1;
                ctx.beginPath(); ctx.ellipse(f.x, f.y, 2 + t * 12 * f.z, 1 + t * 3 * f.z, 0, 0, TAU); ctx.stroke();
            } else if (f.type === "ring") {
                ctx.globalAlpha = (1 - t) * 0.7;
                ctx.strokeStyle = S.dark ? "rgba(220,240,255,1)" : "rgba(90,130,190,1)";
                ctx.lineWidth = 1.5 * (1 - t) + 0.5;
                ctx.beginPath(); ctx.arc(f.x, f.y, f.r * (1 + t * 0.6), 0, TAU); ctx.stroke();
            } else if (f.type === "meteor") {
                f.x += f.vx * dt; f.y += f.vy * dt;
                const sp = Math.hypot(f.vx, f.vy);
                const tx = f.x - (f.vx / sp) * f.len, ty = f.y - (f.vy / sp) * f.len;
                const a = Math.sin(t * Math.PI);
                const g = ctx.createLinearGradient(f.x, f.y, tx, ty);
                const col = S.dark ? "255,255,255" : "90,110,170";
                g.addColorStop(0, `rgba(${col},${a})`);
                g.addColorStop(1, `rgba(${col},0)`);
                ctx.globalAlpha = 1;
                ctx.strokeStyle = g;
                ctx.lineWidth = 2;
                ctx.lineCap = "round";
                ctx.beginPath(); ctx.moveTo(f.x, f.y); ctx.lineTo(tx, ty); ctx.stroke();
                ctx.fillStyle = `rgba(${col},${a})`;
                ctx.beginPath(); ctx.arc(f.x, f.y, 1.8, 0, TAU); ctx.fill();
            }
            S.fx[alive++] = f;
        }
        S.fx.length = alive;
    }

    /* ---- цикл ---- */

    function frame(now) {
        S.raf = requestAnimationFrame(frame);
        const dt = Math.min(0.05, (now - S.last) / 1000 || 0.016);
        S.last = now;
        S.t += dt;
        const eng = ENGINES[S.kind];
        if (!eng) return;
        stepWind(dt);
        const ctx = S.ctx;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalCompositeOperation = "source-over";
        ctx.clearRect(0, 0, S.canvas.width, S.canvas.height);
        const want = Math.round(eng.count() * S.density);
        let alive = 0;
        for (const p of S.items) { if (eng.step(p, dt)) S.items[alive++] = p; }
        S.items.length = alive;
        // недостающие появляются постепенно сверху (снизу — пузыри)
        let spawn = Math.min(want - S.items.length, Math.ceil(want * dt * 0.8) + 1);
        while (spawn-- > 0) S.items.push(eng.make(false));
        if (S.items.length > want) S.items.length = want;
        ctx.globalCompositeOperation = eng.composite ? eng.composite() : "source-over";
        if (eng.batch) eng.batch(ctx, S.items);
        else for (const p of S.items) eng.draw(ctx, p);
        ctx.globalCompositeOperation = "source-over";
        if (eng.extra) eng.extra(ctx, dt);
        drawFx(ctx, dt);
        ctx.globalAlpha = 1;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
    }

    function stop() {
        if (S.raf) cancelAnimationFrame(S.raf);
        S.raf = 0;
        if (S.canvas) { S.canvas.hidden = true; S.ctx.clearRect(0, 0, S.canvas.width, S.canvas.height); }
    }

    function refresh(reset) {
        const kind = chosenKind();
        const density = DENSITY[appSettings.atmosphereDensity] || 1;
        const dark = document.body.classList.contains("dark");
        if (kind !== S.kind || reset) { S.items = []; S.fx = []; }
        S.kind = kind;
        S.density = density;
        S.dark = dark;
        syncPicker();
        if (!active() || !ensureCanvas()) { stop(); return; }
        const eng = ENGINES[S.kind];
        if (!S.items.length) {
            const n = Math.round(eng.count() * S.density);
            for (let i = 0; i < n; i++) S.items.push(eng.make(true));
        }
        S.canvas.hidden = false;
        if (!S.raf) { S.last = performance.now(); S.raf = requestAnimationFrame(frame); }
    }

    document.addEventListener("visibilitychange", () => refresh());
    let resizeTimer = null;
    const soon = () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => refresh(), 150); };
    window.addEventListener("resize", soon);
    if (window.ResizeObserver && chatArea()) new ResizeObserver(soon).observe(chatArea());
    // смена темы (светлая/тёмная) — перерисовать спрайты в нужных цветах
    new MutationObserver(() => {
        const dark = document.body.classList.contains("dark");
        if (dark !== S.dark) refresh();
    }).observe(document.body, { attributes: true, attributeFilter: ["class"] });

    /* ---- выбор в настройках ---- */

    function buildPicker() {
        const host = document.getElementById("atmo-picker");
        if (!host || host.dataset.ready) return;
        host.dataset.ready = "1";
        host.innerHTML = `
            <div class="atmo-grid" role="radiogroup" aria-label="Атмосфера в чате">
                ${KINDS.map((k) => `<button type="button" class="atmo-chip" role="radio" data-kind="${k.id}">${ICONS[k.id]}<span>${k.label}</span></button>`).join("")}
            </div>
            <div class="atmo-density">
                <span>Интенсивность</span>
                <div class="atmo-seg" role="radiogroup" aria-label="Интенсивность">
                    <button type="button" role="radio" data-density="low">Меньше</button>
                    <button type="button" role="radio" data-density="mid">Средне</button>
                    <button type="button" role="radio" data-density="high">Больше</button>
                </div>
            </div>
            <div class="atmo-note" id="atmo-note"></div>`;
        host.addEventListener("click", (event) => {
            const chip = event.target.closest(".atmo-chip");
            const dens = event.target.closest("[data-density]");
            if (!chip && !dens) return;
            if (chip) appSettings.atmosphereKind = chip.dataset.kind;
            if (dens) appSettings.atmosphereDensity = dens.dataset.density;
            if (typeof saveSettings === "function") saveSettings();
            refresh(true);
        });
    }

    const SEASON_NAMES = { snow: "сейчас снег", sakura: "сейчас сакура", fireflies: "сейчас светлячки", leaves: "сейчас листопад" };

    function syncPicker() {
        const host = document.getElementById("atmo-picker");
        if (!host) return;
        buildPicker();
        host.hidden = appSettings.seasonalAtmosphere === false;
        const kind = appSettings.atmosphereKind || "auto";
        host.querySelectorAll(".atmo-chip").forEach((b) => {
            const on = b.dataset.kind === kind;
            b.classList.toggle("active", on);
            b.setAttribute("aria-checked", on ? "true" : "false");
        });
        const dens = appSettings.atmosphereDensity || "mid";
        host.querySelectorAll("[data-density]").forEach((b) => {
            const on = b.dataset.density === dens;
            b.classList.toggle("active", on);
            b.setAttribute("aria-checked", on ? "true" : "false");
        });
        const note = document.getElementById("atmo-note");
        if (note) {
            note.textContent = appSettings.reduceMotion
                ? "Сейчас не видно: включено «Уменьшить анимации»"
                : kind === "auto" ? `По сезону: ${SEASON_NAMES[seasonKind(new Date())]}. Курсор или палец раздувают листья и снег, пузыри от касания лопаются` : "Курсор или палец раздувают листья и снег, пузыри от касания лопаются";
        }
    }

    window.KabanAtmosphere = { refresh, kinds: KINDS.map((k) => k.id), _S: S, _sprites: () => buildLeafSprites() };
    refresh();
})();

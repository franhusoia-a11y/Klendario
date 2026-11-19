(() => {
  'use strict';

  /* =========================================================================
   * 1. CONSTANTES DE TELEMETRÍA Y PALETA
   * ========================================================================= */
  const IMPULSE_META = {
    flow:     { label: 'FLUJO',    color: '#00E5FF', rgb: [0, 229, 255],   pulseSpeed: 1.5, freq: 523.25 },
    friction: { label: 'FRICCIÓN', color: '#FF9500', rgb: [255, 149, 0],   pulseSpeed: 5.8, freq: 220.00 },
    mutation: { label: 'MUTACIÓN', color: '#B84DFF', rgb: [184, 77, 255],  pulseSpeed: 3.0, freq: 392.00 }
  };

  const GOLDEN_ANGLE = 2.399963229728653; // ~137.5° para distribución orgánica sin solapamientos

  /* =========================================================================
   * 2. SINTETIZADOR WEB AUDIO (Sin archivos externos)
   * ========================================================================= */
  class TelemetrySynth {
    constructor() {
      this.enabled = false;
      this.ctx = null;
    }

    toggle() {
      this.enabled = !this.enabled;
      if (this.enabled && !this.ctx) {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        this.ctx = new AudioCtx();
      }
      if (this.enabled) this.playPing(660, 0.08, 'sine', 0.05);
      return this.enabled;
    }

    playPing(freq = 440, duration = 0.22, wave = 'sine', gainPeak = 0.06) {
      if (!this.enabled || !this.ctx) return;
      if (this.ctx.state === 'suspended') this.ctx.resume();

      const now = this.ctx.currentTime;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();

      osc.type = wave;
      osc.frequency.setValueAtTime(freq, now);
      osc.frequency.exponentialRampToValueAtTime(freq * 1.02, now + duration);

      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(gainPeak, now + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);

      osc.connect(gain);
      gain.connect(this.ctx.destination);
      osc.start(now);
      osc.stop(now + duration + 0.02);
    }

    playNodeCreate(type) {
      const meta = IMPULSE_META[type] || IMPULSE_META.flow;
      this.playPing(meta.freq, 0.35, 'triangle', 0.055);
      setTimeout(() => this.playPing(meta.freq * 1.5, 0.25, 'sine', 0.03), 65);
    }

    playLinkCreate() {
      this.playPing(329.63, 0.3, 'sine', 0.045);
      setTimeout(() => this.playPing(493.88, 0.35, 'sine', 0.045), 70);
      setTimeout(() => this.playPing(659.25, 0.4, 'triangle', 0.03), 140);
    }

    playTick(ratio) {
      this.playPing(180 + ratio * 380, 0.04, 'sine', 0.02);
    }
  }

  /* =========================================================================
   * 3. CRYPTO VAULT (Cifrado AES-GCM en localStorage para el PAT)
   * ========================================================================= */
  const CryptoVault = {
    STORAGE_KEY: 'chrono_gh_vault_v1',
    KEY_MATERIAL: 'chrono_device_key_v1',

    async _getKey() {
      let rawJwk = localStorage.getItem(this.KEY_MATERIAL);
      if (rawJwk) {
        return crypto.subtle.importKey('jwk', JSON.parse(rawJwk), { name: 'AES-GCM' }, true, ['encrypt', 'decrypt']);
      }
      const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
      const exported = await crypto.subtle.exportKey('jwk', key);
      localStorage.setItem(this.KEY_MATERIAL, JSON.stringify(exported));
      return key;
    },

    async save(config) {
      const key = await this._getKey();
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const encoded = new TextEncoder().encode(JSON.stringify(config));
      const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded);

      const payload = {
        iv: Array.from(iv),
        data: Array.from(new Uint8Array(cipher))
      };
      localStorage.setItem(this.STORAGE_KEY, JSON.stringify(payload));
    },

    async load() {
      const raw = localStorage.getItem(this.STORAGE_KEY);
      if (!raw) return null;
      try {
        const key = await this._getKey();
        const payload = JSON.parse(raw);
        const iv = new Uint8Array(payload.iv);
        const data = new Uint8Array(payload.data);
        const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, data);
        return JSON.parse(new TextDecoder().decode(decrypted));
      } catch {
        return null;
      }
    },

    clear() {
      localStorage.removeItem(this.STORAGE_KEY);
    }
  };

  /* =========================================================================
   * 4. GITHUB REST API SYNC (Commits silenciosos a log.json)
   * ========================================================================= */
  function utf8ToBase64(str) {
    const bytes = new TextEncoder().encode(str);
    let binary = '';
    bytes.forEach((b) => { binary += String.fromCharCode(b); });
    return btoa(binary);
  }

  function base64ToUtf8(b64) {
    const binary = atob(b64.replace(/\n/g, ''));
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  }

  class GitHubSync {
    constructor(onStatusChange) {
      this.config = null;
      this.fileSha = null;
      this.queue = Promise.resolve();
      this.onStatusChange = onStatusChange;
    }

    setConfig(cfg) {
      this.config = cfg;
      this.fileSha = null;
      this.onStatusChange(cfg ? 'CONECTADO' : 'LECTURA');
    }

    async fetchLog() {
      // Si hay credenciales, leer desde la API para evitar caché de GitHub Pages
      if (this.config) {
        const { repo, branch, token } = this.config;
        const url = `https://api.github.com/repos/${repo}/contents/log.json?ref=${encodeURIComponent(branch)}`;
        const res = await fetch(url, {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json'
          }
        });
        if (res.ok) {
          const json = await res.json();
          this.fileSha = json.sha;
          return JSON.parse(base64ToUtf8(json.content));
        }
      }

      // Modo Lectura Pública: leer ./log.json relativo
      const res = await fetch(`./log.json?t=${Date.now()}`);
      if (!res.ok) {
        return { project: 'CHRONOGRAPH // 01', nodes: [], links: [] };
      }
      return res.json();
    }

    commit(data, message) {
      if (!this.config) {
        this.onStatusChange('LOCAL (SIN PAT)');
        return Promise.resolve(false);
      }

      this.queue = this.queue.then(async () => {
        this.onStatusChange('SYNC...');
        const { repo, branch, token } = this.config;
        const url = `https://api.github.com/repos/${repo}/contents/log.json`;
        const headers = {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json'
        };

        try {
          // Asegurar el último SHA antes de escribir
          if (!this.fileSha) {
            const getRes = await fetch(`${url}?ref=${encodeURIComponent(branch)}`, { headers });
            if (getRes.ok) {
              const meta = await getRes.json();
              this.fileSha = meta.sha;
            }
          }

          const body = {
            message,
            content: utf8ToBase64(JSON.stringify(data, null, 2)),
            branch
          };
          if (this.fileSha) body.sha = this.fileSha;

          const putRes = await fetch(url, {
            method: 'PUT',
            headers,
            body: JSON.stringify(body)
          });

          if (!putRes.ok) {
            const err = await putRes.json().catch(() => ({}));
            throw new Error(err.message || `HTTP ${putRes.status}`);
          }

          const result = await putRes.json();
          this.fileSha = result.content.sha;
          this.onStatusChange('GUARDADO ✓');
          setTimeout(() => {
            if (this.config) this.onStatusChange('CONECTADO');
          }, 2200);
          return true;
        } catch (err) {
          console.error('[GitHubSync]', err);
          this.fileSha = null;
          this.onStatusChange('ERROR SYNC');
          return false;
        }
      });

      return this.queue;
    }
  }

  /* =========================================================================
   * 5. MOTOR DEL CRONÓGRAFO TOPOGRÁFICO (HTML5 Canvas)
   * ========================================================================= */
  class ChronographEngine {
    constructor(canvas, callbacks) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.callbacks = callbacks;

      this.nodes = [];
      this.links = [];
      this.visibleCount = 0;

      // Cámara (paneo y zoom suave)
      this.cam = { x: 0, y: 0, zoom: 1, targetZoom: 1 };
      this.drag = { active: false, moved: false, startX: 0, startY: 0, camX: 0, camY: 0 };

      this.hoveredId = null;
      this.selectedId = null;
      this.linkSourceId = null;
      this.mouseWorld = { x: 0, y: 0 };

      this.time = 0;
      this._bindEvents();
      this.resize();
      this._loop();
    }

    setData(nodes, links) {
      // Preservar posiciones animadas existentes
      const prevMap = new Map(this.nodes.map((n) => [n.id, n]));
      this.nodes = nodes.map((n, idx) => {
        const prev = prevMap.get(n.id);
        const angle = idx * GOLDEN_ANGLE;
        return {
          ...n,
          angle,
          currentR: prev ? prev.currentR : 20,
          targetR: 90,
          x: prev ? prev.x : Math.cos(angle) * 20,
          y: prev ? prev.y : Math.sin(angle) * 20
        };
      });
      this.links = links;
      this.setVisibleCount(this.nodes.length);
    }

    setVisibleCount(count) {
      this.visibleCount = Math.max(0, Math.min(count, this.nodes.length));
      for (let i = 0; i < this.nodes.length; i++) {
        const node = this.nodes[i];
        if (i < this.visibleCount) {
          const age = (this.visibleCount - 1) - i;
          // Órbita más reciente cerca del núcleo; antiguas se expanden hacia afuera
          node.targetR = 92 + Math.pow(age, 0.88) * 46;
        } else {
          // Nodos futuros se contraen hacia el núcleo al viajar al pasado
          node.targetR = 0;
        }
      }
    }

    centerView() {
      this.cam.x = 0;
      this.cam.y = 0;
      this.cam.targetZoom = 1;
    }

    resize() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      this.width = window.innerWidth;
      this.height = window.innerHeight;
      this.canvas.width = this.width * dpr;
      this.canvas.height = this.height * dpr;
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    screenToWorld(sx, sy) {
      return {
        x: (sx - this.width / 2) / this.cam.zoom - this.cam.x,
        y: (sy - this.height / 2) / this.cam.zoom - this.cam.y
      };
    }

    _hitTest(wx, wy) {
      const hitRadius = 18 / this.cam.zoom;
      for (let i = this.visibleCount - 1; i >= 0; i--) {
        const n = this.nodes[i];
        const dx = wx - n.x;
        const dy = wy - n.y;
        if (dx * dx + dy * dy <= hitRadius * hitRadius) {
          return n;
        }
      }
      return null;
    }

    _bindEvents() {
      window.addEventListener('resize', () => this.resize());

      this.canvas.addEventListener('mousedown', (e) => {
        this.drag.active = true;
        this.drag.moved = false;
        this.drag.startX = e.clientX;
        this.drag.startY = e.clientY;
        this.drag.camX = this.cam.x;
        this.drag.camY = this.cam.y;
      });

      window.addEventListener('mousemove', (e) => {
        const w = this.screenToWorld(e.clientX, e.clientY);
        this.mouseWorld = w;

        if (this.drag.active) {
          const dx = e.clientX - this.drag.startX;
          const dy = e.clientY - this.drag.startY;
          if (Math.hypot(dx, dy) > 4) this.drag.moved = true;
          this.cam.x = this.drag.camX + dx / this.cam.zoom;
          this.cam.y = this.drag.camY + dy / this.cam.zoom;
          return;
        }

        const hit = this._hitTest(w.x, w.y);
        this.hoveredId = hit ? hit.id : null;
        this.canvas.style.cursor = hit ? 'pointer' : 'grab';
      });

      window.addEventListener('mouseup', (e) => {
        if (!this.drag.active) return;
        this.drag.active = false;
        if (this.drag.moved) return;

        const w = this.screenToWorld(e.clientX, e.clientY);
        const hit = this._hitTest(w.x, w.y);

        if (hit) {
          // Shift+Clic o Modo Enlace activo -> crear hilo de causalidad
          if (this.linkSourceId && this.linkSourceId !== hit.id) {
            this.callbacks.onLink(this.linkSourceId, hit.id);
            this.linkSourceId = null;
            return;
          }
          if (e.shiftKey && this.selectedId && this.selectedId !== hit.id) {
            this.callbacks.onLink(this.selectedId, hit.id);
            return;
          }
          this.selectedId = hit.id;
          this.callbacks.onSelect(hit);
        } else {
          this.selectedId = null;
          this.linkSourceId = null;
          this.callbacks.onSelect(null);
        }
      });

      this.canvas.addEventListener('wheel', (e) => {
        e.preventDefault();
        const factor = e.deltaY < 0 ? 1.12 : 0.89;
        this.cam.targetZoom = Math.max(0.28, Math.min(2.8, this.cam.targetZoom * factor));
      }, { passive: false });
    }

    _drawTopography(ctx) {
      const step = 64;
      const halfW = this.width / 2 / this.cam.zoom;
      const halfH = this.height / 2 / this.cam.zoom;
      const startX = Math.floor((-this.cam.x - halfW) / step) * step;
      const endX = Math.ceil((-this.cam.x + halfW) / step) * step;
      const startY = Math.floor((-this.cam.y - halfH) / step) * step;
      const endY = Math.ceil((-this.cam.y + halfH) / step) * step;

      // Cuadrícula sutil de coordenadas
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.025)';
      ctx.lineWidth = 1 / this.cam.zoom;
      ctx.beginPath();
      for (let x = startX; x <= endX; x += step) {
        ctx.moveTo(x, startY);
        ctx.lineTo(x, endY);
      }
      for (let y = startY; y <= endY; y += step) {
        ctx.moveTo(startX, y);
        ctx.lineTo(endX, y);
      }
      ctx.stroke();

      // Ejes cardinales cruzando el núcleo
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
      ctx.beginPath();
      ctx.moveTo(-2000, 0); ctx.lineTo(2000, 0);
      ctx.moveTo(0, -2000); ctx.lineTo(0, 2000);
      ctx.stroke();

      // Anillos topográficos orbitales
      const maxRings = Math.max(5, Math.ceil(this.visibleCount / 2) + 2);
      ctx.font = `${9 / this.cam.zoom}px JetBrains Mono, monospace`;
      ctx.fillStyle = 'rgba(111, 122, 138, 0.35)';

      for (let r = 1; r <= maxRings; r++) {
        const radius = r * 92;
        ctx.strokeStyle = r === 1 ? 'rgba(255, 255, 255, 0.08)' : 'rgba(255, 255, 255, 0.035)';
        ctx.setLineDash(r % 2 === 0 ? [3 / this.cam.zoom, 6 / this.cam.zoom] : []);
        ctx.beginPath();
        ctx.arc(0, 0, radius, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fillText(`ORB-0${r}`, 6 / this.cam.zoom, -radius - 4 / this.cam.zoom);
      }
      ctx.setLineDash([]);
    }

    _drawLinks(ctx, visibleMap) {
      for (const link of this.links) {
        const a = visibleMap.get(link.from);
        const b = visibleMap.get(link.to);
        if (!a || !b) continue;

        const metaB = IMPULSE_META[b.type] || IMPULSE_META.flow;
        const midX = (a.x + b.x) / 2;
        const midY = (a.y + b.y) / 2;
        // Curvatura suave hacia afuera del origen
        const cx = midX * 1.12;
        const cy = midY * 1.12;

        const isHighlighted = this.selectedId === a.id || this.selectedId === b.id;
        ctx.strokeStyle = isHighlighted
          ? `rgba(${metaB.rgb.join(',')}, 0.85)`
          : `rgba(${metaB.rgb.join(',')}, 0.32)`;
        ctx.lineWidth = (isHighlighted ? 2 : 1.2) / this.cam.zoom;

        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.quadraticCurveTo(cx, cy, b.x, b.y);
        ctx.stroke();

        // Pulso luminoso viajando por el hilo de causalidad
        const t = (this.time * 0.45) % 1;
        const px = (1 - t) * (1 - t) * a.x + 2 * (1 - t) * t * cx + t * t * b.x;
        const py = (1 - t) * (1 - t) * a.y + 2 * (1 - t) * t * cy + t * t * b.y;
        ctx.fillStyle = metaB.color;
        ctx.beginPath();
        ctx.arc(px, py, 2.2 / this.cam.zoom, 0, Math.PI * 2);
        ctx.fill();
      }

      // Hilo en construcción (modo causalidad)
      if (this.linkSourceId && visibleMap.has(this.linkSourceId)) {
        const src = visibleMap.get(this.linkSourceId);
        ctx.strokeStyle = 'rgba(184, 77, 255, 0.75)';
        ctx.lineWidth = 1.4 / this.cam.zoom;
        ctx.setLineDash([5 / this.cam.zoom, 5 / this.cam.zoom]);
        ctx.beginPath();
        ctx.moveTo(src.x, src.y);
        ctx.lineTo(this.mouseWorld.x, this.mouseWorld.y);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    _drawCore(ctx) {
      const latest = this.visibleCount > 0 ? this.nodes[this.visibleCount - 1] : null;
      const meta = latest ? (IMPULSE_META[latest.type] || IMPULSE_META.flow) : { color: '#E6EBF2', rgb: [230, 235, 242], pulseSpeed: 1.2 };

      const pulse = (Math.sin(this.time * meta.pulseSpeed) + 1) / 2;
      const baseR = 16;

      // Halo exterior pulsante
      const grad = ctx.createRadialGradient(0, 0, 4, 0, 0, baseR + 26 + pulse * 18);
      grad.addColorStop(0, `rgba(${meta.rgb.join(',')}, ${0.42 + pulse * 0.2})`);
      grad.addColorStop(1, `rgba(${meta.rgb.join(',')}, 0)`);
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(0, 0, baseR + 26 + pulse * 18, 0, Math.PI * 2);
      ctx.fill();

      // Anillo técnico
      ctx.strokeStyle = meta.color;
      ctx.lineWidth = 1.5 / this.cam.zoom;
      ctx.beginPath();
      ctx.arc(0, 0, baseR + pulse * 4, 0, Math.PI * 2);
      ctx.stroke();

      // Núcleo sólido
      ctx.fillStyle = meta.color;
      ctx.beginPath();
      ctx.arc(0, 0, 6.5, 0, Math.PI * 2);
      ctx.fill();
    }

    _drawNodes(ctx) {
      const visibleMap = new Map();

      for (let i = 0; i < this.nodes.length; i++) {
        const n = this.nodes[i];
        // Interpolación orgánica de radio (expansión/contracción en Rayos X)
        n.currentR += (n.targetR - n.currentR) * 0.12;
        n.x = Math.cos(n.angle) * n.currentR;
        n.y = Math.sin(n.angle) * n.currentR;

        if (i >= this.visibleCount) continue;
        visibleMap.set(n.id, n);
      }

      this._drawLinks(ctx, visibleMap);

      for (let i = 0; i < this.visibleCount; i++) {
        const n = this.nodes[i];
        const age = (this.visibleCount - 1) - i;
        const coolness = Math.min(1, age / Math.max(8, this.visibleCount));
        const meta = IMPULSE_META[n.type] || IMPULSE_META.flow;

        const isSelected = n.id === this.selectedId;
        const isHovered = n.id === this.hoveredId;
        const alpha = isSelected || isHovered ? 1 : Math.max(0.32, 1 - coolness * 0.65);

        // Enfriamiento cromático gradual hacia gris pizarra con la antigüedad
        const r = Math.round(meta.rgb[0] * (1 - coolness * 0.45) + 90 * (coolness * 0.45));
        const g = Math.round(meta.rgb[1] * (1 - coolness * 0.45) + 105 * (coolness * 0.45));
        const b = Math.round(meta.rgb[2] * (1 - coolness * 0.45) + 125 * (coolness * 0.45));
        const nodeColor = `rgba(${r},${g},${b},${alpha})`;

        // Retícula de selección / hover
        if (isSelected || isHovered) {
          ctx.strokeStyle = meta.color;
          ctx.lineWidth = 1.2 / this.cam.zoom;
          ctx.beginPath();
          ctx.arc(n.x, n.y, 13, 0, Math.PI * 2);
          ctx.stroke();
        }

        // Cuerpo del nodo
        const radius = age === 0 ? 7.5 : 5.5;
        ctx.fillStyle = nodeColor;
        ctx.beginPath();
        ctx.arc(n.x, n.y, radius, 0, Math.PI * 2);
        ctx.fill();

        // Etiqueta compacta junto al nodo
        if (this.cam.zoom > 0.55 || isHovered || isSelected || age < 3) {
          const snippet = n.text.length > 34 ? `${n.text.slice(0, 34)}…` : n.text;
          ctx.font = `${10 / this.cam.zoom}px JetBrains Mono, monospace`;
          ctx.fillStyle = isHovered || isSelected ? '#FFFFFF' : `rgba(230, 235, 242, ${alpha * 0.78})`;
          ctx.fillText(snippet, n.x + 12 / this.cam.zoom, n.y + 3 / this.cam.zoom);
        }
      }
    }

    _loop() {
      this.time += 0.016;
      this.cam.zoom += (this.cam.targetZoom - this.cam.zoom) * 0.14;

      const ctx = this.ctx;
      ctx.clearRect(0, 0, this.width, this.height);

      ctx.save();
      ctx.translate(this.width / 2, this.height / 2);
      ctx.scale(this.cam.zoom, this.cam.zoom);
      ctx.translate(this.cam.x, this.cam.y);

      this._drawTopography(ctx);
      this._drawNodes(ctx);
      this._drawCore(ctx);

      ctx.restore();
      requestAnimationFrame(() => this._loop());
    }
  }

  /* =========================================================================
   * 6. ORQUESTACIÓN PRINCIPAL DE LA APLICACIÓN
   * ========================================================================= */
  const synth = new TelemetrySynth();
  let appData = { project: 'CHRONOGRAPH // 01', nodes: [], links: [] };
  let activeType = 'flow';

  const els = {
    canvas: document.getElementById('chronograph'),
    projectTitle: document.getElementById('projectTitle'),
    coreLed: document.getElementById('coreLed'),
    statNodes: document.getElementById('statNodes'),
    statLinks: document.getElementById('statLinks'),
    statState: document.getElementById('statState'),
    statSync: document.getElementById('statSync'),
    btnAudio: document.getElementById('btnAudio'),
    audioDot: document.getElementById('audioDot'),
    btnCenter: document.getElementById('btnCenter'),
    btnConfig: document.getElementById('btnConfig'),
    inspector: document.getElementById('inspector'),
    insType: document.getElementById('insType'),
    insTime: document.getElementById('insTime'),
    insText: document.getElementById('insText'),
    insClose: document.getElementById('insClose'),
    btnLinkMode: document.getElementById('btnLinkMode'),
    linkBanner: document.getElementById('linkBanner'),
    xraySlider: document.getElementById('xraySlider'),
    xrayReadout: document.getElementById('xrayReadout'),
    cmdForm: document.getElementById('cmdForm'),
    cmdInput: document.getElementById('cmdInput'),
    modePills: document.querySelectorAll('.mode-pill'),
    configModal: document.getElementById('configModal'),
    configForm: document.getElementById('configForm'),
    cfgRepo: document.getElementById('cfgRepo'),
    cfgBranch: document.getElementById('cfgBranch'),
    cfgToken: document.getElementById('cfgToken'),
    modalClose: document.getElementById('modalClose'),
    btnClearConfig: document.getElementById('btnClearConfig')
  };

  const ghSync = new GitHubSync((status) => {
    els.statSync.textContent = status;
  });

  const engine = new ChronographEngine(els.canvas, {
    onSelect(node) {
      if (!node) {
        els.inspector.classList.add('hidden');
        els.linkBanner.classList.add('hidden');
        return;
      }
      const meta = IMPULSE_META[node.type] || IMPULSE_META.flow;
      els.insType.textContent = meta.label;
      els.insType.style.color = meta.color;
      els.insTime.textContent = new Date(node.timestamp).toLocaleString('es-AR', {
        day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'
      });
      els.insText.textContent = node.text;
      els.inspector.classList.remove('hidden');
    },

    onLink(fromId, toId) {
      const exists = appData.links.some(
        (l) => (l.from === fromId && l.to === toId) || (l.from === toId && l.to === fromId)
      );
      if (exists) return;

      appData.links.push({ from: fromId, to: toId });
      els.linkBanner.classList.add('hidden');
      synth.playLinkCreate();
      refreshUI();
      ghSync.commit(appData, `telemetry(link): ${fromId} -> ${toId}`);
    }
  });

  function setImpulseMode(type) {
    activeType = type;
    els.modePills.forEach((p) => p.classList.toggle('active', p.dataset.type === type));
  }

  function refreshUI(preserveSlider = false) {
    els.projectTitle.textContent = appData.project || 'CHRONOGRAPH // 01';
    engine.setData(appData.nodes, appData.links);

    const total = appData.nodes.length;
    els.xraySlider.max = total;
    if (!preserveSlider) {
      els.xraySlider.value = total;
    }
    const vis = Number(els.xraySlider.value);
    engine.setVisibleCount(vis);
    updateTelemetryReadout(vis);
  }

  function updateTelemetryReadout(visibleCount) {
    const total = appData.nodes.length;
    els.statNodes.textContent = String(visibleCount).padStart(3, '0');
    els.statLinks.textContent = String(appData.links.length).padStart(3, '0');

    const latest = visibleCount > 0 ? appData.nodes[visibleCount - 1] : null;
    const meta = latest ? IMPULSE_META[latest.type] : { label: 'INACTIVO', color: '#E6EBF2' };
    els.statState.textContent = meta.label;
    els.statState.style.color = meta.color;
    els.coreLed.style.background = meta.color;
    els.coreLed.style.boxShadow = `0 0 10px ${meta.color}`;

    const pct = total === 0 ? 100 : Math.round((visibleCount / total) * 100);
    const delta = total - visibleCount;
    els.xrayReadout.textContent = `${pct}% [T-${delta}]`;
  }

  /* Eventos de Interfaz */
  els.modePills.forEach((pill) => {
    pill.addEventListener('click', () => setImpulseMode(pill.dataset.type));
  });

  els.cmdForm.addEventListener('submit', (e) => {
    e.preventDefault();
    let raw = els.cmdInput.value.trim();
    if (!raw) return;

    // Prefijos rápidos opcionales: /f (flujo), /b (fricción/bloqueo), /m (mutación)
    let type = activeType;
    if (raw.startsWith('/f ')) { type = 'flow'; raw = raw.slice(3).trim(); }
    else if (raw.startsWith('/b ')) { type = 'friction'; raw = raw.slice(3).trim(); }
    else if (raw.startsWith('/m ')) { type = 'mutation'; raw = raw.slice(3).trim(); }

    if (!raw) return;

    const newNode = {
      id: `n-${Date.now().toString(36)}`,
      type,
      text: raw,
      timestamp: new Date().toISOString()
    };

    appData.nodes.push(newNode);
    els.cmdInput.value = '';
    setImpulseMode(type);
    synth.playNodeCreate(type);
    refreshUI(false);

    const shortMsg = raw.length > 50 ? `${raw.slice(0, 50)}...` : raw;
    ghSync.commit(appData, `telemetry(${type}): ${shortMsg}`);
  });

  els.xraySlider.addEventListener('input', (e) => {
    const val = Number(e.target.value);
    const max = Math.max(1, Number(e.target.max));
    engine.setVisibleCount(val);
    updateTelemetryReadout(val);
    synth.playTick(val / max);
  });

  els.btnAudio.addEventListener('click', () => {
    const on = synth.toggle();
    els.audioDot.classList.toggle('on', on);
  });

  els.btnCenter.addEventListener('click', () => engine.centerView());
  els.insClose.addEventListener('click', () => {
    engine.selectedId = null;
    els.inspector.classList.add('hidden');
  });

  els.btnLinkMode.addEventListener('click', () => {
    if (!engine.selectedId) return;
    engine.linkSourceId = engine.selectedId;
    els.linkBanner.classList.remove('hidden');
  });

  /* Modal de Configuración GitHub */
  els.btnConfig.addEventListener('click', () => {
    if (ghSync.config) {
      els.cfgRepo.value = ghSync.config.repo;
      els.cfgBranch.value = ghSync.config.branch;
      els.cfgToken.value = ghSync.config.token;
    }
    els.configModal.classList.remove('hidden');
  });

  els.modalClose.addEventListener('click', () => els.configModal.classList.add('hidden'));

  els.configForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const cfg = {
      repo: els.cfgRepo.value.trim(),
      branch: els.cfgBranch.value.trim() || 'main',
      token: els.cfgToken.value.trim()
    };
    await CryptoVault.save(cfg);
    ghSync.setConfig(cfg);
    els.configModal.classList.add('hidden');

    appData = await ghSync.fetchLog();
    refreshUI(false);
  });

  els.btnClearConfig.addEventListener('click', async () => {
    CryptoVault.clear();
    ghSync.setConfig(null);
    els.cfgToken.value = '';
    els.configModal.classList.add('hidden');
    appData = await ghSync.fetchLog();
    refreshUI(false);
  });

  /* Atajos de Teclado */
  window.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      els.cmdInput.focus();
    } else if (e.key === 'Escape') {
      engine.linkSourceId = null;
      els.linkBanner.classList.add('hidden');
      els.configModal.classList.add('hidden');
      els.cmdInput.blur();
    } else if (e.altKey && e.key === '1') {
      setImpulseMode('flow');
    } else if (e.altKey && e.key === '2') {
      setImpulseMode('friction');
    } else if (e.altKey && e.key === '3') {
      setImpulseMode('mutation');
    } else if (e.key.toLowerCase() === 'c' && document.activeElement !== els.cmdInput && document.activeElement.tagName !== 'INPUT') {
      engine.centerView();
    }
  });

  /* Inicialización */
  (async function init() {
    const saved = await CryptoVault.load();
    if (saved) ghSync.setConfig(saved);
    appData = await ghSync.fetchLog();
    refreshUI(false);
  })();
})();

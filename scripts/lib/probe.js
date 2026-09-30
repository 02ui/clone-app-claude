// probe.js — runs INSIDE the page (injected with page.addScriptTag).
// Exposes window.__cloneProbe with four functions: stamp, collect, readProps, triggers.
//
// Element identity ("cid"): every element on the ORIGINAL site gets a data-cid built
// from a hash of its DOM path. The builder copies that data-cid onto the matching
// element in the clone. compare.mjs then pairs original and clone elements by cid,
// so the gate compares the clone to the ORIGINAL, not to a token list.
(() => {
  const SKIP = new Set(['SCRIPT', 'STYLE', 'LINK', 'META', 'HEAD', 'NOSCRIPT', 'TEMPLATE', 'BR', 'WBR', 'TITLE', 'BASE']);
  const MEDIA = new Set(['IMG', 'SVG', 'VIDEO', 'CANVAS', 'PICTURE', 'IFRAME', 'HR', 'INPUT', 'SELECT', 'TEXTAREA']);
  const INTERACTIVE = 'a[href],button,input,select,textarea,summary,[role=button],[role=tab],[role=menuitem],' +
    '[role=checkbox],[role=switch],[role=option],[role=link],[role=combobox],[aria-haspopup],[aria-expanded],' +
    '[tabindex]:not([tabindex="-1"]),[contenteditable=""],[contenteditable=true]';

  // Every property the gate compares. Per-side longhands, never shorthands.
  const PROPS = [
    'color', 'backgroundColor', 'backgroundImage', 'backgroundSize', 'backgroundPosition', 'opacity',
    'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'lineHeight', 'letterSpacing', 'textTransform',
    'textDecorationLine', 'textAlign', 'whiteSpace',
    'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
    'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
    'borderTopStyle', 'borderRightStyle', 'borderBottomStyle', 'borderLeftStyle',
    'borderTopColor', 'borderRightColor', 'borderBottomColor', 'borderLeftColor',
    'borderTopLeftRadius', 'borderTopRightRadius', 'borderBottomRightRadius', 'borderBottomLeftRadius',
    'boxShadow', 'outlineStyle', 'outlineWidth', 'outlineColor', 'filter', 'backdropFilter',
    'display', 'flexDirection', 'justifyContent', 'alignItems', 'rowGap', 'columnGap',
    'cursor', 'transitionDuration', 'transitionTimingFunction',
  ];
  // Properties that usually change on :hover.
  const HOVER_PROPS = [
    'color', 'backgroundColor', 'backgroundImage', 'borderTopColor', 'borderBottomColor', 'boxShadow',
    'opacity', 'textDecorationLine', 'transform', 'filter', 'outlineStyle', 'outlineColor',
  ];

  function hash(s, seed) {
    let h = seed >>> 0;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return (h >>> 0).toString(16).padStart(8, '0');
  }
  function pathOf(el) {
    const parts = [];
    for (let n = el; n && n.nodeType === 1 && n !== document.body; n = n.parentElement) {
      let i = 1;
      for (let s = n.previousElementSibling; s; s = s.previousElementSibling) if (s.tagName === n.tagName) i++;
      parts.push(n.tagName.toLowerCase() + ':' + i);
    }
    return parts.reverse().join('/');
  }
  function cidFor(el) {
    const p = pathOf(el);
    return el.tagName.toLowerCase() + '-' + (hash(p, 0x811c9dc5) + hash(p, 0x9e3779b9)).slice(0, 12);
  }
  function inSvg(el) { return el.tagName !== 'svg' && el.closest('svg') !== null; }
  function visible(el, cs) {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden' && parseFloat(cs.opacity) > 0;
  }
  function ownText(el) {
    let t = '';
    for (const n of el.childNodes) if (n.nodeType === 3) t += n.textContent;
    return t.replace(/\s+/g, ' ').trim();
  }
  function alpha(c) {
    if (!c || c === 'transparent') return 0;
    const m = c.match(/rgba?\(([^)]+)\)/);
    if (!m) return 1;
    const parts = m[1].split(/[\s,/]+/).filter(Boolean);
    return parts.length > 3 ? parseFloat(parts[3]) : 1;
  }
  function painted(cs) {
    if (alpha(cs.backgroundColor) > 0 || cs.backgroundImage !== 'none' || cs.boxShadow !== 'none') return true;
    for (const s of ['Top', 'Right', 'Bottom', 'Left']) {
      if (parseFloat(cs['border' + s + 'Width']) > 0 && cs['border' + s + 'Style'] !== 'none' && alpha(cs['border' + s + 'Color']) > 0) return true;
    }
    return false;
  }
  function readProps(el, list) {
    const cs = getComputedStyle(el);
    const out = {};
    for (const p of list || PROPS) out[p] = cs[p];
    return out;
  }
  function mask(text, redact) {
    if (!redact) return text;
    return text.replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, 'name@example.com').replace(/\+?\d[\d\s().-]{7,}\d/g, '000 000 0000');
  }

  // Give every element on the ORIGINAL a path-based data-cid. Never runs on the clone.
  function stamp() {
    document.body.setAttribute('data-cid', 'body');
    let n = 0;
    for (const el of document.body.querySelectorAll('*')) {
      if (SKIP.has(el.tagName) || inSvg(el) || el.hasAttribute('data-cid')) continue;
      el.setAttribute('data-cid', cidFor(el));
      n++;
    }
    return n;
  }

  // side 'original': return the meaningful, visible elements (repeated siblings trimmed to 2).
  // side 'clone': return every visible element that carries an authored data-cid.
  function collect(side, redact) {
    const sx = window.scrollX, sy = window.scrollY;
    const groups = new Map();
    const out = [];
    for (const el of document.querySelectorAll('[data-cid]')) {
      if (SKIP.has(el.tagName) || inSvg(el)) continue;
      const cs = getComputedStyle(el);
      if (!visible(el, cs)) continue;
      const text = ownText(el);
      const interactive = el.matches(INTERACTIVE);
      if (side === 'original' && el !== document.body &&
          !(text || interactive || MEDIA.has(el.tagName.toUpperCase()) || painted(cs))) continue;
      const rec = {
        cid: el.getAttribute('data-cid'),
        tag: el.tagName.toLowerCase(),
        text: mask(text.slice(0, 80), redact),
        interactive,
      };
      if (side === 'original' && el.parentElement) {
        // Trim long repeated lists: keep the first 2 siblings that look identical.
        const key = (el.parentElement.getAttribute('data-cid') || '') + '|' + rec.tag + '|' +
          [...el.classList].sort().join('.') + '|' + cs.fontSize + cs.backgroundColor + cs.color;
        const g = groups.get(key);
        if (g) { g.repeat++; if (g.repeat > 2) continue; } else groups.set(key, rec);
        rec.repeat = 1;
      }
      const r = el.getBoundingClientRect();
      rec.rect = { x: Math.round((r.left + sx) * 10) / 10, y: Math.round((r.top + sy) * 10) / 10,
        w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10 };
      rec.styles = readProps(el);
      out.push(rec);
    }
    return {
      viewport: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio },
      scroll: { w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight },
      url: location.href,
      elements: out,
    };
  }

  // Candidate triggers for the interaction sweep. Links are returned as routes, never clicked.
  function triggers(denySource) {
    const deny = new RegExp(denySource, 'i');
    const found = [], links = new Set();
    for (const a of document.querySelectorAll('a[href]')) {
      try {
        const u = new URL(a.href, location.href);
        if (u.origin === location.origin) links.add(u.pathname);
      } catch {}
    }
    const sel = '[aria-haspopup]:not([aria-haspopup=false]),[aria-expanded],[role=tab],[role=combobox],summary,' +
      'button:not([type=submit]),[role=button],[contenteditable=""],[contenteditable=true],textarea,' +
      'input[type=text],input[type=search],input:not([type])';
    for (const el of document.querySelectorAll(sel)) {
      const cs = getComputedStyle(el);
      if (!visible(el, cs) || el.closest('a[href]') || el.closest('form') && el.tagName === 'BUTTON') continue;
      const name = (el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || el.getAttribute('placeholder') || '')
        .replace(/\s+/g, ' ').trim().slice(0, 60);
      if (deny.test(name)) continue;
      const editable = el.isContentEditable || el.tagName === 'TEXTAREA' || el.tagName === 'INPUT';
      found.push({ cid: el.getAttribute('data-cid'), tag: el.tagName.toLowerCase(), name, action: editable ? 'focus' : 'click' });
    }
    return { triggers: found, links: [...links] };
  }

  // A cheap fingerprint of what is on screen, to detect whether an action changed the view.
  function signature() {
    let n = 0, s = '';
    for (const el of document.querySelectorAll('[data-cid]')) {
      const cs = getComputedStyle(el);
      if (visible(el, cs)) { n++; if (n % 7 === 0) s += el.getAttribute('data-cid'); }
    }
    return location.pathname + '|' + n + '|' + hash(s, 1);
  }

  window.__cloneProbe = { stamp, collect, readProps, triggers, signature, PROPS, HOVER_PROPS };
})();

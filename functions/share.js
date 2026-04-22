/**
 * OKN Studio — Share Card endpoint
 * ================================
 * A parametric, edge-rendered social-preview card served at /share.
 *
 * Each page of the studio can surface its own title, subtitle, accent
 * tone, and module chips without any build step or committed binaries.
 *
 *   GET /share
 *     ?title=<string>         Display title         (≤ 60 chars)
 *     &sub=<string>           Subtitle              (≤ 140 chars)
 *     &kicker=<string>        Small eyebrow label   (≤ 40 chars)
 *     &tone=ok|warn|down|violet|amber|mint
 *                             Accent colour         (default: mint)
 *     &variant=landing|module|article|status
 *                             Visual template       (default: landing)
 *     &chips=a,b,c            Up to 4 module chips  (variant=landing only)
 *     &meter=0-100            Optional signal bar   (variant=status)
 *
 * Responses are served with a 5-minute edge cache. The endpoint is
 * whitelisted in functions/_middleware.js so social crawlers can fetch
 * it without a session.
 *
 * Security:
 *   - All inputs are length-capped and XML-escaped before interpolation.
 *   - Enum parameters are matched against static allowlists.
 *   - No external fetches, no eval, no template engines.
 */

export async function onRequestGet({ request }) {
  const url = new URL(request.url);
  const params = readParams(url.searchParams);

  const svg = renderCard(params);

  return new Response(svg, {
    status: 200,
    headers: {
      'Content-Type': 'image/svg+xml; charset=utf-8',
      'Cache-Control': 'public, max-age=300, s-maxage=300',
      'X-Content-Type-Options': 'nosniff',
      'Vary': 'Accept',
    },
  });
}

// ──────────────────────────────────────────────────────────
// Input parsing & validation
// ──────────────────────────────────────────────────────────

const TONES = {
  mint:   { signal: '#5eead4', soft: 'rgba(94,234,212,0.16)',  rgb: '94,234,212',  label: 'OPERATIONAL' },
  ok:     { signal: '#5eead4', soft: 'rgba(94,234,212,0.16)',  rgb: '94,234,212',  label: 'OPERATIONAL' },
  warn:   { signal: '#fbbf24', soft: 'rgba(251,191,36,0.16)',  rgb: '251,191,36',  label: 'DEGRADED'    },
  amber:  { signal: '#fbbf24', soft: 'rgba(251,191,36,0.16)',  rgb: '251,191,36',  label: 'NOTICE'      },
  down:   { signal: '#f87171', soft: 'rgba(248,113,113,0.16)', rgb: '248,113,113', label: 'INCIDENT'    },
  violet: { signal: '#c4b5fd', soft: 'rgba(196,181,253,0.16)', rgb: '196,181,253', label: 'STUDIO'      },
};

const VARIANTS = new Set(['landing', 'module', 'article', 'status']);

function clampStr(value, max) {
  if (!value) return '';
  const trimmed = String(value).trim();
  return trimmed.length > max ? trimmed.slice(0, max - 1) + '…' : trimmed;
}

function readParams(sp) {
  const variantRaw = (sp.get('variant') || 'landing').toLowerCase();
  const toneRaw = (sp.get('tone') || 'mint').toLowerCase();

  const chips = (sp.get('chips') || '')
    .split(',')
    .map((c) => clampStr(c, 14))
    .filter(Boolean)
    .slice(0, 4);

  const meterRaw = parseInt(sp.get('meter') || '', 10);
  const meter = Number.isFinite(meterRaw) ? Math.max(0, Math.min(100, meterRaw)) : null;

  return {
    variant: VARIANTS.has(variantRaw) ? variantRaw : 'landing',
    palette: TONES[toneRaw] || TONES.mint,
    title:   clampStr(sp.get('title')  || 'Orthodox Korea Network', 60),
    sub:     clampStr(sp.get('sub')    || 'The signal studio — analytics, media, and editorial surfaces.', 140),
    kicker:  clampStr(sp.get('kicker') || 'Signal Studio', 40),
    chips,
    meter,
  };
}

// ──────────────────────────────────────────────────────────
// Rendering
// ──────────────────────────────────────────────────────────

function renderCard({ variant, palette, title, sub, kicker, chips, meter }) {
  const stamp = new Date().toISOString().replace('T', ' ').slice(0, 16) + 'Z';
  const year = new Date().getUTCFullYear();
  const inner = variantBody({ variant, palette, title, sub, kicker, chips, meter });

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg"
     viewBox="0 0 1200 630"
     width="1200" height="630"
     preserveAspectRatio="xMidYMid slice"
     role="img"
     aria-label="${escapeXml(title)} — OKN Studio">

  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%"  stop-color="#0c1218"/>
      <stop offset="100%" stop-color="#080d12"/>
    </linearGradient>
    <radialGradient id="glow" cx="88%" cy="12%" r="55%">
      <stop offset="0%"  stop-color="${palette.signal}" stop-opacity="0.18"/>
      <stop offset="100%" stop-color="${palette.signal}" stop-opacity="0"/>
    </radialGradient>
    <pattern id="grid" width="48" height="48" patternUnits="userSpaceOnUse">
      <path d="M48 0H0V48" fill="none" stroke="rgba(255,255,255,0.035)" stroke-width="1"/>
    </pattern>
    <radialGradient id="gm" cx="50%" cy="50%" r="70%">
      <stop offset="30%" stop-color="#fff"/>
      <stop offset="100%" stop-color="#000"/>
    </radialGradient>
    <mask id="gridMask">
      <rect width="1200" height="630" fill="url(#gm)"/>
    </mask>
  </defs>

  <!-- Background layers -->
  <rect width="1200" height="630" fill="url(#bg)"/>
  <rect width="1200" height="630" fill="url(#grid)" mask="url(#gridMask)"/>
  <rect width="1200" height="630" fill="url(#glow)"/>
  <rect x="0.5" y="0.5" width="1199" height="629"
        fill="none" stroke="rgba(255,255,255,0.06)" stroke-width="1"/>

  ${chrome(palette)}
  ${inner}
  ${footer({ stamp, year })}
</svg>`;
}

function chrome(palette) {
  return `
  <g font-family="ui-monospace, 'IBM Plex Mono', monospace" font-size="13" letter-spacing="2">
    <g transform="translate(60,52)">
      <g stroke="${palette.signal}" stroke-width="1.6" fill="none" stroke-linecap="round">
        <line x1="14" y1="2"  x2="14" y2="10"/>
        <line x1="14" y1="18" x2="14" y2="26"/>
        <line x1="2"  y1="14" x2="10" y2="14"/>
        <line x1="18" y1="14" x2="26" y2="14"/>
      </g>
      <g fill="${palette.signal}">
        <circle cx="14" cy="2"  r="2"/>
        <circle cx="14" cy="26" r="2"/>
        <circle cx="2"  cy="14" r="2"/>
        <circle cx="26" cy="14" r="2"/>
        <circle cx="14" cy="14" r="3"/>
      </g>
      <text x="44" y="20" fill="#e8edf2" font-weight="500">OKN<tspan fill="#2b323a">/</tspan><tspan fill="${palette.signal}">STUDIO</tspan></text>
    </g>
    <g transform="translate(1140,52)" text-anchor="end">
      <rect x="-170" y="-6" width="170" height="30" rx="15"
            fill="${palette.soft}" stroke="${palette.signal}" stroke-opacity="0.35"/>
      <circle cx="-152" cy="9" r="3.5" fill="${palette.signal}">
        <animate attributeName="opacity" values="1;0.3;1" dur="2s" repeatCount="indefinite"/>
      </circle>
      <text x="-12" y="14" fill="${palette.signal}" font-weight="500">${palette.label}</text>
    </g>
  </g>`;
}

function variantBody({ variant, palette, title, sub, kicker, chips, meter }) {
  switch (variant) {
    case 'module':  return moduleBody({ palette, title, sub, kicker });
    case 'article': return articleBody({ palette, title, sub, kicker });
    case 'status':  return statusBody({ palette, title, sub, kicker, meter });
    case 'landing':
    default:        return landingBody({ palette, title, sub, kicker, chips });
  }
}

function landingBody({ palette, title, sub, kicker, chips }) {
  const [line1, line2] = splitTitle(title);
  return `
  <g transform="translate(80,200)" font-family="ui-monospace, 'IBM Plex Mono', monospace">
    <circle cx="6" cy="-5" r="3" fill="${palette.signal}"/>
    <text x="20" y="0" fill="#8b9199" font-size="13" letter-spacing="3">${escapeXml(kicker.toUpperCase())}</text>
  </g>

  <g font-family="'Sora', system-ui, sans-serif" fill="#e8edf2">
    <text x="80" y="296" font-size="78" font-weight="300" letter-spacing="-1.5">
      ${escapeXml(line1)}
    </text>
    <text x="80" y="378" font-size="78" font-weight="600" letter-spacing="-1.5" fill="${palette.signal}">
      ${escapeXml(line2)}
    </text>
  </g>

  <text x="80" y="438"
        font-family="'IBM Plex Sans', system-ui, sans-serif"
        font-size="22" font-weight="400" fill="#8b9199">
    ${escapeXml(sub)}
  </text>

  ${renderChips(80, 500, chips)}`;
}

function moduleBody({ palette, title, sub, kicker }) {
  return `
  <g transform="translate(80,220)" font-family="ui-monospace, 'IBM Plex Mono', monospace">
    <circle cx="6" cy="-5" r="3" fill="${palette.signal}"/>
    <text x="20" y="0" fill="${palette.signal}" font-size="13" letter-spacing="3">MODULE · ${escapeXml(kicker.toUpperCase())}</text>
  </g>

  <g font-family="'Sora', system-ui, sans-serif" fill="#e8edf2">
    <text x="80" y="340" font-size="96" font-weight="500" letter-spacing="-2">
      ${escapeXml(title)}
    </text>
  </g>

  <text x="80" y="400"
        font-family="'IBM Plex Sans', system-ui, sans-serif"
        font-size="22" font-weight="400" fill="#8b9199">
    ${escapeXml(sub)}
  </text>

  <g transform="translate(80,480)">
    <line x1="0" y1="0" x2="60" y2="0" stroke="${palette.signal}" stroke-width="2"/>
    <text x="76" y="5" font-family="ui-monospace, 'IBM Plex Mono', monospace"
          font-size="12" letter-spacing="2" fill="#6b7178">OKNSTUDIO.CYBERSYSTEMA.COM</text>
  </g>`;
}

function articleBody({ palette, title, sub, kicker }) {
  return `
  <g transform="translate(80,210)" font-family="ui-monospace, 'IBM Plex Mono', monospace">
    <rect x="-6" y="-15" width="12" height="12" fill="${palette.signal}"/>
    <text x="16" y="-4" fill="#8b9199" font-size="13" letter-spacing="3">${escapeXml(kicker.toUpperCase())}</text>
  </g>

  ${multilineTitle(title, 80, 300, 56, 66)}

  <text x="80" y="460"
        font-family="'IBM Plex Sans', system-ui, sans-serif"
        font-size="20" font-weight="400" fill="#8b9199">
    ${escapeXml(sub)}
  </text>

  <g transform="translate(80,510)" font-family="ui-monospace, 'IBM Plex Mono', monospace"
     font-size="12" letter-spacing="2" fill="${palette.signal}">
    <text>READ \u2192</text>
  </g>`;
}

function statusBody({ palette, title, sub, kicker, meter }) {
  const meterPct = meter == null ? null : Math.max(0, Math.min(100, meter));
  return `
  <g transform="translate(80,210)" font-family="ui-monospace, 'IBM Plex Mono', monospace">
    <circle cx="6" cy="-5" r="3" fill="${palette.signal}">
      <animate attributeName="opacity" values="1;0.25;1" dur="1.4s" repeatCount="indefinite"/>
    </circle>
    <text x="20" y="0" fill="#8b9199" font-size="13" letter-spacing="3">${escapeXml(kicker.toUpperCase())}</text>
  </g>

  <g font-family="'Sora', system-ui, sans-serif" fill="#e8edf2">
    <text x="80" y="330" font-size="84" font-weight="500" letter-spacing="-1.5">
      ${escapeXml(title)}
    </text>
  </g>

  <text x="80" y="390"
        font-family="'IBM Plex Sans', system-ui, sans-serif"
        font-size="22" font-weight="400" fill="#8b9199">
    ${escapeXml(sub)}
  </text>

  ${meterPct != null ? `
  <g transform="translate(80,470)">
    <rect x="0" y="0" width="1040" height="10" rx="5" fill="rgba(255,255,255,0.05)"/>
    <rect x="0" y="0" width="${1040 * meterPct / 100}" height="10" rx="5" fill="${palette.signal}"/>
    <text x="0" y="-10" font-family="ui-monospace, 'IBM Plex Mono', monospace"
          font-size="11" letter-spacing="2" fill="#6b7178">SIGNAL \u00b7 ${meterPct}%</text>
  </g>` : ''}`;
}

// ──────────────────────────────────────────────────────────
// Primitives
// ──────────────────────────────────────────────────────────

function splitTitle(title) {
  // Split roughly in half at the last whitespace before midpoint.
  const words = title.split(/\s+/);
  if (words.length <= 2) return [title, ''];
  const mid = Math.ceil(words.length / 2);
  return [words.slice(0, mid).join(' '), words.slice(mid).join(' ')];
}

function multilineTitle(text, x, y, fontSize, lineHeight) {
  // Simple greedy word-wrap at ~22 chars per line, max 3 lines.
  const maxChars = 24;
  const words = text.split(/\s+/);
  const lines = [];
  let current = '';
  for (const w of words) {
    if ((current + ' ' + w).trim().length > maxChars) {
      if (current) lines.push(current);
      current = w;
    } else {
      current = (current + ' ' + w).trim();
    }
    if (lines.length === 3) break;
  }
  if (current && lines.length < 3) lines.push(current);

  return `<g font-family="'Sora', system-ui, sans-serif" fill="#e8edf2"
             font-size="${fontSize}" font-weight="500" letter-spacing="-1.2">
    ${lines.map((ln, i) =>
      `<text x="${x}" y="${y + i * lineHeight}">${escapeXml(ln)}</text>`
    ).join('')}
  </g>`;
}

function renderChips(x, y, chips) {
  if (!chips.length) return '';
  let cursor = 0;
  return `<g transform="translate(${x},${y})"
             font-family="ui-monospace, 'IBM Plex Mono', monospace"
             font-size="12" letter-spacing="2" fill="#6b7178">
    ${chips.map((label) => {
      const w = label.length * 9 + 22;
      const node = `
        <g transform="translate(${cursor},0)">
          <rect x="0" y="-14" width="${w}" height="24" rx="12"
                fill="rgba(255,255,255,0.02)" stroke="rgba(255,255,255,0.08)"/>
          <text x="11" y="3">${escapeXml(label.toUpperCase())}</text>
        </g>`;
      cursor += w + 14;
      return node;
    }).join('')}
  </g>`;
}

function footer({ stamp, year }) {
  return `
  <g font-family="ui-monospace, 'IBM Plex Mono', monospace" font-size="11" letter-spacing="2" fill="#6b7178">
    <line x1="80" y1="568" x2="1120" y2="568" stroke="rgba(255,255,255,0.06)"/>
    <text x="80" y="596">v1.0 \u00b7 ${escapeXml(stamp)}</text>
    <text x="1120" y="596" text-anchor="end">cybersystema.com \u00b7 ${year}</text>
  </g>`;
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * OKN Studio · Darkroom — Zone registry
 * =====================================
 * Every zone in the master spec is declared here, even those not yet built.
 * Tab pages read this: unbuilt zones render a "coming in Phase N" card so
 * the workflow has a visible home before its code ships.
 *
 * @typedef {'publish'|'convert'|'archive'|'organize'} TabId
 *
 * @typedef {Object} ZoneManifest
 * @property {string} id
 * @property {TabId} tab
 * @property {string} title          i18n key
 * @property {string} description    i18n key
 * @property {string} glyph          svg string (small 20×20 stroked icon)
 * @property {1|2|3|4|5|6|7|8} shipsIn
 * @property {string[]} accept       MIME types or ".ext" patterns
 * @property {import('../job/server-router.js').Thresholds} thresholds
 */

import { ZONE_THRESHOLDS } from '../job/server-router.js';

const GLYPHS = {
  globe: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round">
    <circle cx="12" cy="12" r="9"/>
    <path d="M3 12 L21 12"/>
    <path d="M12 3 C 8 8 8 16 12 21 C 16 16 16 8 12 3 Z"/>
  </svg>`,
  share: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="6" cy="12" r="2.6"/>
    <circle cx="18" cy="6" r="2.6"/>
    <circle cx="18" cy="18" r="2.6"/>
    <path d="M8.4 10.8 L15.6 7.2"/>
    <path d="M8.4 13.2 L15.6 16.8"/>
  </svg>`,
  minimize: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round">
    <path d="M8 3 L3 3 L3 8"/>
    <path d="M16 3 L21 3 L21 8"/>
    <path d="M8 21 L3 21 L3 16"/>
    <path d="M16 21 L21 21 L21 16"/>
  </svg>`,
  swap: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
    <path d="M4 8 L18 8"/>
    <path d="M14 4 L18 8 L14 12"/>
    <path d="M20 16 L6 16"/>
    <path d="M10 12 L6 16 L10 20"/>
  </svg>`,
  aperture: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round">
    <circle cx="12" cy="12" r="9"/>
    <path d="M14.3 3.3 L9 12 L14 21.3"/>
    <path d="M20.7 14.3 L11 12 L7.5 2.7"/>
    <path d="M3.3 9.7 L13 12 L16.5 21.3"/>
  </svg>`,
  palette: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
    <path d="M12 3 C 6.5 3 3 7 3 12 C 3 16 6.5 19 10 19 C 11 19 11.5 18.5 11.5 17.5 C 11.5 17 11.2 16.6 11.2 16 C 11.2 15 12 14 13.5 14 L 16 14 C 19 14 21 12 21 9 C 21 5.5 17 3 12 3 Z"/>
    <circle cx="7" cy="11" r="1.2" fill="currentColor" stroke="none"/>
    <circle cx="10" cy="7" r="1.2" fill="currentColor" stroke="none"/>
    <circle cx="15" cy="7" r="1.2" fill="currentColor" stroke="none"/>
    <circle cx="17.5" cy="11" r="1.2" fill="currentColor" stroke="none"/>
  </svg>`,
  archive: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
    <rect x="3" y="4" width="18" height="4" rx="1"/>
    <rect x="5" y="8" width="14" height="12" rx="1"/>
    <path d="M10 13 L14 13"/>
  </svg>`,
  tag: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
    <path d="M20 13 L13 20 C 12 21 10.5 21 9.5 20 L 4 14.5 C 3 13.5 3 12 4 11 L 11 4 L 20 4 L 20 13 Z"/>
    <circle cx="16" cy="8" r="1.3" fill="currentColor" stroke="none"/>
  </svg>`,
  type: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round">
    <path d="M4 6 L20 6"/>
    <path d="M12 6 L12 20"/>
    <path d="M9 20 L15 20"/>
  </svg>`
};

/** @type {ZoneManifest[]} */
export const ZONES = [
  // Publish
  { id: 'web-ready',       tab: 'publish',  title: 'zone.web-ready.title',       description: 'zone.web-ready.description',
    glyph: GLYPHS.globe,    shipsIn: 2, accept: ['image/jpeg','image/png','image/heic','image/heif','image/webp','image/tiff'],
    thresholds: ZONE_THRESHOLDS['web-ready'] },
  { id: 'social',          tab: 'publish',  title: 'zone.social.title',          description: 'zone.social.description',
    glyph: GLYPHS.share,    shipsIn: 5, accept: ['image/jpeg','image/png','image/heic','image/heif','image/webp'],
    thresholds: ZONE_THRESHOLDS['social'] },
  { id: 'bulk-compress',   tab: 'publish',  title: 'zone.bulk-compress.title',   description: 'zone.bulk-compress.description',
    glyph: GLYPHS.minimize, shipsIn: 2, accept: ['image/jpeg','image/png','image/heic','image/heif','image/webp','image/tiff'],
    thresholds: ZONE_THRESHOLDS['bulk-compress'] },

  // Convert
  { id: 'heic-to-jpeg',    tab: 'convert',  title: 'zone.heic-to-jpeg.title',    description: 'zone.heic-to-jpeg.description',
    glyph: GLYPHS.swap,     shipsIn: 4, accept: ['image/heic','image/heif'],
    thresholds: ZONE_THRESHOLDS['heic-to-jpeg'] },
  { id: 'raw-develop',     tab: 'convert',  title: 'zone.raw-develop.title',     description: 'zone.raw-develop.description',
    glyph: GLYPHS.aperture, shipsIn: 7, accept: ['.cr2','.cr3','.nef','.nrw','.arw','.dng','.raf','.orf','.rw2','.pef'],
    thresholds: ZONE_THRESHOLDS['raw-develop'] },
  { id: 'colour-space',    tab: 'convert',  title: 'zone.colour-space.title',    description: 'zone.colour-space.description',
    glyph: GLYPHS.palette,  shipsIn: 4, accept: ['image/jpeg','image/png','image/tiff','image/webp'],
    thresholds: ZONE_THRESHOLDS['colour-space'] },

  // Archive
  { id: 'archive',         tab: 'archive',  title: 'zone.archive.title',         description: 'zone.archive.description',
    glyph: GLYPHS.archive,  shipsIn: 6, accept: ['image/*'],
    thresholds: ZONE_THRESHOLDS['archive'] },

  // Organize
  { id: 'metadata-studio', tab: 'organize', title: 'zone.metadata-studio.title', description: 'zone.metadata-studio.description',
    glyph: GLYPHS.tag,      shipsIn: 2, accept: ['image/jpeg','image/png','image/heic','image/heif','image/tiff','image/webp'],
    thresholds: ZONE_THRESHOLDS['metadata-studio'] },
  { id: 'batch-rename',    tab: 'organize', title: 'zone.batch-rename.title',    description: 'zone.batch-rename.description',
    glyph: GLYPHS.type,     shipsIn: 1, accept: ['image/*'],
    thresholds: ZONE_THRESHOLDS['batch-rename'] }
];

export const ZONES_BY_TAB = {
  publish:  ZONES.filter((z) => z.tab === 'publish'),
  convert:  ZONES.filter((z) => z.tab === 'convert'),
  archive:  ZONES.filter((z) => z.tab === 'archive'),
  organize: ZONES.filter((z) => z.tab === 'organize')
};

/** @param {ZoneManifest} zone @param {number} currentPhase */
export function isShipped(zone, currentPhase) { return zone.shipsIn <= currentPhase; }

/**
 * Zones that are actually wired end-to-end (have a processor in app.js).
 * A zone may be "shipped in phase N" per the registry but still be waiting
 * on a concrete processor implementation. WIRED_ZONES is the source of
 * truth for which zone cards render as live.
 *
 * Keep this alphabetised and bump it as each zone lands.
 */
export const WIRED_ZONES = new Set([
  'batch-rename',
  'bulk-compress',
  'metadata-studio',
  'web-ready'
]);

/** Current phase — bump as phases land. */
export const CURRENT_PHASE = 2;

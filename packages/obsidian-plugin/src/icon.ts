// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// The plugin's own icon: a page with a folded corner carrying one
// double-headed arrow — one document synced both ways. A single glyph with
// wide heads, below the fold, is all a 16px page has room for. Drawn on
// Lucide's 24-unit grid so it matches Obsidian's icons, and scaled into the
// 100-unit box `addIcon` expects; the stroke follows the theme's
// `--icon-stroke`, like every Lucide icon.

/** ICON_ID is the id the plugin registers its icon under. */
export const ICON_ID = "docket";

/** ICON_SVG is the icon's inner SVG markup for `addIcon` (a 100×100 box). */
export const ICON_SVG =
    '<g transform="scale(4.1667)" fill="none" stroke="currentColor" ' +
    'stroke-linecap="round" stroke-linejoin="round" ' +
    'style="stroke-width: var(--icon-stroke, 2)">' +
    '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>' +
    '<path d="M14 2v6h6"/>' +
    '<path d="M8 15h8"/><path d="m10 12-3 3 3 3"/><path d="m14 12 3 3-3 3"/>' +
    "</g>";

// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// The plugin's own icon: a Markdown page drawn as two square brackets around
// two text lines. One outline and two inner strokes, two units apart, stay
// apart at the 14–18px the ribbon, panel tab, and status bar draw it. Drawn
// on Lucide's 24-unit grid so it matches Obsidian's icons, and scaled into
// the 100-unit box `addIcon` expects; the stroke follows the theme's
// `--icon-stroke`, like every Lucide icon.

/** ICON_ID is the id the plugin registers its icon under. */
export const ICON_ID = "docket";

/** ICON_SVG is the icon's inner SVG markup for `addIcon` (a 100×100 box). */
export const ICON_SVG =
    '<g transform="scale(4.1667)" fill="none" stroke="currentColor" ' +
    'stroke-linecap="round" stroke-linejoin="round" ' +
    'style="stroke-width: var(--icon-stroke, 2)">' +
    '<path d="M8 3H5v18h3"/><path d="M16 3h3v18h-3"/>' +
    '<path d="M9 9.5h6"/><path d="M9 14.5h6"/>' +
    "</g>";

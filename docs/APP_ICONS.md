# Application icons

The icons use a white rounded-square tile with a flat indigo (#5268e8) symbol.
Transparent outer margins and corners let the tile shape appear in the macOS Dock.
Both PNGs are 1024 × 1024 RGBA exports from the matching SVG sources.

| Application | Symbol | Source | Runtime asset |
| --- | --- | --- | --- |
| Editor | Lucide Workflow's two linked rounded-square nodes | `packages/desktop/assets/app-icon.svg` | `packages/desktop/assets/app-icon.png` |
| Gateway | A seven-node branching tree | `packages/gateway/assets/app-icon.svg` | `packages/gateway/assets/app-icon.png` |

The white tile proportions were informed by the macOS Safari, Telegram and VS Code
icons. The symbols are flat, with no gradients, highlights, bevels or 3D shading.
The outer tile has a thin neutral border, without a shadow.

The built-in image generation tool produced initial drafts; the final assets were
authored as SVG and rasterized using `@resvg/resvg-js` so geometry, flat colors and
alpha edges are exact.
The SVGs are the source of truth for future exports. Export at width 1024 with the
SVG canvas background left transparent.

Existing Electron window and macOS Dock configuration consumes the PNG paths.
Restart the applications to load updated assets.

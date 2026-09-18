/**
 * The single PMTiles protocol instance shared by every map and by the OPFS
 * pin (issue #58 part 5). It lives in its own module — not in `map.tsx` — so
 * the cache module can pre-register archive instances (`protocol.add`) for
 * local reads without importing MapLibre (and without every importer of this
 * file pulling the map bundle).
 *
 * `Protocol.tile` resolves `pmtiles://{key}` URLs by looking up an
 * explicitly-added instance whose `source.getKey()` matches `{key}`, and only
 * creates a network `FetchSource` when none was added — that lookup is the
 * seam the OPFS pin plugs into: the tile URL string never changes, but reads
 * can come from disk.
 */
import { Protocol } from "pmtiles";

export const pmtilesProtocol = new Protocol();

import { gzipSync } from "fflate";

/** Gzip (the PMTiles v3 internal compression used for sections and tiles). */
export function gzip(data: Uint8Array): Uint8Array {
  return gzipSync(data);
}

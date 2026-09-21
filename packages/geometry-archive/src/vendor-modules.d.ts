declare module "vt-pbf" {
  /** Options accepted by vt-pbf's encoders. */
  interface VtPbfOptions {
    /** MVT extent the coordinates were projected into. */
    extent?: number;
    /** MVT spec version to write (2). */
    version?: number;
  }

  const vtPbf: {
    /** Serializes a `{ layers }` vector-tile JS object into MVT protobuf bytes. */
    (tile: { layers: Record<string, unknown> }): Uint8Array;
    fromVectorTileJs(tile: { layers: Record<string, unknown> }): Uint8Array;
    /** Serializes geojson-vt tiles: layer name → tile object with `.features`. */
    fromGeojsonVt(layers: Record<string, unknown>, options?: VtPbfOptions): Uint8Array;
    GeoJSONWrapper: new (features: unknown[], options?: VtPbfOptions) => unknown;
  };

  export default vtPbf;
}

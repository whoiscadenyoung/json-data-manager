export class GeometryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GeometryError";
    Object.setPrototypeOf(this, GeometryError.prototype);
  }
}

export class GeoParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GeoParseError";
    Object.setPrototypeOf(this, GeoParseError.prototype);
  }
}

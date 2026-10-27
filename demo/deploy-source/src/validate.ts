import {
  DEPLOYMENT_STATUSES,
  type DeploymentPatch,
  type DeploymentStatus,
  isRouteCoordinates,
} from "./store";

/** Request-body parsing for the admin routes. Each parser returns the patch, or null to reject. */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStatus(value: unknown): value is DeploymentStatus {
  return DEPLOYMENT_STATUSES.some((status) => status === value);
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asCoordinate(value: unknown, limit: number): number | null {
  return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= limit
    ? value
    : null;
}

type FieldParser = (value: unknown) => DeploymentPatch | null;

function stringField(build: (value: string) => DeploymentPatch): FieldParser {
  return (value) => {
    const text = asString(value);
    return text === null ? null : build(text);
  };
}

const FIELD_PARSERS: Record<string, FieldParser> = {
  deployedAt: stringField((deployedAt) => ({ deployedAt })),
  environment: stringField((environment) => ({ environment })),
  lat: (value) => {
    const lat = asCoordinate(value, 90);
    return lat === null ? null : { lat };
  },
  lng: (value) => {
    const lng = asCoordinate(value, 180);
    return lng === null ? null : { lng };
  },
  name: stringField((name) => ({ name })),
  notes: stringField((notes) => ({ notes })),
  owner: stringField((owner) => ({ owner })),
  region: stringField((region) => ({ region })),
  route: (value) => (value === null || isRouteCoordinates(value) ? { route: value } : null),
  status: (value) => (isStatus(value) ? { status: value } : null),
  version: stringField((version) => ({ version })),
};

export function parseDeploymentPatch(
  body: unknown,
): { error: string } | { patch: DeploymentPatch } {
  if (!isRecord(body)) {
    return { error: "Body must be a JSON object." };
  }
  const patch: DeploymentPatch = {};
  for (const [key, value] of Object.entries(body)) {
    const parser = FIELD_PARSERS[key];
    if (parser === undefined) {
      return { error: `Unknown field "${key}".` };
    }
    const parsed = parser(value);
    if (parsed === null) {
      return { error: `Invalid value for "${key}".` };
    }
    Object.assign(patch, parsed);
  }
  return { patch };
}

export interface FaultState {
  // Respond to the next N contract requests with `failStatus`.
  failNext: number;
  failStatus: number;
  // Delay every contract response by this much.
  latencyMs: number;
  // Respond to the next N contract requests with a truncated JSON body.
  malformedNext: number;
  // Serve `cursor: null` after the first rows page — the contract violation
  // that would make a full sync delete rows it never saw.
  truncate: boolean;
}

export function createFaultState(): FaultState {
  return { failNext: 0, failStatus: 503, latencyMs: 0, malformedNext: 0, truncate: false };
}

function nonNegativeInt(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

const FAULT_PARSERS: Record<string, (value: unknown) => Partial<FaultState> | null> = {
  failNext: (value) => {
    const failNext = nonNegativeInt(value);
    return failNext === null ? null : { failNext };
  },
  failStatus: (value) => {
    const failStatus = nonNegativeInt(value);
    return failStatus === null || failStatus < 400 || failStatus > 599 ? null : { failStatus };
  },
  latencyMs: (value) => {
    const latencyMs = nonNegativeInt(value);
    return latencyMs === null ? null : { latencyMs };
  },
  malformedNext: (value) => {
    const malformedNext = nonNegativeInt(value);
    return malformedNext === null ? null : { malformedNext };
  },
  truncate: (value) => (typeof value === "boolean" ? { truncate: value } : null),
};

export function parseFaultPatch(body: unknown): { error: string } | { patch: Partial<FaultState> } {
  if (!isRecord(body)) {
    return { error: "Body must be a JSON object." };
  }
  const patch: Partial<FaultState> = {};
  for (const [key, value] of Object.entries(body)) {
    const parser = FAULT_PARSERS[key];
    if (parser === undefined) {
      return { error: `Unknown fault "${key}".` };
    }
    const parsed = parser(value);
    if (parsed === null) {
      return { error: `Invalid value for "${key}".` };
    }
    Object.assign(patch, parsed);
  }
  return { patch };
}

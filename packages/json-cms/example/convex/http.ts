import { httpActionGeneric, httpRouter } from "convex/server";

import { components } from "./_generated/api";

const http = httpRouter();

// Register HTTP routes for the JSON CMS component
// Example: GET /schemas - list all schemas. The catalog enumerations require
// the viewer identity (stage 8, #104): drafts and `publishedVisibility:
// "author"` rows are scoped to their creator even on raw HTTP paths.
http.route({
  handler: httpActionGeneric(async (ctx, _request) => {
    const schemas = await ctx.runQuery(components.jsonCms.lib.listSchemas, {
      viewerId: "example-http-viewer",
    });
    return new Response(JSON.stringify(schemas), {
      headers: { "Content-Type": "application/json" },
      status: 200,
    });
  }),
  method: "GET",
  path: "/schemas",
});

// Example: GET /schemas/<id>/entries - list entries for a schema.
// `httpRouter` has no `:param` support, so match a prefix and parse the path.
http.route({
  handler: httpActionGeneric(async (ctx, request) => {
    const segments = new URL(request.url).pathname.split("/"),
      schemaId = segments[2] ?? "",
      entries = await ctx.runQuery(components.jsonCms.lib.listEntries, { schemaId });
    return new Response(JSON.stringify(entries), {
      headers: { "Content-Type": "application/json" },
      status: 200,
    });
  }),
  method: "GET",
  pathPrefix: "/schemas/",
});

export default http;

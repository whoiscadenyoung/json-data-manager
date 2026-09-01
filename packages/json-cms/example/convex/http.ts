import { httpActionGeneric, httpRouter } from "convex/server";

import { components } from "./_generated/api";

const http = httpRouter();

// Register HTTP routes for the JSON CMS component
// Example: GET /schemas - list all schemas
http.route({
  handler: httpActionGeneric(async (ctx, _request) => {
    const schemas = await ctx.runQuery(components.jsonCms.lib.listSchemas, {});
    return new Response(JSON.stringify(schemas), {
      headers: { "Content-Type": "application/json" },
      status: 200,
    });
  }),
  method: "GET",
  path: "/schemas",
});

// Example: GET /schemas/:id/entries - list entries for a schema
http.route({
  handler: httpActionGeneric(async (ctx, request) => {
    const url = new URL(request.url),
      schemaId = url.pathname.split("/")[2] as any,
      entries = await ctx.runQuery(components.jsonCms.lib.listEntries, {
        schemaId,
      });
    return new Response(JSON.stringify(entries), {
      headers: { "Content-Type": "application/json" },
      status: 200,
    });
  }),
  method: "GET",
  path: "/schemas/:schemaId/entries",
});

export default http;

import { httpRouter } from "convex/server";
import { httpActionGeneric } from "convex/server";
import { components } from "./_generated/api";

const http = httpRouter();

// Register HTTP routes for the JSON CMS component
// Example: GET /schemas - list all schemas
http.route({
  path: "/schemas",
  method: "GET",
  handler: httpActionGeneric(async (ctx, _request) => {
    const schemas = await ctx.runQuery(components.jsonCms.lib.listSchemas, {});
    return new Response(JSON.stringify(schemas), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }),
});

// Example: GET /schemas/:id/entries - list entries for a schema
http.route({
  path: "/schemas/:schemaId/entries",
  method: "GET",
  handler: httpActionGeneric(async (ctx, request) => {
    const url = new URL(request.url);
    const schemaId = url.pathname.split("/")[2] as any;

    const entries = await ctx.runQuery(components.jsonCms.lib.listEntries, {
      schemaId,
    });
    return new Response(JSON.stringify(entries), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }),
});

export default http;

// oxlint-disable-next-line import/no-unassigned-import
import "./App.css";
import { useMutation, useQuery } from "convex/react";
import { useState } from "react";

import { api } from "../convex/_generated/api";

export function App() {
  const schemas = useQuery(api.example.listSchemas, {}),
    createSchema = useMutation(api.example.createSchema),
    [newSchema, setNewSchema] = useState({
      description: "",
      properties: {},
      title: "",
      type: "object" as const,
    }),
    handleCreateSchema = async () => {
      if (newSchema.title && newSchema.description) {
        await createSchema({ schema: newSchema });
        setNewSchema({
          description: "",
          properties: {},
          title: "",
          type: "object",
        });
      }
    };

  return (
    <>
      <h1>JSON CMS Example</h1>
      <div className="card">
        <h2>Create Schema</h2>
        <div style={{ marginBottom: "1rem" }}>
          <input
            type="text"
            placeholder="Schema Title"
            value={newSchema.title}
            onChange={(e) => {
              setNewSchema({ ...newSchema, title: e.target.value });
            }}
            style={{ marginRight: "0.5rem", padding: "0.5rem" }}
          />
          <input
            type="text"
            placeholder="Description"
            value={newSchema.description}
            onChange={(e) => {
              setNewSchema({ ...newSchema, description: e.target.value });
            }}
            style={{ marginRight: "0.5rem", padding: "0.5rem" }}
          />
          <button onClick={handleCreateSchema}>Create Schema</button>
        </div>

        <h2>Schemas</h2>
        {schemas?.length === 0 && (
          <p style={{ color: "rgba(128, 128, 128, 0.8)" }}>No schemas yet. Create one above!</p>
        )}
        <ul style={{ listStyle: "none", padding: 0 }}>
          {schemas?.map((schema) => (
            <li
              key={schema._id}
              style={{
                border: "1px solid rgba(128, 128, 128, 0.3)",
                borderRadius: "8px",
                marginBottom: "1rem",
                padding: "1rem",
                textAlign: "left",
              }}
            >
              <h3 style={{ marginTop: 0 }}>{schema.title}</h3>
              <p style={{ color: "rgba(128, 128, 128, 0.8)" }}>{schema.description}</p>
              <pre
                style={{
                  backgroundColor: "rgba(128, 128, 128, 0.1)",
                  borderRadius: "4px",
                  fontSize: "0.8rem",
                  overflow: "auto",
                  padding: "0.5rem",
                }}
              >
                {JSON.stringify(schema.schema, null, 2)}
              </pre>
            </li>
          ))}
        </ul>

        <p style={{ fontSize: "0.9rem", marginTop: "2rem" }}>
          See <code>example/convex/example.ts</code> for all the ways to use this component
        </p>
      </div>
    </>
  );
}

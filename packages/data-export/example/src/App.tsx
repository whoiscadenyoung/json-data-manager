// oxlint-disable-next-line import/no-unassigned-import
import "./App.css";
import { useMutation, useQuery } from "convex/react";
import { useState } from "react";

import { api } from "../convex/_generated/api";

const box: React.CSSProperties = {
  border: "1px solid rgba(128, 128, 128, 0.3)",
  borderRadius: "8px",
  padding: "1rem",
  marginBottom: "1rem",
  textAlign: "left",
};

function ExportRow({ id }: { id: string }) {
  const files = useQuery(api.example.getExportFiles, { exportId: id });
  const urls = useQuery(api.example.getDownloadUrls, { exportId: id });
  return (
    <ul style={{ margin: "0.5rem 0 0", paddingLeft: "1.25rem" }}>
      {files &&
        files.map((f) => {
          const urlEntry = urls ? urls.files.find((u) => u.tableName === f.tableName) : undefined;
          const url = urlEntry ? urlEntry.url : undefined;
          return (
            <li key={f._id}>
              <code>{f.path}</code> — {f.rowCount} rows ({f.sizeBytes} bytes)
              {url ? (
                <>
                  {" "}
                  <a href={url} target="_blank" rel="noopener noreferrer">
                    download
                  </a>
                </>
              ) : null}
            </li>
          );
        })}
      {files && files.length === 0 ? <li>No files yet…</li> : null}
    </ul>
  );
}

export function App() {
  const exports = useQuery(api.example.listExports, {});
  const seed = useMutation(api.example.seed);
  const runExport = useMutation(api.example.runExport);
  const [tables, setTables] = useState("users, posts");

  const handleRun = () => {
    const tableNames = tables
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    void runExport({ tableNames, label: "manual" });
  };

  return (
    <>
      <h1>Data Export</h1>
      <div className="card">
        <div style={box}>
          <button type="button" onClick={() => void seed({ users: 5 })}>
            Seed sample data
          </button>{" "}
          <input
            value={tables}
            onChange={(e) => setTables(e.target.value)}
            placeholder="comma-separated table names"
            style={{ padding: "0.4rem", width: "16rem" }}
          />{" "}
          <button type="button" onClick={handleRun}>
            Run export
          </button>
        </div>

        <h3>Exports</h3>
        {exports &&
          exports.map((e) => (
            <div key={e._id} style={box}>
              <div>
                <strong>{e.label ?? e._id}</strong> — {e.status}
                {" • "}
                {new Date(e.requestedAt).toLocaleString()}
                {" • "}
                {e.totalRows ?? 0} rows
              </div>
              <div style={{ fontSize: "0.85rem", color: "gray" }}>
                tables: {e.tableNames.join(", ")}
              </div>
              <ExportRow id={e._id} />
            </div>
          ))}
        {exports && exports.length === 0 ? <p>No exports yet.</p> : null}

        <p>
          See <code>example/convex/example.ts</code> for all the ways to use this component.
        </p>
      </div>
    </>
  );
}

/** Reads a browser `File` as text (used by text-based parsers: JSON/JSONL, CSV). */
export async function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      resolve(typeof reader.result === "string" ? reader.result : "");
    });
    reader.addEventListener("error", () => {
      reject(reader.error ?? new Error("Failed to read file"));
    });
    reader.readAsText(file);
  });
}

/** Reads a browser `File` as an ArrayBuffer (used by binary parsers: Excel). */
export async function readFileAsArrayBuffer(file: File): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      resolve(reader.result instanceof ArrayBuffer ? reader.result : new ArrayBuffer(0));
    });
    reader.addEventListener("error", () => {
      reject(reader.error ?? new Error("Failed to read file"));
    });
    reader.readAsArrayBuffer(file);
  });
}

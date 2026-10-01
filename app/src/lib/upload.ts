import type { DatasetImportRow } from "@caden/json-cms/react/ui";

/**
 * The shared upload half of the import pipeline (issue #135, defect 10): the
 * chunk/source-file POSTs were copy-pasted between the create flow and the
 * bulk-upload retry flow — one blob upload per generated URL, each riding the
 * `uploadId` its URL was issued under (`startImport` rejects any blob without
 * one, issued for THIS dataset — issue #131).
 */

/** Narrows the upload endpoint's JSON response to its storage id. */
function storageIdFromUploadResponse(body: unknown, failure: string): string {
  if (
    typeof body !== "object" ||
    body === null ||
    !("storageId" in body) ||
    typeof body.storageId !== "string"
  ) {
    throw new Error(failure);
  }
  return body.storageId;
}

/** POSTs one serialized row chunk to its upload URL and returns the blob's id. */
export async function uploadChunkBlob(
  storageUrl: string,
  chunk: DatasetImportRow[],
): Promise<string> {
  const res = await fetch(storageUrl, {
    body: JSON.stringify(chunk),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  if (!res.ok) {
    throw new Error("Failed to upload import data.");
  }
  return storageIdFromUploadResponse(await res.json(), "Import upload did not return a storageId.");
}

/** POSTs the retained original file to its upload URL and returns the blob's id. */
export async function uploadSourceFileBlob(storageUrl: string, file: File): Promise<string> {
  const res = await fetch(storageUrl, {
    body: file,
    headers: {
      "Content-Type": file.type || "application/octet-stream",
    },
    method: "POST",
  });
  if (!res.ok) {
    throw new Error("Failed to upload the original file.");
  }
  return storageIdFromUploadResponse(
    await res.json(),
    "Original-file upload did not return a storageId.",
  );
}

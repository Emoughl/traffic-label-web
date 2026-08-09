import { getDriveClient } from "./googleAuth";

const ROOT_FOLDER_ID = process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID;

const folderListCache = { ts: 0, value: null };
const folderIdCache = new Map();
const imagesCache = new Map();
const CACHE_TTL_MS = {
  folders: 30 * 1000,
  folderId: 60 * 1000,
  images: 2 * 60 * 1000,
};

export async function listDateFolders() {
  const now = Date.now();
  if (folderListCache.value && now - folderListCache.ts < CACHE_TTL_MS.folders) {
    return folderListCache.value;
  }

  const drive = getDriveClient();
  const folders = [];
  let pageToken;
  do {
    const res = await drive.files.list({
      q: `'${ROOT_FOLDER_ID}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
      fields: "nextPageToken, files(id, name)",
      pageSize: 200,
      pageToken,
    });
    folders.push(...(res.data.files || []));
    pageToken = res.data.nextPageToken;
  } while (pageToken);
  folders.sort((a, b) => a.name.localeCompare(b.name));

  folderListCache.value = folders;
  folderListCache.ts = now;
  return folders;
}

export async function findFolderIdByDate(dateStr) {
  const now = Date.now();
  const cached = folderIdCache.get(dateStr);
  if (cached && now - cached.ts < CACHE_TTL_MS.folderId) return cached.id;

  const folders = await listDateFolders();
  const match = folders.find((f) => f.name === dateStr);
  const id = match ? match.id : null;
  folderIdCache.set(dateStr, { id, ts: now });
  return id;
}

export async function listImagesInFolder(folderId) {
  const now = Date.now();
  const cached = imagesCache.get(folderId);
  if (cached && now - cached.ts < CACHE_TTL_MS.images) return cached.files;

  const drive = getDriveClient();
  const images = [];
  let pageToken;
  do {
    const res = await drive.files.list({
      q: `'${folderId}' in parents and (mimeType contains 'image/') and trashed = false`,
      fields: "nextPageToken, files(id, name)",
      pageSize: 1000,
      pageToken,
      orderBy: "name",
    });
    images.push(...(res.data.files || []));
    pageToken = res.data.nextPageToken;
  } while (pageToken);

  imagesCache.set(folderId, { files: images, ts: now });
  return images;
}

export async function trashFiles(fileIds) {
  const drive = getDriveClient();
  await Promise.all(
    fileIds.map((id) =>
      drive.files.update({ fileId: id, requestBody: { trashed: true } })
    )
  );
  
  for (const [folderId, entry] of imagesCache.entries()) {
    const remaining = entry.files.filter((f) => !fileIds.includes(f.id));
    imagesCache.set(folderId, { files: remaining, ts: Date.now() });
  }
}

export async function getFileBytes(fileId) {
  const drive = getDriveClient();
  const meta = await drive.files.get({ fileId, fields: "mimeType" });
  const res = await drive.files.get(
    { fileId, alt: "media" },
    { responseType: "arraybuffer" }
  );
  return { data: res.data, mimeType: meta.data.mimeType || "image/jpeg" };
}

export async function invalidateCachesForDate(dateStr) {
  
  folderListCache.value = null;
  folderListCache.ts = 0;
  
  folderIdCache.delete(dateStr);
  
  const folders = await listDateFolders();
  const match = folders.find((f) => f.name === dateStr);
  if (match && imagesCache.has(match.id)) {
    imagesCache.delete(match.id);
  }
}

import { getDriveClient } from "./googleAuth";

const ROOT_FOLDER_ID = process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID;

const folderListCache = { ts: 0, value: null };
const folderIdCache = new Map();
const imagesCache = new Map();
const fileBytesCache = new Map();

const CACHE_TTL_MS = {
  folders: 5 * 60 * 1000,      // 5 phút (trước: 30s)
  folderId: 10 * 60 * 1000,    // 10 phút (trước: 60s)
  images: 10 * 60 * 1000,      // 10 phút (trước: 2 phút)
  fileBytes: 2 * 60 * 60 * 1000, // 2 giờ (trước: 30 phút)
};

/**
 * Resolve Google Drive Shortcut -> target folder/file ID.
 *
 * Nếu ID truyền vào là folder thật:
 *   trả về chính ID đó.
 *
 * Nếu ID truyền vào là Shortcut:
 *   trả về shortcutDetails.targetId.
 */
async function resolveShortcutId(drive, fileId) {
  const meta = await drive.files.get({
    fileId,
    fields: "id,name,mimeType,shortcutDetails",
  });

  console.log(
    `[Google Drive] ${fileId} -> ${meta.data.name} (${meta.data.mimeType})`
  );

  // Folder/file bình thường
  if (meta.data.mimeType !== "application/vnd.google-apps.shortcut") {
    return {
      id: fileId,
      mimeType: meta.data.mimeType,
      name: meta.data.name,
    };
  }

  // Shortcut
  const targetId = meta.data.shortcutDetails?.targetId;
  const targetMimeType = meta.data.shortcutDetails?.targetMimeType;

  if (!targetId) {
    throw new Error(
      `Google Drive Shortcut không có targetId: ${fileId}`
    );
  }

  console.log(
    `[Google Drive] Shortcut detected: ${fileId} -> ${targetId} (${targetMimeType})`
  );

  return {
    id: targetId,
    mimeType: targetMimeType,
    name: meta.data.name,
  };
}

export async function listDateFolders() {
  const now = Date.now();

  if (
    folderListCache.value &&
    now - folderListCache.ts < CACHE_TTL_MS.folders
  ) {
    return folderListCache.value;
  }

  if (!ROOT_FOLDER_ID) {
    throw new Error(
      "GOOGLE_DRIVE_ROOT_FOLDER_ID chưa được cấu hình trong .env"
    );
  }

  const drive = getDriveClient();

  // ---------------------------------------------------------
  // QUAN TRỌNG:
  // Nếu ROOT_FOLDER_ID là Shortcut thì lấy targetId.
  // ---------------------------------------------------------
  const root = await resolveShortcutId(drive, ROOT_FOLDER_ID);

  const actualRootFolderId = root.id;

  console.log(
    `[Google Drive] ROOT_FOLDER_ID = ${ROOT_FOLDER_ID}`
  );

  console.log(
    `[Google Drive] Actual root folder ID = ${actualRootFolderId}`
  );

  // Đảm bảo target thực sự là folder
  if (root.mimeType !== "application/vnd.google-apps.folder") {
    throw new Error(
      `GOOGLE_DRIVE_ROOT_FOLDER_ID không trỏ tới folder. ` +
      `mimeType=${root.mimeType}`
    );
  }

  // -------------------------------------------------------
  // Lấy cả folder thường + shortcut trỏ tới folder
  // -------------------------------------------------------
  const items = [];
  let pageToken;

  do {
    const res = await drive.files.list({
      q: `'${actualRootFolderId}' in parents and (mimeType = 'application/vnd.google-apps.folder' or mimeType = 'application/vnd.google-apps.shortcut') and trashed = false`,
      fields:
        "nextPageToken, files(id, name, mimeType, shortcutDetails)",
      pageSize: 200,
      pageToken,
    });

    items.push(...(res.data.files || []));
    pageToken = res.data.nextPageToken;
  } while (pageToken);

  // Tách folder thường và shortcut trỏ tới folder
  const regularFolders = items.filter(
    (f) => f.mimeType === "application/vnd.google-apps.folder"
  );

  const shortcuts = items.filter(
    (f) =>
      f.mimeType === "application/vnd.google-apps.shortcut" &&
      f.shortcutDetails?.targetMimeType ===
        "application/vnd.google-apps.folder" &&
      f.shortcutDetails?.targetId
  );

  // -------------------------------------------------------
  // Với mỗi shortcut trỏ tới folder:
  //   nhảy VÀO folder đó, liệt kê các thư mục con (ngày)
  //   bên trong rồi gộp chung với folder ở root.
  // -------------------------------------------------------
  const subFoldersFromShortcuts = [];

  await Promise.all(
    shortcuts.map(async (sc) => {
      try {
        const targetId = sc.shortcutDetails.targetId;

        console.log(
          `[Google Drive] Shortcut "${sc.name}" -> đi vào folder ${targetId} để tìm thư mục ngày`
        );

        // Liệt kê thư mục con bên trong folder mà shortcut trỏ tới
        let pt;
        do {
          const res = await drive.files.list({
            q: `'${targetId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
            fields: "nextPageToken, files(id, name)",
            pageSize: 200,
            pageToken: pt,
          });

          const subFolders = res.data.files || [];
          subFoldersFromShortcuts.push(...subFolders);

          for (const sf of subFolders) {
            console.log(
              `[Google Drive]   -> tìm thấy thư mục "${sf.name}" (${sf.id})`
            );
          }

          pt = res.data.nextPageToken;
        } while (pt);
      } catch (err) {
        console.warn(
          `[Google Drive] Không thể liệt kê bên trong shortcut "${sc.name}" (${sc.shortcutDetails.targetId}):`,
          err.message
        );
      }
    })
  );

  // Gộp tất cả và loại bỏ trùng lặp
  const seenIds = new Set();
  const folders = [];

  for (const f of [...regularFolders, ...subFoldersFromShortcuts]) {
    if (!seenIds.has(f.id)) {
      seenIds.add(f.id);
      folders.push({ id: f.id, name: f.name });
    }
  }

  folders.sort((a, b) => a.name.localeCompare(b.name));

  folderListCache.value = folders;
  folderListCache.ts = now;

  return folders;
}

export async function findFolderIdByDate(dateStr) {
  const now = Date.now();

  const cached = folderIdCache.get(dateStr);

  if (
    cached &&
    now - cached.ts < CACHE_TTL_MS.folderId
  ) {
    return cached.id;
  }

  const folders = await listDateFolders();

  const match = folders.find((f) => f.name === dateStr);

  const id = match ? match.id : null;

  folderIdCache.set(dateStr, {
    id,
    ts: now,
  });

  return id;
}

export async function listImagesInFolder(folderId) {
  const now = Date.now();

  const cached = imagesCache.get(folderId);

  if (
    cached &&
    now - cached.ts < CACHE_TTL_MS.images
  ) {
    return cached.files;
  }

  const drive = getDriveClient();

  // -------------------------------------------------------
  // Lấy cả ảnh thường + shortcut trỏ tới ảnh
  // -------------------------------------------------------
  const items = [];
  let pageToken;

  do {
    const res = await drive.files.list({
      q: `'${folderId}' in parents and (mimeType contains 'image/' or mimeType = 'application/vnd.google-apps.shortcut') and trashed = false`,
      fields:
        "nextPageToken, files(id, name, mimeType, shortcutDetails, thumbnailLink)",
      pageSize: 1000,
      pageToken,
      orderBy: "name",
    });

    items.push(...(res.data.files || []));

    pageToken = res.data.nextPageToken;
  } while (pageToken);

  // Tách ảnh thường và shortcut trỏ tới ảnh
  const regularImages = items.filter(
    (f) => f.mimeType !== "application/vnd.google-apps.shortcut"
  );

  const shortcuts = items.filter(
    (f) =>
      f.mimeType === "application/vnd.google-apps.shortcut" &&
      f.shortcutDetails?.targetMimeType?.startsWith("image/") &&
      f.shortcutDetails?.targetId
  );

  // Resolve shortcut -> lấy metadata ảnh đích (kèm thumbnailLink)
  const resolvedShortcuts = await Promise.all(
    shortcuts.map(async (sc) => {
      try {
        const targetMeta = await drive.files.get({
          fileId: sc.shortcutDetails.targetId,
          fields: "id, name, thumbnailLink",
        });
        console.log(
          `[Google Drive] Image shortcut "${sc.name}" -> "${targetMeta.data.name}" (${sc.shortcutDetails.targetId})`
        );
        return {
          id: targetMeta.data.id,
          name: targetMeta.data.name,
          thumbnailLink: targetMeta.data.thumbnailLink || null,
        };
      } catch (err) {
        console.warn(
          `[Google Drive] Không thể resolve image shortcut "${sc.name}" (${sc.shortcutDetails.targetId}):`,
          err.message
        );
        return null;
      }
    })
  );

  // Gộp và loại bỏ trùng lặp
  const seenIds = new Set();
  const images = [];

  for (const f of regularImages) {
    if (!seenIds.has(f.id)) {
      seenIds.add(f.id);
      images.push({
        id: f.id,
        name: f.name,
        thumbnailLink: f.thumbnailLink || null,
      });
    }
  }

  for (const f of resolvedShortcuts) {
    if (f && !seenIds.has(f.id)) {
      seenIds.add(f.id);
      images.push({
        id: f.id,
        name: f.name,
        thumbnailLink: f.thumbnailLink || null,
      });
    }
  }

  // Sắp xếp lại theo tên sau khi gộp
  images.sort((a, b) => a.name.localeCompare(b.name));

  imagesCache.set(folderId, {
    files: images,
    ts: now,
  });

  return images;
}

export async function trashFiles(fileIds) {
  const drive = getDriveClient();

  await Promise.all(
    fileIds.map((id) =>
      drive.files.update({
        fileId: id,
        requestBody: {
          trashed: true,
        },
      })
    )
  );

  for (const [folderId, entry] of imagesCache.entries()) {
    const remaining = entry.files.filter(
      (f) => !fileIds.includes(f.id)
    );

    imagesCache.set(folderId, {
      files: remaining,
      ts: Date.now(),
    });
  }
}

export async function getFileBytes(fileId) {
  const now = Date.now();

  const cached = fileBytesCache.get(fileId);

  if (
    cached &&
    now - cached.ts < CACHE_TTL_MS.fileBytes
  ) {
    return cached.value;
  }

  const drive = getDriveClient();

  const meta = await drive.files.get({
    fileId,
    fields: "mimeType",
  });

  const res = await drive.files.get(
    {
      fileId,
      alt: "media",
    },
    {
      responseType: "arraybuffer",
    }
  );

  const value = {
    data: res.data,
    mimeType: meta.data.mimeType || "image/jpeg",
  };

  fileBytesCache.set(fileId, {
    value,
    ts: now,
  });

  return value;
}

export async function getFileThumbnailUrl(fileId) {
  const drive = getDriveClient();

  const meta = await drive.files.get({
    fileId,
    fields: "thumbnailLink",
  });

  return (
    meta.data.thumbnailLink ||
    `https://drive.google.com/thumbnail?id=${encodeURIComponent(
      fileId
    )}&sz=w400`
  );
}

export async function getFileThumbnailBytes(fileId) {
  const thumbUrl = await getFileThumbnailUrl(fileId);

  const res = await fetch(thumbUrl, {
    headers: {
      Accept: "image/*",
    },
  });

  if (!res.ok) {
    throw new Error(
      `thumbnail fetch failed: ${res.status}`
    );
  }

  const buffer = Buffer.from(
    await res.arrayBuffer()
  );

  return {
    data: buffer,
    mimeType:
      res.headers.get("content-type") || "image/jpeg",
  };
}

export async function invalidateCachesForDate(dateStr) {
  folderListCache.value = null;
  folderListCache.ts = 0;

  folderIdCache.delete(dateStr);

  const folders = await listDateFolders();

  const match = folders.find(
    (f) => f.name === dateStr
  );

  if (match && imagesCache.has(match.id)) {
    imagesCache.delete(match.id);
  }

  for (const key of fileBytesCache.keys()) {
    fileBytesCache.delete(key);
  }
}
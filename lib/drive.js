import { getDriveClient } from "./googleAuth";

const ROOT_FOLDER_ID = process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID;

const folderListCache = { ts: 0, value: null };
const folderIdCache = new Map();
const imagesCache = new Map();
const fileBytesCache = new Map();

const CACHE_TTL_MS = {
  folders: 5 * 60 * 1000,      // 5 phút
  folderId: 10 * 60 * 1000,    // 10 phút
  images: 10 * 60 * 1000,      // 10 phút
  fileBytes: 2 * 60 * 60 * 1000, // 2 giờ
};

/**
 * Resolve Google Drive Shortcut -> target folder/file ID (hỗ trợ đệ quy nếu shortcut lồng shortcut).
 */
async function resolveShortcutId(drive, fileId, depth = 0) {
  if (!fileId || depth > 5) return { id: fileId, mimeType: "", name: "" };

  try {
    const meta = await drive.files.get({
      fileId,
      fields: "id,name,mimeType,shortcutDetails",
      supportsAllDrives: true,
    });

    if (meta.data.mimeType !== "application/vnd.google-apps.shortcut") {
      return {
        id: fileId,
        mimeType: meta.data.mimeType,
        name: meta.data.name,
      };
    }

    const targetId = meta.data.shortcutDetails?.targetId;
    const targetMimeType = meta.data.shortcutDetails?.targetMimeType;

    if (!targetId) {
      return {
        id: fileId,
        mimeType: meta.data.mimeType,
        name: meta.data.name,
      };
    }

    console.log(
      `[Google Drive] Shortcut detected: ${fileId} -> ${targetId} (${targetMimeType})`
    );

    // Nếu target lại là shortcut khác, resolve tiếp
    if (targetMimeType === "application/vnd.google-apps.shortcut") {
      return await resolveShortcutId(drive, targetId, depth + 1);
    }

    return {
      id: targetId,
      mimeType: targetMimeType,
      name: meta.data.name,
    };
  } catch (err) {
    console.warn(`[Google Drive] Lỗi resolveShortcutId cho ${fileId}:`, err.message);
    return { id: fileId, mimeType: "", name: "" };
  }
}

/**
 * Tìm hoặc tạo 1 folder theo tên bên trong folder cha.
 * Trả về folder ID hoặc null nếu không có quyền / lỗi.
 */
async function findOrCreateFolder(drive, parentId, folderName) {
  if (!parentId) return null;

  try {
    const res = await drive.files.list({
      q: `'${parentId}' in parents and name = '${folderName}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
      fields: "files(id, name)",
      pageSize: 1,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });

    if (res.data.files && res.data.files.length > 0) {
      return res.data.files[0].id;
    }

    // Chưa có → tạo mới
    const createRes = await drive.files.create({
      requestBody: {
        name: folderName,
        mimeType: "application/vnd.google-apps.folder",
        parents: [parentId],
      },
      fields: "id",
      supportsAllDrives: true,
    });

    console.log(
      `[Google Drive] Tạo folder "${folderName}" (${createRes.data.id}) trong ${parentId}`
    );

    return createRes.data.id;
  } catch (err) {
    console.warn(
      `[Google Drive] findOrCreateFolder "${folderName}" trong "${parentId}" thất bại:`,
      err.message
    );
    return null;
  }
}

/**
 * Lấy parent folder ID của 1 file/folder.
 */
async function getParentFolderId(drive, folderId) {
  if (!folderId) return null;
  try {
    const res = await drive.files.get({
      fileId: folderId,
      fields: "parents",
      supportsAllDrives: true,
    });
    return res.data.parents && res.data.parents.length > 0 ? res.data.parents[0] : null;
  } catch (err) {
    console.warn(`[Google Drive] getParentFolderId thất bại cho ${folderId}:`, err.message);
    return null;
  }
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

  // Resolve ROOT_FOLDER_ID nếu là Shortcut
  const root = await resolveShortcutId(drive, ROOT_FOLDER_ID);
  const actualRootFolderId = root.id;

  console.log(`[Google Drive] ROOT_FOLDER_ID = ${ROOT_FOLDER_ID}`);
  console.log(`[Google Drive] Actual root folder ID = ${actualRootFolderId}`);

  // Liệt kê cả folder thường + shortcut trong actualRootFolderId
  const items = [];
  let pageToken;

  do {
    const res = await drive.files.list({
      q: `'${actualRootFolderId}' in parents and (mimeType = 'application/vnd.google-apps.folder' or mimeType = 'application/vnd.google-apps.shortcut') and trashed = false`,
      fields: "nextPageToken, files(id, name, mimeType, shortcutDetails)",
      pageSize: 200,
      pageToken,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });

    items.push(...(res.data.files || []));
    pageToken = res.data.nextPageToken;
  } while (pageToken);

  const regularFolders = items.filter(
    (f) => f.mimeType === "application/vnd.google-apps.folder"
  );

  const shortcuts = items.filter(
    (f) =>
      f.mimeType === "application/vnd.google-apps.shortcut" &&
      f.shortcutDetails?.targetMimeType === "application/vnd.google-apps.folder" &&
      f.shortcutDetails?.targetId
  );

  const subFoldersFromShortcuts = [];
  const directShortcutFolders = [];

  await Promise.all(
    shortcuts.map(async (sc) => {
      try {
        const targetId = sc.shortcutDetails.targetId;

        console.log(
          `[Google Drive] Shortcut "${sc.name}" -> kiểm tra folder ${targetId}`
        );

        // Liệt kê thư mục con bên trong folder mà shortcut trỏ tới
        let pt;
        let foundSubFolders = false;
        do {
          const res = await drive.files.list({
            q: `'${targetId}' in parents and (mimeType = 'application/vnd.google-apps.folder' or mimeType = 'application/vnd.google-apps.shortcut') and trashed = false`,
            fields: "nextPageToken, files(id, name, mimeType, shortcutDetails)",
            pageSize: 200,
            pageToken: pt,
            supportsAllDrives: true,
            includeItemsFromAllDrives: true,
          });

          const subFiles = res.data.files || [];
          for (const sf of subFiles) {
            if (sf.mimeType === "application/vnd.google-apps.folder") {
              subFoldersFromShortcuts.push({ id: sf.id, name: sf.name });
              foundSubFolders = true;
            } else if (
              sf.mimeType === "application/vnd.google-apps.shortcut" &&
              sf.shortcutDetails?.targetMimeType === "application/vnd.google-apps.folder"
            ) {
              subFoldersFromShortcuts.push({
                id: sf.shortcutDetails.targetId,
                name: sf.name,
              });
              foundSubFolders = true;
            }
          }

          pt = res.data.nextPageToken;
        } while (pt);

        // Nếu shortcut trỏ trực tiếp đến thư mục ngày (không có subfolder bên trong)
        if (!foundSubFolders) {
          directShortcutFolders.push({
            id: targetId,
            name: sc.name,
          });
        }
      } catch (err) {
        console.warn(
          `[Google Drive] Không thể liệt kê bên trong shortcut "${sc.name}" (${sc.shortcutDetails.targetId}):`,
          err.message
        );
        // Fallback: coi chính shortcut này là thư mục ngày
        directShortcutFolders.push({
          id: sc.shortcutDetails.targetId,
          name: sc.name,
        });
      }
    })
  );

  // Gộp tất cả và loại bỏ trùng lặp
  const seenIds = new Set();
  let folders = [];

  for (const f of [
    ...regularFolders,
    ...subFoldersFromShortcuts,
    ...directShortcutFolders,
  ]) {
    if (!seenIds.has(f.id)) {
      seenIds.add(f.id);
      folders.push({ id: f.id, name: f.name });
    }
  }

  // Loại bỏ folder "Deleted" (dùng cho soft-delete ảnh)
  folders = folders.filter((f) => f.name !== "Deleted");

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

  // Resolve folderId nếu chính nó là Shortcut
  const resolvedFolder = await resolveShortcutId(drive, folderId);
  const actualFolderId = resolvedFolder.id;

  // Lấy cả ảnh thường + shortcut trỏ tới ảnh
  const items = [];
  let pageToken;

  do {
    const res = await drive.files.list({
      q: `'${actualFolderId}' in parents and (mimeType contains 'image/' or mimeType = 'application/vnd.google-apps.shortcut') and trashed = false`,
      fields:
        "nextPageToken, files(id, name, mimeType, shortcutDetails, thumbnailLink)",
      pageSize: 1000,
      pageToken,
      orderBy: "name",
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
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
          supportsAllDrives: true,
        });
        console.log(
          `[Google Drive] Image shortcut "${sc.name}" -> "${targetMeta.data.name}" (${sc.shortcutDetails.targetId})`
        );
        return {
          id: targetMeta.data.id,
          name: targetMeta.data.name || sc.name,
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

  if (actualFolderId !== folderId) {
    imagesCache.set(actualFolderId, {
      files: images,
      ts: now,
    });
  }

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
        supportsAllDrives: true,
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

/**
 * Di chuyển file sang folder đích, fallback trash nếu không có quyền.
 * Nhận parentToRemove trực tiếp (đã biết từ caller) để tránh API call thừa.
 */
async function moveOrTrashFile(drive, fileId, parentToRemove, targetFolderId) {
  // 1. Thử di chuyển sang targetFolderId nếu có
  if (targetFolderId) {
    try {
      const updateParams = {
        fileId,
        addParents: targetFolderId,
        supportsAllDrives: true,
        fields: "id, parents",
      };
      if (parentToRemove) {
        updateParams.removeParents = parentToRemove;
      }
      await drive.files.update(updateParams);
      console.log(`[Google Drive] Đã chuyển file ${fileId} sang folder ${targetFolderId}`);
      return;
    } catch (moveErr) {
      console.warn(
        `[Google Drive] Không thể chuyển file ${fileId} sang ${targetFolderId} (${moveErr.message}), thử trash...`
      );
    }
  }

  // 2. Fallback: trash
  try {
    await drive.files.update({
      fileId,
      requestBody: { trashed: true },
      supportsAllDrives: true,
    });
    console.log(`[Google Drive] Đã chuyển file ${fileId} vào thùng rác (trashed)`);
    return;
  } catch (trashErr) {
    console.warn(
      `[Google Drive] Không thể trash file ${fileId} (${trashErr.message}), thử gỡ khỏi parent...`
    );
  }

  // 3. Fallback cuối: gỡ khỏi parent
  if (parentToRemove) {
    await drive.files.update({
      fileId,
      removeParents: parentToRemove,
      supportsAllDrives: true,
    });
    console.log(`[Google Drive] Đã gỡ file ${fileId} khỏi parent ${parentToRemove}`);
  }
}

// Cache folder Deleted/{dateStr} để không phải tìm/tạo mỗi lần xóa
const deletedFolderCache = new Map(); // dateStr -> { id, ts }
const DELETED_CACHE_TTL = 10 * 60 * 1000; // 10 phút

/**
 * Tìm hoặc tạo folder Deleted/{dateStr}, có cache.
 */
async function getOrCreateDeletedDateFolder(drive, dateStr) {
  const cached = deletedFolderCache.get(dateStr);
  if (cached && Date.now() - cached.ts < DELETED_CACHE_TTL) {
    return cached.id;
  }

  const dateFolderId = await findFolderIdByDate(dateStr);
  if (!dateFolderId) return null;

  const resolvedDateFolder = await resolveShortcutId(drive, dateFolderId);
  const actualDateFolderId = resolvedDateFolder.id;

  const root = await resolveShortcutId(drive, ROOT_FOLDER_ID);
  const actualRootFolderId = root.id;

  const dateFolderParentId = await getParentFolderId(drive, actualDateFolderId);

  let deletedFolderId = null;
  if (dateFolderParentId) {
    deletedFolderId = await findOrCreateFolder(drive, dateFolderParentId, "Deleted");
  }
  if (!deletedFolderId && actualRootFolderId) {
    deletedFolderId = await findOrCreateFolder(drive, actualRootFolderId, "Deleted");
  }

  let deletedDateFolderId = null;
  if (deletedFolderId) {
    deletedDateFolderId = await findOrCreateFolder(drive, deletedFolderId, dateStr);
  }

  if (deletedDateFolderId) {
    deletedFolderCache.set(dateStr, { id: deletedDateFolderId, ts: Date.now() });
  }

  return deletedDateFolderId;
}

/**
 * Di chuyển ảnh vào thư mục Deleted/{dateStr}.
 * TỐI ƯU: Không list toàn bộ folder — tìm file/shortcut chính xác trong date folder.
 *
 * Lưu ý: fileId từ frontend là ID ảnh gốc (đã resolve shortcut). Ảnh gốc có thể
 * nằm ở folder khác, và trong date folder chỉ có shortcut trỏ tới nó. Vì vậy
 * cần tìm shortcut trong DATE FOLDER (không phải trong parent của ảnh gốc).
 */
export async function moveFilesToDeleted(fileIds, dateStr) {
  const drive = getDriveClient();

  // 1. Tìm/tạo folder Deleted/{dateStr} (có cache)
  const deletedDateFolderId = await getOrCreateDeletedDateFolder(drive, dateStr);

  // 2. Xác định date folder ID (nơi chứa ảnh/shortcut cần xóa)
  const dateFolderId = await findFolderIdByDate(dateStr);
  if (!dateFolderId) {
    console.error(`[Google Drive] Không tìm thấy folder cho ngày: ${dateStr}`);
    return;
  }
  const resolvedDateFolder = await resolveShortcutId(drive, dateFolderId);
  const dateFolderIds = [...new Set([dateFolderId, resolvedDateFolder.id])];

  // 3. Di chuyển từng file
  for (const targetFileId of fileIds) {
    try {
      // Bước A: Kiểm tra file có nằm trực tiếp trong date folder không
      const fileMeta = await drive.files.get({
        fileId: targetFileId,
        fields: "id, name, parents",
        supportsAllDrives: true,
      });

      const fileParents = fileMeta.data.parents || [];
      const isDirectlyInDateFolder = fileParents.some((p) => dateFolderIds.includes(p));

      if (isDirectlyInDateFolder) {
        // File nằm trực tiếp trong date folder → di chuyển file
        const parentToRemove = fileParents.find((p) => dateFolderIds.includes(p));
        await moveOrTrashFile(drive, targetFileId, parentToRemove, deletedDateFolderId);
        console.log(`[Google Drive] Đã xử lý file trực tiếp: ${fileMeta.data.name}`);
        continue;
      }

      // Bước B: File không trực tiếp trong date folder → tìm shortcut trong date folder
      // Tìm theo tên file trước (nhanh), rồi mới fallback tìm toàn bộ (có pagination)
      const fileName = fileMeta.data.name;
      let moved = false;
      for (const dfId of dateFolderIds) {
        try {
          // B1: Tìm shortcut theo tên file (hầu hết shortcut có tên giống file gốc)
          const escapedName = fileName.replace(/'/g, "\\'");
          const scByNameRes = await drive.files.list({
            q: `'${dfId}' in parents and mimeType = 'application/vnd.google-apps.shortcut' and name = '${escapedName}' and trashed = false`,
            fields: "files(id, name, shortcutDetails)",
            pageSize: 10,
            supportsAllDrives: true,
            includeItemsFromAllDrives: true,
          });
          const scByName = (scByNameRes.data.files || []).find(
            (f) => f.shortcutDetails?.targetId === targetFileId
          );
          if (scByName) {
            await moveOrTrashFile(drive, scByName.id, dfId, deletedDateFolderId);
            console.log(`[Google Drive] Đã xử lý shortcut "${scByName.name}" → ${targetFileId}`);
            moved = true;
            break;
          }

          // B2: Không tìm thấy theo tên → tìm toàn bộ shortcut (có pagination)
          let scPageToken;
          do {
            const scRes = await drive.files.list({
              q: `'${dfId}' in parents and mimeType = 'application/vnd.google-apps.shortcut' and trashed = false`,
              fields: "nextPageToken, files(id, name, shortcutDetails)",
              pageSize: 1000,
              pageToken: scPageToken,
              supportsAllDrives: true,
              includeItemsFromAllDrives: true,
            });
            const sc = (scRes.data.files || []).find(
              (f) => f.shortcutDetails?.targetId === targetFileId
            );
            if (sc) {
              await moveOrTrashFile(drive, sc.id, dfId, deletedDateFolderId);
              console.log(`[Google Drive] Đã xử lý shortcut "${sc.name}" → ${targetFileId}`);
              moved = true;
              break;
            }
            scPageToken = scRes.data.nextPageToken;
          } while (scPageToken && !moved);
          if (moved) break;
        } catch (_e) {
          console.warn(`[Google Drive] Lỗi tìm shortcut trong folder ${dfId}:`, _e.message);
        }
      }

      if (!moved) {
        // Không tìm thấy shortcut — thử di chuyển file gốc trực tiếp
        console.warn(`[Google Drive] Không tìm thấy shortcut cho ${targetFileId}, thử di chuyển trực tiếp`);
        const parentToRemove = fileParents[0] || null;
        await moveOrTrashFile(drive, targetFileId, parentToRemove, deletedDateFolderId);
      }
    } catch (err) {
      console.error(`[Google Drive] Lỗi xử lý xoá file ${targetFileId}:`, err.message);
      // Fallback: trash trực tiếp
      try {
        await drive.files.update({
          fileId: targetFileId,
          requestBody: { trashed: true },
          supportsAllDrives: true,
        });
        console.log(`[Google Drive] Fallback: đã trash file ${targetFileId}`);
      } catch (trashErr) {
        console.error(`[Google Drive] Không thể trash file ${targetFileId}:`, trashErr.message);
      }
    }
  }

  // 4. Cập nhật cache ảnh
  for (const [fId, entry] of imagesCache.entries()) {
    const remaining = entry.files.filter((f) => !fileIds.includes(f.id));
    imagesCache.set(fId, {
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
    fields: "id, mimeType, shortcutDetails",
    supportsAllDrives: true,
  });

  let realFileId = fileId;
  let mimeType = meta.data.mimeType;

  if (meta.data.mimeType === "application/vnd.google-apps.shortcut") {
    realFileId = meta.data.shortcutDetails?.targetId || fileId;
    mimeType = meta.data.shortcutDetails?.targetMimeType || "image/jpeg";
  }

  const res = await drive.files.get(
    {
      fileId: realFileId,
      alt: "media",
      supportsAllDrives: true,
    },
    {
      responseType: "arraybuffer",
    }
  );

  const value = {
    data: res.data,
    mimeType: mimeType || "image/jpeg",
  };

  fileBytesCache.set(fileId, {
    value,
    ts: now,
  });

  return value;
}

export async function getFileThumbnailUrl(fileId) {
  const drive = getDriveClient();

  try {
    const meta = await drive.files.get({
      fileId,
      fields: "id, thumbnailLink, mimeType, shortcutDetails",
      supportsAllDrives: true,
    });

    let targetId = fileId;
    let thumbnailLink = meta.data.thumbnailLink;

    if (meta.data.mimeType === "application/vnd.google-apps.shortcut") {
      targetId = meta.data.shortcutDetails?.targetId || fileId;
      if (!thumbnailLink && targetId !== fileId) {
        try {
          const targetMeta = await drive.files.get({
            fileId: targetId,
            fields: "thumbnailLink",
            supportsAllDrives: true,
          });
          thumbnailLink = targetMeta.data.thumbnailLink;
        } catch (e) {}
      }
    }

    return (
      thumbnailLink ||
      `https://drive.google.com/thumbnail?id=${encodeURIComponent(
        targetId
      )}&sz=w400`
    );
  } catch (err) {
    return `https://drive.google.com/thumbnail?id=${encodeURIComponent(
      fileId
    )}&sz=w400`;
  }
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
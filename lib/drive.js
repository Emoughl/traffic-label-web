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
  let moveError = targetFolderId ? null : "không xác định được folder đích";
  // 1. Thử di chuyển sang targetFolderId nếu có
  if (targetFolderId) {
    // Drive không cho 1 file có nhiều parent: bắt buộc phải biết parent cũ để gỡ.
    // Nếu chưa biết, hỏi lại API (chỉ đọc được khi tài khoản có quyền trên parent).
    if (!parentToRemove) {
      try {
        const meta = await drive.files.get({
          fileId,
          fields: "parents",
          supportsAllDrives: true,
        });
        parentToRemove = (meta.data.parents || []).join(",") || null;
      } catch (_e) {
        /* bỏ qua, thử move không kèm removeParents */
      }
    }

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
      return { action: "moved" };
    } catch (moveErr) {
      const m = moveErr.message || "";
      if (/parents is not allowed/i.test(m)) {
        console.error(
          `[Google Drive] Không đọc được parent của ${fileId} → service account thiếu quyền trên folder chứa ảnh. ` +
            `Hãy share folder gốc cho ${process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || "service account"} với quyền "Người chỉnh sửa".`
        );
      } else if (/sufficient permissions/i.test(m)) {
        console.error(
          `[Google Drive] Service account chỉ có quyền XEM file ${fileId}. ` +
            `Cần quyền "Người chỉnh sửa" mới move được.`
        );
      } else {
        console.warn(`[Google Drive] Không thể chuyển file ${fileId} sang ${targetFolderId}: ${m}`);
      }
      moveError = m;
    }
  }

  // 2. Fallback trash — MẶC ĐỊNH TẮT. Move hỏng thì để nguyên file trên Drive
  // (Sheets đã ghi DELETED nên ảnh vẫn ẩn khỏi tool), tránh lỡ tay vứt dữ liệu
  // gốc vào thùng rác. Bật lại bằng DRIVE_DELETE_FALLBACK_TRASH=1.
  if (!["1", "true", "yes"].includes(String(process.env.DRIVE_DELETE_FALLBACK_TRASH || "").toLowerCase())) {
    console.warn(`[Google Drive] Bỏ qua file ${fileId}: không move được, giữ nguyên trên Drive.`);
    return { action: "failed", error: moveError };
  }

  try {
    await drive.files.update({
      fileId,
      requestBody: { trashed: true },
      supportsAllDrives: true,
    });
    console.log(`[Google Drive] Đã chuyển file ${fileId} vào thùng rác (trashed)`);
    return { action: "trashed", error: moveError };
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

// Nơi chứa ảnh bị xoá. MẶC ĐỊNH: Deleted/{ngày} — mỗi ngày một folder riêng,
// tự tạo nếu chưa có.
// Tuỳ chọn ghi đè:
// - GOOGLE_DRIVE_BACKUP_FOLDER_ID: đổ hết vào đúng folder này (bỏ qua Deleted)
// - GOOGLE_DRIVE_BACKUP_FOLDER_NAME: dùng Deleted/{tên} thay cho Deleted/{ngày}
// - GOOGLE_DRIVE_BACKUP_BY_DATE=1: thêm 1 cấp {ngày} bên trong 2 lựa chọn trên
const BACKUP_FOLDER_ID = process.env.GOOGLE_DRIVE_BACKUP_FOLDER_ID || "";
const BACKUP_FOLDER_NAME = process.env.GOOGLE_DRIVE_BACKUP_FOLDER_NAME || "";
const BACKUP_BY_DATE = ["1", "true", "yes"].includes(
  String(process.env.GOOGLE_DRIVE_BACKUP_BY_DATE || "").toLowerCase()
);

// Cache folder đích để không phải tìm/tạo mỗi lần xóa
const deletedFolderCache = new Map(); // cacheKey -> { id, label, ts }
const DELETED_CACHE_TTL = 10 * 60 * 1000; // 10 phút

/**
 * Tìm hoặc tạo folder đích cho ảnh bị xoá của ngày `dateStr`.
 * Mặc định trả về Deleted/{dateStr}.
 */
async function getOrCreateDeletedDateFolder(drive, dateStr) {
  const mode = BACKUP_FOLDER_ID ? `id:${BACKUP_FOLDER_ID}` : BACKUP_FOLDER_NAME || "by-date";
  const cacheKey = `${mode}|${BACKUP_BY_DATE ? dateStr : BACKUP_FOLDER_NAME ? "flat" : dateStr}`;
  const cached = deletedFolderCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < DELETED_CACHE_TTL) {
    return { id: cached.id, label: cached.label };
  }

  // (1) Cấu hình sẵn ID folder đích → dùng luôn
  if (BACKUP_FOLDER_ID) {
    let id = BACKUP_FOLDER_ID;
    let label = "folder backup (cấu hình sẵn)";
    try {
      const meta = await drive.files.get({ fileId: id, fields: "name", supportsAllDrives: true });
      if (meta.data.name) label = meta.data.name;
    } catch (e) {
      console.warn(`[Deleted] Không đọc được GOOGLE_DRIVE_BACKUP_FOLDER_ID=${id}: ${e.message}`);
    }
    if (BACKUP_BY_DATE) {
      const sub = await findOrCreateFolder(drive, id, dateStr);
      if (sub) { id = sub; label += `/${dateStr}`; }
    }
    console.log(`[Deleted] Folder đích: ${label} (${id})`);
    deletedFolderCache.set(cacheKey, { id, label, ts: Date.now() });
    return { id, label };
  }

  // (2) Tìm folder "Deleted" nằm cạnh các folder ngày
  const dateFolderId = await findFolderIdByDate(dateStr);
  if (!dateFolderId) {
    console.error(`[Deleted] Không tìm thấy folder ngày ${dateStr}`);
    return { id: null, label: null };
  }

  const resolvedDateFolder = await resolveShortcutId(drive, dateFolderId);
  const root = await resolveShortcutId(drive, ROOT_FOLDER_ID);
  const dateFolderParentId = await getParentFolderId(drive, resolvedDateFolder.id);

  let deletedFolderId = null;
  if (dateFolderParentId) {
    deletedFolderId = await findOrCreateFolder(drive, dateFolderParentId, "Deleted");
  }
  if (!deletedFolderId && root.id) {
    deletedFolderId = await findOrCreateFolder(drive, root.id, "Deleted");
  }
  if (!deletedFolderId) {
    console.error("[Deleted] Không tìm/tạo được folder 'Deleted'");
    return { id: null, label: null };
  }

  // (3) Cấp con bên trong Deleted
  let targetId;
  let label;
  if (BACKUP_FOLDER_NAME) {
    targetId = await findOrCreateFolder(drive, deletedFolderId, BACKUP_FOLDER_NAME);
    label = `Deleted/${BACKUP_FOLDER_NAME}`;
    if (targetId && BACKUP_BY_DATE) {
      const sub = await findOrCreateFolder(drive, targetId, dateStr);
      if (sub) { targetId = sub; label += `/${dateStr}`; }
    }
  } else {
    // Mặc định: mỗi ngày một folder riêng
    targetId = await findOrCreateFolder(drive, deletedFolderId, dateStr);
    label = `Deleted/${dateStr}`;
  }

  if (!targetId) {
    console.error(`[Deleted] Không tạo được folder đích trong Deleted cho ${dateStr}`);
    return { id: null, label: null };
  }

  console.log(`[Deleted] Folder đích: ${label} (${targetId})`);
  deletedFolderCache.set(cacheKey, { id: targetId, label, ts: Date.now() });
  return { id: targetId, label };
}

/**
 * Di chuyển ảnh vào thư mục backup ảnh đã xoá (mặc định Deleted/backupimage).
 * TỐI ƯU: Không list toàn bộ folder — tìm file/shortcut chính xác trong date folder.
 *
 * Lưu ý: fileId từ frontend là ID ảnh gốc (đã resolve shortcut). Ảnh gốc có thể
 * nằm ở folder khác, và trong date folder chỉ có shortcut trỏ tới nó. Vì vậy
 * cần tìm shortcut trong DATE FOLDER (không phải trong parent của ảnh gốc).
 */
export async function moveFilesToDeleted(fileIds, dateStr, userDrive = null) {
  // Ưu tiên client của người đăng nhập cho các thao tác GHI: service account
  // thường chỉ có quyền Xem trên kho ảnh gốc nên không move được.
  const drive = userDrive || getDriveClient();
  console.log(
    `[Deleted] Thực hiện move bằng: ${userDrive ? "tài khoản người đăng nhập (OAuth)" : "service account"}`
  );

  // 1. Tìm/tạo folder đích (có cache)
  const { id: deletedDateFolderId, label: targetLabel } = await getOrCreateDeletedDateFolder(drive, dateStr);
  if (!deletedDateFolderId) {
    console.error("[Deleted] KHÔNG có folder đích → file sẽ bị đưa vào Thùng rác của Drive");
  }

  // 2. Xác định date folder ID (nơi chứa ảnh/shortcut cần xóa)
  const dateFolderId = await findFolderIdByDate(dateStr);
  if (!dateFolderId) {
    console.error(`[Google Drive] Không tìm thấy folder cho ngày: ${dateStr}`);
    return { target: targetLabel, targetId: deletedDateFolderId, moved: 0 };
  }
  const resolvedDateFolder2 = await resolveShortcutId(drive, dateFolderId);
  const dateFolderIds = [...new Set([dateFolderId, resolvedDateFolder2.id])];

  // 3. Di chuyển từng file
  const results = [];
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
        const r = await moveOrTrashFile(drive, targetFileId, parentToRemove, deletedDateFolderId);
        results.push({ fileId: targetFileId, name: fileMeta.data.name, ...(r || { action: "moved" }) });
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
            const r = await moveOrTrashFile(drive, scByName.id, dfId, deletedDateFolderId);
            results.push({ fileId: targetFileId, shortcut: scByName.id, ...(r || { action: "moved" }) });
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
              const r = await moveOrTrashFile(drive, sc.id, dfId, deletedDateFolderId);
              results.push({ fileId: targetFileId, shortcut: sc.id, ...(r || { action: "moved" }) });
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
        const r = await moveOrTrashFile(drive, targetFileId, parentToRemove, deletedDateFolderId);
        results.push({ fileId: targetFileId, ...(r || { action: "moved" }) });
      }
    } catch (err) {
      console.error(`[Google Drive] Lỗi xử lý xoá file ${targetFileId}:`, err.message);
      results.push({ fileId: targetFileId, action: "error", error: err.message });
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

  const okCount = results.filter((r) => r.action === "moved").length;
  const firstErr = results.find((r) => r.action !== "moved");
  return {
    target: targetLabel,
    targetId: deletedDateFolderId,
    moved: okCount,
    failed: results.length - okCount,
    error: firstErr ? firstErr.error || firstErr.action : null,
    results,
  };
}

/** Xoá cache folder đích (gọi khi vừa đổi cấu hình / vừa tạo folder trên Drive). */
export function clearDeletedFolderCache() {
  deletedFolderCache.clear();
}

/**
 * Khôi phục ảnh đã xoá: chuyển file từ folder backup trở lại folder ngày.
 * Dùng client của người đăng nhập (service account thường không đủ quyền).
 */
export async function restoreFilesToDateFolder(fileIds, dateStr, userDrive = null) {
  const drive = userDrive || getDriveClient();

  const dateFolderId = await findFolderIdByDate(dateStr);
  if (!dateFolderId) {
    return { restored: 0, failed: fileIds.length, error: `không tìm thấy folder ngày ${dateStr}` };
  }
  const resolved = await resolveShortcutId(drive, dateFolderId);
  const targetId = resolved.id;

  const results = [];
  for (const fileId of fileIds) {
    try {
      const meta = await drive.files.get({
        fileId,
        fields: "id, name, parents",
        supportsAllDrives: true,
      });
      const parents = meta.data.parents || [];
      if (parents.includes(targetId)) {
        results.push({ fileId, action: "already-there" });
        continue;
      }
      await drive.files.update({
        fileId,
        addParents: targetId,
        removeParents: parents.join(",") || undefined,
        supportsAllDrives: true,
        fields: "id, parents",
      });
      console.log(`[Restore] Đã trả ${meta.data.name} về folder ${dateStr}`);
      results.push({ fileId, action: "restored", name: meta.data.name });
    } catch (err) {
      console.error(`[Restore] Lỗi khôi phục ${fileId}: ${err.message}`);
      results.push({ fileId, action: "error", error: err.message });
    }
  }

  await invalidateCachesForDate(dateStr);

  const ok = results.filter((r) => r.action === "restored" || r.action === "already-there").length;
  const firstErr = results.find((r) => r.action === "error");
  return { restored: ok, failed: results.length - ok, error: firstErr?.error || null, results };
}

/** Tìm folder "Deleted" (nằm cạnh các folder ngày). */
async function findDeletedRootFolder(drive) {
  const folders = await listDateFolders();
  const first = folders[0];
  if (!first) return null;
  const resolved = await resolveShortcutId(drive, first.id);
  const parent = await getParentFolderId(drive, resolved.id);
  const candidates = [parent, (await resolveShortcutId(drive, ROOT_FOLDER_ID)).id].filter(Boolean);
  for (const p of candidates) {
    try {
      const res = await drive.files.list({
        q: `'${p}' in parents and name = 'Deleted' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
        fields: "files(id, name)",
        pageSize: 1,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      });
      if (res.data.files?.length) return res.data.files[0].id;
    } catch (_e) {
      /* thử folder tiếp theo */
    }
  }
  return null;
}

/** Liệt kê mọi file trong 1 folder (có phân trang), tách folder con và ảnh. */
async function listFolderChildren(drive, folderId) {
  const files = [];
  const folders = [];
  let pageToken;
  do {
    const res = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields: "nextPageToken, files(id, name, mimeType, thumbnailLink, shortcutDetails)",
      pageSize: 1000,
      pageToken,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    for (const f of res.data.files || []) {
      if (f.mimeType === "application/vnd.google-apps.folder") folders.push(f);
      else if ((f.mimeType || "").startsWith("image/")) files.push(f);
      else if (f.mimeType === "application/vnd.google-apps.shortcut" && f.shortcutDetails?.targetId) {
        files.push({ ...f, id: f.shortcutDetails.targetId, isShortcut: true });
      }
    }
    pageToken = res.data.nextPageToken;
  } while (pageToken);
  return { files, folders };
}

/** Suy ra ngày từ tên file frame_YYYYMMDD_hhmmss_xxx.jpg */
function dateFromFilename(name) {
  const m = String(name).match(/(\d{4})(\d{2})(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

/**
 * Quét THẬT trên Drive những ảnh đang nằm trong khu vực đã xoá:
 * folder "Deleted" (kể cả các folder con như 2026-08-01, backupimage) và
 * folder backup cấu hình qua GOOGLE_DRIVE_BACKUP_FOLDER_ID.
 */
export async function listDeletedFolderFiles(userDrive = null) {
  const drive = userDrive || getDriveClient();
  const out = [];
  const seen = new Set();
  const roots = [];

  const deletedRoot = await findDeletedRootFolder(drive);
  if (deletedRoot) roots.push({ id: deletedRoot, name: "Deleted" });
  if (BACKUP_FOLDER_ID && BACKUP_FOLDER_ID !== deletedRoot) {
    roots.push({ id: BACKUP_FOLDER_ID, name: "backup" });
  }

  for (const root of roots) {
    let level0;
    try {
      level0 = await listFolderChildren(drive, root.id);
    } catch (err) {
      console.warn(`[Deleted] Không đọc được folder ${root.name}: ${err.message}`);
      continue;
    }

    const buckets = [{ folderName: root.name, ...level0 }];
    // Quét thêm 1 cấp folder con (Deleted/2026-08-01, Deleted/backupimage, ...)
    for (const sub of level0.folders) {
      try {
        const child = await listFolderChildren(drive, sub.id);
        buckets.push({ folderName: `${root.name}/${sub.name}`, ...child });
        // và 1 cấp nữa cho trường hợp backupimage/{ngày}
        for (const sub2 of child.folders) {
          try {
            const child2 = await listFolderChildren(drive, sub2.id);
            buckets.push({ folderName: `${root.name}/${sub.name}/${sub2.name}`, ...child2 });
          } catch (_e) { /* bỏ qua */ }
        }
      } catch (_e) { /* bỏ qua */ }
    }

    for (const b of buckets) {
      for (const f of b.files) {
        if (seen.has(f.id)) continue;
        seen.add(f.id);
        const folderLeaf = b.folderName.split("/").pop();
        const date = /^\d{4}-\d{2}-\d{2}$/.test(folderLeaf)
          ? folderLeaf
          : dateFromFilename(f.name);
        out.push({
          fileId: f.id,
          filename: f.name,
          date,
          folderName: b.folderName,
          thumbnailUrl: f.thumbnailLink ? f.thumbnailLink.replace(/=s\d+$/, "=s220") : null,
        });
      }
    }
  }

  return out;
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
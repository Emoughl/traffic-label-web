import { getSheetsClient } from "./googleAuth";

const SPREADSHEET_ID = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;

// Mỗi ngày 1 tab, ĐÚNG 1 DÒNG DUY NHẤT CHO MỖI ẢNH (khoá là filename ở cột A),
// gộp chung cả nhãn mật độ giao thông lẫn box xe — mọi thao tác (gán mật độ,
// vẽ/xoá box, xác nhận box) đều upsert vào đúng dòng của ảnh đó, không bao giờ
// tạo thêm dòng mới cho cùng 1 ảnh.
//
// Cột "boxes" gộp toàn bộ box của ảnh đó thành 1 chuỗi "x,y,w,h;x,y,w,h;...".
const HEADER = ["filename", "label_id", "label_name", "note", "file_path", "labeled_by", "box_confirmed", "boxes"];
const LAST_COL = "H"; // = HEADER.length cột, tính từ A

/** Số cột (1-indexed) -> chữ cái cột kiểu Sheets (1->A, 26->Z, 27->AA, ...). */
function colLetter(n) {
  let s = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

const sheetExistsCache = new Map();
const rowDataCache = new Map(); // {dateStr: {rows, timestamp, index}}
const metadataCache = { data: null, timestamp: 0 };
const CACHE_TTL = 10000; // 10 giây

function isCacheValid(timestamp) {
  return Date.now() - timestamp < CACHE_TTL;
}

async function getSpreadsheetMeta() {
  // Cache metadata với TTL
  if (metadataCache.data && isCacheValid(metadataCache.timestamp)) {
    return metadataCache.data;
  }
  
  const sheets = getSheetsClient();
  const result = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  metadataCache.data = result;
  metadataCache.timestamp = Date.now();
  return result;
}

async function ensureSheetExists(dateStr) {
  if (sheetExistsCache.has(dateStr)) return;

  const sheets = getSheetsClient();
  const meta = await getSpreadsheetMeta();
  const sheetObj = meta.data.sheets.find((s) => s.properties.title === dateStr);

  if (!sheetObj) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: {
        requests: [{ addSheet: { properties: { title: dateStr } } }],
      },
    });
    metadataCache.data = null;
    metadataCache.timestamp = 0;
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `'${dateStr}'!A1:${LAST_COL}1`,
      valueInputOption: "RAW",
      requestBody: { values: [HEADER] },
    });
  } else {
    // Tab đã tồn tại từ trước (có thể theo schema cũ) — luôn ép header dòng 1
    // khớp đúng HEADER hiện tại, chỉ sửa dòng 1 (tên cột), không đụng dữ liệu
    // các dòng bên dưới.
    const headerRes = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `'${dateStr}'!A1:ZZ1`,
    });
    const currentHeader = (headerRes.data.values || [[]])[0] || [];
    const matches = currentHeader.length === HEADER.length && HEADER.every((h, i) => currentHeader[i] === h);
    if (!matches) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID,
        range: `'${dateStr}'!A1:${LAST_COL}1`,
        valueInputOption: "RAW",
        requestBody: { values: [HEADER] },
      });
      // Xoá tiêu đề mồ côi còn sót lại từ schema cũ, nếu dài hơn header mới.
      if (currentHeader.length > HEADER.length) {
        await sheets.spreadsheets.values.clear({
          spreadsheetId: SPREADSHEET_ID,
          range: `'${dateStr}'!${colLetter(HEADER.length + 1)}1:${colLetter(currentHeader.length)}1`,
        });
      }
    }
  }

  sheetExistsCache.set(dateStr, true);
}

async function getAllRows(dateStr) {
  await ensureSheetExists(dateStr);
  
  // Kiểm cache
  const cached = rowDataCache.get(dateStr);
  if (cached && isCacheValid(cached.timestamp)) {
    return cached.rows;
  }
  
  const sheets = getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `'${dateStr}'!A2:${LAST_COL}`,
  });
  
  const rows = res.data.values || [];
  
  // Tạo index filename -> rowIndex để tìm kiếm O(1)
  const index = new Map();
  rows.forEach((row, idx) => {
    if (row[0]) index.set(row[0], idx);
  });
  
  // Lưu cache
  rowDataCache.set(dateStr, {
    rows,
    index,
    timestamp: Date.now(),
  });
  
  return rows;
}

function getRowIndex(dateStr, filename) {
  const cached = rowDataCache.get(dateStr);
  if (cached && cached.index.has(filename)) {
    return cached.index.get(filename);
  }
  return null;
}

async function findRow(dateStr, filename) {
  const rows = await getAllRows(dateStr);
  const index = getRowIndex(dateStr, filename);
  
  if (index !== null) {
    return { index, row: rows[index] };
  }
  return null;
}

async function appendRow(dateStr, values) {
  await ensureSheetExists(dateStr);
  const sheets = getSheetsClient();
  const range = `'${dateStr}'!A:${LAST_COL}`;
  try {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range,
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: [values] },
    });
  } catch (error) {
    if (error?.response?.status === 404) {
      sheetExistsCache.delete(dateStr);
      await ensureSheetExists(dateStr);
      await sheets.spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID,
        range,
        valueInputOption: "RAW",
        insertDataOption: "INSERT_ROWS",
        requestBody: { values: [values] },
      });
      return;
    }
    throw error;
  }
}

/** Ghi đè nguyên 1 dòng dữ liệu (dòng sheet thật = dataRowIndex + 2). */
async function updateRow(dateStr, dataRowIndex, values) {
  const sheets = getSheetsClient();
  const sheetRowNumber = dataRowIndex + 2;
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `'${dateStr}'!A${sheetRowNumber}:${LAST_COL}${sheetRowNumber}`,
    valueInputOption: "RAW",
    requestBody: { values: [values] },
  });
}

async function deleteRow(dateStr, dataRowIndex) {
  let meta = await getSpreadsheetMeta();
  let sheetObj = meta.data.sheets.find((s) => s.properties.title === dateStr);
  if (!sheetObj) {
    metadataCache.data = null;
    meta = await getSpreadsheetMeta();
    sheetObj = meta.data.sheets.find((s) => s.properties.title === dateStr);
  }
  if (!sheetObj) return;
  const sheetId = sheetObj.properties.sheetId;
  const startIndex = dataRowIndex + 1; // +1 vì data bắt đầu ở dòng sheet 2 (index 1, 0-based)
  const sheets = getSheetsClient();
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: {
      requests: [{ deleteDimension: { range: { sheetId, dimension: "ROWS", startIndex, endIndex: startIndex + 1 } } }],
    },
  });
}

// Mỗi box 1 dòng trong cùng 1 ô, có ghi rõ x=/y=/w=/h= cho dễ đọc khi mở Sheet
// (bật "Wrap text" cho cột này để thấy xuống dòng). Parser vẫn đọc được cả
// định dạng cũ "x,y,w,h;x,y,w,h" (nối bằng dấu ;, không có nhãn) để tương
// thích ngược với dữ liệu đã ghi từ trước.
function parseBoxesCell(cell) {
  if (!cell) return [];
  
  const lines = cell.split(/[\n;]+/);
  const boxes = [];
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    
    const nums = line.match(/-?\d+(\.\d+)?/g);
    if (nums && nums.length >= 4) {
      const box = [Number(nums[0]), Number(nums[1]), Number(nums[2]), Number(nums[3])];
      // Kiểm tra all numbers valid
      if (box.every(n => !Number.isNaN(n))) {
        boxes.push(box);
      }
    }
  }
  
  return boxes;
}

function serializeBoxes(boxes) {
  if (!boxes || boxes.length === 0) return "";
  
  // Tránh tạo array trung gian
  let result = "";
  for (let i = 0; i < boxes.length; i++) {
    const [x, y, w, h] = boxes[i];
    if (i > 0) result += "\n";
    result += `x=${x}, y=${y}, w=${w}, h=${h}`;
  }
  return result;
}

function isRowEmpty(row) {
  const hasLabel = !!row[2];
  const hasBoxes = !!row[7];
  const isConfirmed = String(row[6]).toUpperCase() === "TRUE";
  return !hasLabel && !hasBoxes && !isConfirmed;
}

/** Upsert đúng 1 dòng của 1 ảnh — chỉ ghi đè các trường có mặt trong `patch`,
 * giữ nguyên các trường còn lại nếu dòng đã tồn tại. Nếu sau khi patch dòng
 * không còn dữ liệu gì (undo hết nhãn, không có box) thì xoá hẳn dòng đó. */
async function upsertRow(dateStr, filename, fileId, patch, labeledBy) {
  const existing = await findRow(dateStr, filename);
  const filePath = fileId ? `https://drive.google.com/file/d/${fileId}/view` : existing?.row[4] || "";

  const labelId = "labelId" in patch ? patch.labelId : existing?.row[1] ?? "";
  const labelName = "labelName" in patch ? patch.labelName : existing?.row[2] ?? "";
  const note = "note" in patch ? patch.note : existing?.row[3] ?? "";
  const boxes = "boxes" in patch ? patch.boxes : parseBoxesCell(existing?.row[7]);
  const confirmed = "confirmed" in patch ? patch.confirmed : String(existing?.row[6]).toUpperCase() === "TRUE";
  const finalLabeledBy = labeledBy || existing?.row[5] || "";

  const values = [
    filename,
    labelId ?? "",
    labelName ?? "",
    note ?? "",
    filePath,
    finalLabeledBy,
    confirmed ? "TRUE" : "FALSE",
    serializeBoxes(boxes),
  ];

  if (isRowEmpty(values)) {
    if (existing) await deleteRow(dateStr, existing.index);
    // Clear cache khi delete
    rowDataCache.delete(dateStr);
    return;
  }

  if (existing) {
    await updateRow(dateStr, existing.index, values);
  } else {
    await appendRow(dateStr, values);
  }
  
  // Clear cache khi modify data
  rowDataCache.delete(dateStr);
}

// ---------------- Nhãn mật độ giao thông (density label) ----------------

export async function getLabeledFilenames(dateStr) {
  const rows = await getAllRows(dateStr);
  const filenames = rows
    .filter((r) => r[2] && r[2] !== "DELETED" && r[1] !== "-1")
    .map((r) => r[0])
    .filter(Boolean);
  return new Set(filenames);
}

export async function getDeletedFilenames(dateStr) {
  const rows = await getAllRows(dateStr);
  const deleted = new Set();
  for (const r of rows) {
    if (r[0] && (r[1] === "-1" || r[2] === "DELETED" || r[3] === "DELETED")) {
      deleted.add(r[0]);
    }
  }
  return deleted;
}

export async function markImageAsDeleted(dateStr, filename, fileId, labeledBy) {
  await upsertRow(
    dateStr,
    filename,
    fileId,
    { labelId: "-1", labelName: "DELETED", note: "DELETED" },
    labeledBy
  );
}

export async function setDensityLabel(dateStr, filename, fileId, labelId, labelName, note, labeledBy) {
  await upsertRow(dateStr, filename, fileId, { labelId, labelName, note }, labeledBy);
}

export async function clearDensityLabel(dateStr, filenames) {
  for (const filename of filenames) {
    await upsertRow(dateStr, filename, null, { labelId: "", labelName: "", note: "" }, null);
  }
  // Clear cache sau khi update
  rowDataCache.delete(dateStr);
}

// ---------------- Box xe (vehicle box) ----------------

/** Trả {filename: [[x, y, w, h], ...]} cho mọi ảnh có box. */
export async function getVehicleBoxes(dateStr) {
  const rows = await getAllRows(dateStr);
  const boxes = {};
  for (const r of rows) {
    if (!r[0]) continue;
    const list = parseBoxesCell(r[7]);
    if (list.length > 0) boxes[r[0]] = list;
  }
  return boxes;
}

/** Trả Set các filename hiện đang ở trạng thái "đã Xác nhận" (khoá) box. */
export async function getBoxConfirmedFilenames(dateStr) {
  const rows = await getAllRows(dateStr);
  const confirmed = new Set();
  for (const r of rows) {
    if (r[0] && String(r[6]).toUpperCase() === "TRUE") confirmed.add(r[0]);
  }
  return confirmed;
}

/** Thay toàn bộ box hiện có của 1 ảnh bằng danh sách `boxes` mới (mỗi box = [x,y,w,h]). */
export async function saveVehicleBoxes(dateStr, filename, fileId, boxes, labeledBy) {
  await upsertRow(dateStr, filename, fileId, { boxes }, labeledBy);
}

/** Cập nhật trạng thái Xác nhận (confirmed=true, khoá) / Đánh label lại (confirmed=false). */
export async function setBoxConfirmed(dateStr, filename, fileId, labeledBy, confirmed) {
  await upsertRow(dateStr, filename, fileId, { confirmed }, labeledBy);
}

// ============= CACHE MANAGEMENT (tối ưu performance) =============

/** Xoá cache dữ liệu cho một ngày cụ thể */
export function clearDateCache(dateStr) {
  rowDataCache.delete(dateStr);
}

/** Xoá toàn bộ cache */
export function clearAllCache() {
  rowDataCache.clear();
  metadataCache.data = null;
  metadataCache.timestamp = 0;
}

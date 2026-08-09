import { getSheetsClient } from "./googleAuth";

const SPREADSHEET_ID = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;

const HEADER = [
  "filename",
  "label_id",
  "label_name",
  "note",
  "file_path",
  "labeled_by",
];

const sheetExistsCache = new Map();

async function getSpreadsheetMeta() {
  const sheets = getSheetsClient();
  return sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
}

async function ensureSheetExists(dateStr) {
  if (sheetExistsCache.has(dateStr)) return;

  const sheets = getSheetsClient();
  const meta = await getSpreadsheetMeta();
  const exists = meta.data.sheets.some((s) => s.properties.title === dateStr);
  if (!exists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: {
        requests: [{ addSheet: { properties: { title: dateStr } } }],
      },
    });
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `'${dateStr}'!A1:F1`,
      valueInputOption: "RAW",
      requestBody: { values: [HEADER] },
    });
  }

  sheetExistsCache.set(dateStr, true);
}

export async function getLabeledFilenames(dateStr) {
  await ensureSheetExists(dateStr);
  const sheets = getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `'${dateStr}'!A2:A`,
  });
  const rows = res.data.values || [];
  return new Set(rows.map((r) => r[0]).filter(Boolean));
}

export async function appendLabelRows(dateStr, rows) {
  await ensureSheetExists(dateStr);
  const sheets = getSheetsClient();
  try {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: `'${dateStr}'!A:F`,
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: rows },
    });
  } catch (error) {
    if (error?.response?.status === 404) {
      sheetExistsCache.delete(dateStr);
      await ensureSheetExists(dateStr);
      await sheets.spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID,
        range: `'${dateStr}'!A:F`,
        valueInputOption: "RAW",
        insertDataOption: "INSERT_ROWS",
        requestBody: { values: rows },
      });
      return;
    }
    throw error;
  }
}

export async function removeLabelRows(dateStr, filenames) {
  const sheets = getSheetsClient();
  const filenameSet = new Set(filenames);

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `'${dateStr}'!A2:A`,
  });
  const rows = res.data.values || [];

  const rowIndexesToDelete = [];
  rows.forEach((r, i) => {
    if (filenameSet.has(r[0])) {
      rowIndexesToDelete.push(i + 1);
    }
  });
  if (rowIndexesToDelete.length === 0) return;

  const meta = await getSpreadsheetMeta();
  const sheetObj = meta.data.sheets.find((s) => s.properties.title === dateStr);
  if (!sheetObj) return;
  const sheetId = sheetObj.properties.sheetId;

  rowIndexesToDelete.sort((a, b) => b - a);
  const requests = rowIndexesToDelete.map((idx) => ({
    deleteDimension: {
      range: {
        sheetId,
        dimension: "ROWS",
        startIndex: idx,
        endIndex: idx + 1,
      },
    },
  }));

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: { requests },
  });
}
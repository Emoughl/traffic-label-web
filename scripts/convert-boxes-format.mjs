#!/usr/bin/env node
/**
 * Convert cột "boxes" trong Google Sheets sang định dạng mới dùng dấu ;
 *
 *   Cũ:  x=231, y=167, w=41, h=55      (hoặc "10,20,30,40;50,60,70,80")
 *   Mới: x=231; y=167; w=41; h=55      (mỗi box 1 dòng)
 *
 * Cách chạy (đứng ở thư mục gốc project):
 *
 *   node --env-file=.env.local scripts/convert-boxes-format.mjs            # xem trước, KHÔNG ghi
 *   node --env-file=.env.local scripts/convert-boxes-format.mjs --apply    # ghi thật
 *
 * Tuỳ chọn:
 *   --apply              Ghi thật vào Sheet (mặc định chỉ chạy thử, in ra thay đổi).
 *   --sheet=2026-08-03   Chỉ xử lý 1 tab. Lặp lại cờ này để chọn nhiều tab.
 *   --limit=20           Chỉ in tối đa N dòng ví dụ cho mỗi tab (mặc định 5).
 */

import { google } from "googleapis";

// ---------------------------------------------------------------- args
const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const ONLY_SHEETS = args
  .filter((a) => a.startsWith("--sheet="))
  .map((a) => a.slice("--sheet=".length).trim())
  .filter(Boolean);
const PREVIEW_LIMIT = Number(
  (args.find((a) => a.startsWith("--limit=")) || "--limit=5").split("=")[1]
);

const SPREADSHEET_ID = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
if (!SPREADSHEET_ID) {
  console.error(
    "Thiếu GOOGLE_SHEETS_SPREADSHEET_ID.\n" +
      "Chạy kèm file env, ví dụ:\n" +
      "  node --env-file=.env.local scripts/convert-boxes-format.mjs"
  );
  process.exit(1);
}

// ---------------------------------------------------------------- auth
function getSheetsClient() {
  const privateKey = (process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY || "").replace(/\\n/g, "\n");
  const auth = new google.auth.JWT({
    email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key: privateKey,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  return google.sheets({ version: "v4", auth });
}

// ------------------------------------------------- parse / serialize
// Giữ nguyên logic của lib/sheets.js để chuyển đổi không làm lệch dữ liệu.
function parseBoxesCell(cell) {
  if (!cell) return [];
  const boxes = [];

  function pushBox(nums) {
    if (!nums || nums.length < 4) return;
    const box = [Number(nums[0]), Number(nums[1]), Number(nums[2]), Number(nums[3])];
    if (box.every((n) => !Number.isNaN(n))) boxes.push(box);
  }

  for (const raw of cell.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.includes("=")) {
      pushBox(line.match(/-?\d+(\.\d+)?/g));
    } else {
      for (const chunk of line.split(";")) {
        if (!chunk.trim()) continue;
        pushBox(chunk.match(/-?\d+(\.\d+)?/g));
      }
    }
  }
  return boxes;
}

function serializeBoxes(boxes) {
  if (!boxes || boxes.length === 0) return "";
  return boxes.map(([x, y, w, h]) => `x=${x}; y=${y}; w=${w}; h=${h}`).join("\n");
}

function colLetter(n) {
  let s = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

// ---------------------------------------------------------------- main
async function main() {
  const sheets = getSheetsClient();

  const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  let titles = meta.data.sheets.map((s) => s.properties.title);

  if (ONLY_SHEETS.length > 0) {
    const missing = ONLY_SHEETS.filter((t) => !titles.includes(t));
    if (missing.length) {
      console.error(`Không tìm thấy tab: ${missing.join(", ")}`);
      process.exit(1);
    }
    titles = ONLY_SHEETS;
  }

  console.log(
    `${APPLY ? "GHI THẬT" : "CHẠY THỬ (chưa ghi gì)"} — ${titles.length} tab: ${titles.join(", ")}\n`
  );

  let grandTotal = 0;

  for (const title of titles) {
    // Tìm cột "boxes" theo header, fallback về cột H nếu không thấy
    const headerRes = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `'${title}'!A1:ZZ1`,
    });
    const header = (headerRes.data.values || [[]])[0] || [];
    let boxesCol = header.findIndex((h) => String(h).trim().toLowerCase() === "boxes");
    if (boxesCol === -1) boxesCol = 7; // cột H theo schema hiện tại
    const letter = colLetter(boxesCol + 1);

    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `'${title}'!${letter}2:${letter}`,
    });
    const rows = res.data.values || [];

    const updates = [];
    const samples = [];

    for (let i = 0; i < rows.length; i++) {
      const cell = (rows[i] || [])[0] || "";
      if (!cell.trim()) continue;

      const boxes = parseBoxesCell(cell);
      const next = serializeBoxes(boxes);
      if (next === cell) continue; // đã đúng định dạng

      if (boxes.length === 0) {
        console.warn(`  ! ${title} dòng ${i + 2}: không đọc được box nào, BỎ QUA -> ${JSON.stringify(cell)}`);
        continue;
      }

      const rowNumber = i + 2;
      updates.push({ range: `'${title}'!${letter}${rowNumber}`, values: [[next]] });
      if (samples.length < PREVIEW_LIMIT) samples.push({ rowNumber, cell, next });
    }

    console.log(`[${title}] cột ${letter} — ${rows.length} dòng có dữ liệu, ${updates.length} dòng cần đổi`);
    for (const s of samples) {
      console.log(`   dòng ${s.rowNumber}:`);
      console.log(`     cũ : ${s.cell.split("\n")[0]}${s.cell.includes("\n") ? " …" : ""}`);
      console.log(`     mới: ${s.next.split("\n")[0]}${s.next.includes("\n") ? " …" : ""}`);
    }
    if (updates.length > samples.length) {
      console.log(`   … và ${updates.length - samples.length} dòng nữa`);
    }

    grandTotal += updates.length;

    if (APPLY && updates.length > 0) {
      // Ghi theo lô 500 ô/lần để không vượt giới hạn request
      const CHUNK = 500;
      for (let i = 0; i < updates.length; i += CHUNK) {
        const chunk = updates.slice(i, i + CHUNK);
        await sheets.spreadsheets.values.batchUpdate({
          spreadsheetId: SPREADSHEET_ID,
          requestBody: { valueInputOption: "RAW", data: chunk },
        });
        console.log(`   đã ghi ${Math.min(i + CHUNK, updates.length)}/${updates.length}`);
      }
    }
    console.log("");
  }

  if (APPLY) {
    console.log(`Xong. Đã cập nhật ${grandTotal} ô.`);
  } else {
    console.log(
      `Chạy thử xong: ${grandTotal} ô sẽ được đổi.\n` +
        `Chạy lại kèm --apply để ghi thật:\n` +
        `  node --env-file=.env.local scripts/convert-boxes-format.mjs --apply`
    );
  }
}

main().catch((err) => {
  console.error("Lỗi:", err?.message || err);
  process.exit(1);
});

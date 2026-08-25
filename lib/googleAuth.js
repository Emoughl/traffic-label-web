import { google } from "googleapis";

let authClient;
export function getServiceAccountAuth() {
  if (!authClient) {
    const privateKey = (process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY || "").replace(
      /\\n/g,
      "\n"
    );
    authClient = new google.auth.JWT({
      email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      key: privateKey,
      scopes: [
        "https://www.googleapis.com/auth/drive",
        "https://www.googleapis.com/auth/spreadsheets",
      ],
    });
  }
  return authClient;
}

export function getDriveClient() {
  return google.drive({ version: "v3", auth: getServiceAccountAuth() });
}

export function getSheetsClient() {
  return google.sheets({ version: "v4", auth: getServiceAccountAuth() });
}

/**
 * Drive client chạy dưới danh nghĩa NGƯỜI ĐĂNG NHẬP (OAuth access token),
 * dùng cho những thao tác ghi mà service account không đủ quyền (di chuyển ảnh).
 */
export function getDriveClientForUser(accessToken) {
  if (!accessToken) return null;
  const auth = new google.auth.OAuth2();
  auth.setCredentials({ access_token: accessToken });
  return google.drive({ version: "v3", auth });
}

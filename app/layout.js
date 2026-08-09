import "./globals.css";
import SessionProviderWrapper from "./SessionProviderWrapper";

export const metadata = {
  title: "Traffic Image Labeling Tool",
};

export default function RootLayout({ children }) {
  return (
    <html lang="vi">
      <body>
        <SessionProviderWrapper>{children}</SessionProviderWrapper>
      </body>
    </html>
  );
}

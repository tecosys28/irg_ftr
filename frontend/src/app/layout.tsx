import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'IRG FTR',
  description: 'IRG Future Token Registry',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

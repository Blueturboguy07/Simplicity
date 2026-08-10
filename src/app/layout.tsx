export const dynamic = 'force-dynamic';

import type { Metadata } from 'next';
import { Montserrat, Instrument_Serif } from 'next/font/google';
import './globals.css';
import { cn } from '@/lib/utils';
import Sidebar from '@/components/Sidebar';
import { Toaster } from 'sonner';
import ThemeProvider from '@/components/theme/Provider';
import configManager from '@/lib/config';
import SetupWizard from '@/components/Setup/SetupWizard';
import { ChatProvider } from '@/lib/hooks/useChat';

const montserrat = Montserrat({
  weight: ['300', '400', '500', '700'],
  subsets: ['latin'],
  display: 'swap',
  fallback: ['Arial', 'sans-serif'],
});

// Editorial serif used selectively (home heading, answer h1/h2) via the
// `font-serif` utility -- body text stays on Montserrat.
const instrumentSerif = Instrument_Serif({
  weight: '400',
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-instrument-serif',
  fallback: ['Georgia', 'serif'],
});

export const metadata: Metadata = {
  title: 'Simplicity - Direct your curiosity',
  description: 'Simplicity is an AI powered answering engine.',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const setupComplete = configManager.isSetupComplete();
  const configSections = configManager.getUIConfigSections();

  return (
    <html className="h-full" lang="en" suppressHydrationWarning>
      <body
        className={cn(
          'h-full antialiased',
          montserrat.className,
          instrumentSerif.variable,
        )}
      >
        <ThemeProvider>
          {setupComplete ? (
            <ChatProvider>
              <Sidebar>{children}</Sidebar>
            </ChatProvider>
          ) : (
            <SetupWizard configSections={configSections} />
          )}
          {/* Rendered unconditionally: onboarding (setupComplete === false)
              calls toast.error/toast.success too (see ProviderPicker's
              provider-connect flows), and with no <Toaster/> mounted those
              calls silently no-op — a failure looks identical to nothing
              happening at all. See the Ollama install bug this fixed. */}
          <Toaster
            toastOptions={{
              unstyled: true,
              classNames: {
                toast:
                  'bg-light-secondary dark:bg-dark-secondary dark:text-white/70 text-black-70 rounded-lg p-4 flex flex-row items-center space-x-2',
              },
            }}
          />
        </ThemeProvider>
      </body>
    </html>
  );
}

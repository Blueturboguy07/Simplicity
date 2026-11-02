import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { uploadAccept, uploadMenuLabel } from '@/lib/uploads/accepted';

/* The three attach entry points render the one accept list, and the "+"
   menu row says what that list accepts. v0.1.3 said "Upload files or
   images" over accept=".pdf,.docx,.txt". */

/* Headless UI's Popover is closed on the server; force it open so the menu
   rows render into the markup. */
vi.mock('@headlessui/react', () => ({
  Popover: ({ children }: any) => (
    <div>
      {typeof children === 'function'
        ? children({ open: true, close: () => {} })
        : children}
    </div>
  ),
  PopoverButton: ({ children }: any) => <button>{children}</button>,
  PopoverPanel: ({ children }: any) => <div>{children}</div>,
  Switch: ({ children }: any) => <button>{children}</button>,
}));

const noop = () => {};

vi.mock('@/lib/hooks/useChat', () => ({
  useChat: () => ({
    files: [],
    setFiles: noop,
    fileIds: [],
    setFileIds: noop,
    sources: [],
    setSources: noop,
  }),
}));

vi.mock('../Settings/SettingsDialogue', () => ({ default: () => null }));

import PlusMenu from './PlusMenu';
import Attach from './Attach';
import AttachSmall from './AttachSmall';

describe('the "+" menu', () => {
  const html = renderToStaticMarkup(<PlusMenu />);

  it('filters the file dialog to the accepted list', () => {
    expect(html).toContain(`accept="${uploadAccept}"`);
    expect(html).toContain('accept=".pdf,.docx,.txt"');
  });

  it('says what is accepted and does not promise images', () => {
    expect(html).toContain(uploadMenuLabel);
    expect(html).toContain('Upload a PDF, DOCX or TXT');
    expect(html).not.toContain('Upload files or images');
  });
});

describe('Attach and AttachSmall', () => {
  it('filter the file dialog to the same accepted list', () => {
    expect(renderToStaticMarkup(<Attach />)).toContain(
      `accept="${uploadAccept}"`,
    );
    expect(renderToStaticMarkup(<AttachSmall />)).toContain(
      `accept="${uploadAccept}"`,
    );
  });
});

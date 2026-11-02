/* The one list of what /api/uploads can read. The "+" menu label, the hidden
   <input accept>, the client-side check and the server-side check all derive
   from it, so the menu can never again promise a type the server rejects:
   v0.1.3 said "Upload files or images" while the server threw
   `File type image/png not supported` and the toast said "An error has
   occurred." (bug_reports ba38da9b, harifhashimi 2026-10-21).

   No fs, no node imports: the client bundle imports this file too. */

export const acceptedUploads = [
  { ext: 'pdf', mime: 'application/pdf', label: 'PDF' },
  {
    ext: 'docx',
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    label: 'DOCX',
  },
  { ext: 'txt', mime: 'text/plain', label: 'TXT' },
] as const;

export type AcceptedUpload = (typeof acceptedUploads)[number];
export type AcceptedMime = AcceptedUpload['mime'];

/* "PDF, DOCX or TXT" */
const labels: string[] = acceptedUploads.map((t) => t.label);
export const acceptedUploadNames = `${labels.slice(0, -1).join(', ')} or ${labels[labels.length - 1]}`;

/* ".pdf,.docx,.txt" — the OS file dialog filter. */
export const uploadAccept = acceptedUploads.map((t) => `.${t.ext}`).join(',');

/* The "+" menu row. Says what is accepted, nothing more. */
export const uploadMenuLabel = `Upload a ${acceptedUploadNames}`;

type UploadLike = { name: string; type: string };

const extensionOf = (name: string) => {
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot + 1).toLowerCase();
};

/* Extension first: Windows sends '' or application/octet-stream for a type
   it has no registry entry for. Then the MIME type the browser sent. A file
   that matches neither is not readable here. */
export const resolveUploadType = (file: UploadLike): AcceptedUpload | null =>
  acceptedUploads.find((t) => t.ext === extensionOf(file.name)) ??
  acceptedUploads.find((t) => file.type !== '' && t.mime === file.type) ??
  null;

const imageExtensions = [
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'heic',
  'heif',
  'bmp',
  'svg',
  'tif',
  'tiff',
  'avif',
];

const isImage = (file: UploadLike) =>
  file.type.startsWith('image/') ||
  imageExtensions.includes(extensionOf(file.name));

/* Names the file and says what to send instead. Shown as the toast and
   returned as the HTTP 415 body. */
export const unsupportedUploadMessage = (file: UploadLike) =>
  isImage(file)
    ? `${file.name}: images are not supported yet. Upload a ${acceptedUploadNames}.`
    : `${file.name} is not supported. Upload a ${acceptedUploadNames}.`;

/* The message for the first file that cannot be read, or null when every
   file can. Runs on the client before any byte is sent, and on the server
   before any byte is written. */
export const rejectUnsupportedUpload = (files: UploadLike[]): string | null => {
  for (const file of files) {
    if (!resolveUploadType(file)) {
      return unsupportedUploadMessage(file);
    }
  }
  return null;
};

export class UnsupportedUploadError extends Error {
  readonly status = 415;

  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedUploadError';
  }
}

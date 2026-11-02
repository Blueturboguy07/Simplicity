import { describe, expect, it } from 'vitest';
import {
  acceptedUploads,
  rejectUnsupportedUpload,
  resolveUploadType,
  unsupportedUploadMessage,
  UnsupportedUploadError,
  uploadAccept,
  uploadMenuLabel,
} from './accepted';

/* v0.1.3 shipped a "+" menu that said "Upload files or images" over an
   <input accept=".pdf,.docx,.txt"> and a server that threw on image/png.
   Everything the user sees now derives from one list, and this file pins
   the three derived strings to each other. */

describe('one list drives the dialog filter and the menu label', () => {
  it('the dialog filter lists every accepted extension and nothing else', () => {
    expect(uploadAccept).toBe('.pdf,.docx,.txt');
    expect(uploadAccept.split(',')).toEqual(
      acceptedUploads.map((t) => `.${t.ext}`),
    );
  });

  it('the menu label names every accepted type and does not promise images', () => {
    expect(uploadMenuLabel).toBe('Upload a PDF, DOCX or TXT');
    for (const t of acceptedUploads) {
      expect(uploadMenuLabel).toContain(t.label);
    }
    expect(uploadMenuLabel.toLowerCase()).not.toContain('image');
  });
});

describe('resolveUploadType', () => {
  it('reads the three accepted types by extension, whatever the OS says', () => {
    expect(resolveUploadType({ name: 'notes.txt', type: 'text/plain' })?.ext).toBe('txt');
    expect(resolveUploadType({ name: 'notes.pdf', type: 'application/pdf' })?.ext).toBe('pdf');
    /* Windows with no Office: '' or application/octet-stream for .docx */
    expect(resolveUploadType({ name: 'report.docx', type: '' })?.ext).toBe('docx');
    expect(
      resolveUploadType({ name: 'report.docx', type: 'application/octet-stream' })?.ext,
    ).toBe('docx');
    expect(resolveUploadType({ name: 'NOTES.TXT', type: '' })?.ext).toBe('txt');
  });

  it('falls back to the MIME type for an unusual extension', () => {
    expect(resolveUploadType({ name: 'notes.text', type: 'text/plain' })?.mime).toBe(
      'text/plain',
    );
  });

  it('rejects images and every other type', () => {
    expect(resolveUploadType({ name: 'pic.png', type: 'image/png' })).toBeNull();
    expect(resolveUploadType({ name: 'photo.jpg', type: '' })).toBeNull();
    expect(resolveUploadType({ name: 'data.csv', type: 'text/csv' })).toBeNull();
    expect(resolveUploadType({ name: 'README', type: '' })).toBeNull();
    expect(resolveUploadType({ name: 'blob', type: 'application/octet-stream' })).toBeNull();
  });
});

describe('rejectUnsupportedUpload — the toast and the 415 body', () => {
  it('says images are not supported yet, names the file and the accepted types', () => {
    expect(rejectUnsupportedUpload([{ name: 'pic.png', type: 'image/png' }])).toBe(
      'pic.png: images are not supported yet. Upload a PDF, DOCX or TXT.',
    );
    /* by extension when the OS sent no type */
    expect(unsupportedUploadMessage({ name: 'shot.JPG', type: '' })).toBe(
      'shot.JPG: images are not supported yet. Upload a PDF, DOCX or TXT.',
    );
  });

  it('names a non-image file that cannot be read', () => {
    expect(rejectUnsupportedUpload([{ name: 'data.csv', type: 'text/csv' }])).toBe(
      'data.csv is not supported. Upload a PDF, DOCX or TXT.',
    );
  });

  it('returns null when every file can be read, and the first bad file otherwise', () => {
    expect(
      rejectUnsupportedUpload([
        { name: 'notes.txt', type: 'text/plain' },
        { name: 'notes.pdf', type: 'application/pdf' },
      ]),
    ).toBeNull();
    expect(
      rejectUnsupportedUpload([
        { name: 'notes.txt', type: 'text/plain' },
        { name: 'pic.png', type: 'image/png' },
        { name: 'data.csv', type: 'text/csv' },
      ]),
    ).toBe('pic.png: images are not supported yet. Upload a PDF, DOCX or TXT.');
  });

  it('UnsupportedUploadError carries 415', () => {
    const err = new UnsupportedUploadError('x');
    expect(err).toBeInstanceOf(Error);
    expect(err.status).toBe(415);
    expect(err.name).toBe('UnsupportedUploadError');
  });
});
